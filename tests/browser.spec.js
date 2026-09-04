'use strict';

const { test: base, expect } = require('@playwright/test');
const jsQR = require('jsqr');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// These tests load the production application under its deployed CSP. Clipboard
// promises are controlled without reading or changing the user's OS clipboard.
const test = base.extend({
    page: async ({ page }, use) => {
        const errors = [];
        const externalRequests = [];
        const allowedHosts = new Set(['127.0.0.1:4173', 'vault-test.invalid']);
        const isExternal = (url) => {
            const target = new URL(url);
            return /^https?:$/.test(target.protocol) && !allowedHosts.has(target.host);
        };
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (isExternal(request.url())) externalRequests.push(request.url());
        });
        await page.route(/^https?:\/\//, (route) => (
            isExternal(route.request().url()) ? route.abort() : route.continue()
        ));
        await use(page);
        expect(errors, 'The application must not throw uncaught browser errors').toEqual([]);
        expect(externalRequests, 'No application operation may contact an external host').toEqual([]);
    },
});

async function installClipboard(page, deferred = false) {
    await page.addInitScript(({ deferred }) => {
        window.__vaultTestCopies = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText(value) {
                    return new Promise((resolve, reject) => {
                        window.__vaultTestCopies.push({ value, resolve, reject });
                        if (!deferred) resolve();
                    });
                },
            },
        });
    }, { deferred });
}

async function pattern(page, value) {
    await page.locator('#tab-pattern').click();
    await page.locator('#pattern-input').fill(value);
    await expect(page.locator('#generation-error')).toBeHidden();
}

async function openBulk(page, count) {
    await page.locator('.export-panel > summary').click();
    await page.locator('#bulk-count').fill(String(count));
    await page.locator('#bulk-count').blur();
}

async function downloadText(download) {
    expect(await download.failure()).toBeNull();
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

test('serves hardened headers and generates each mode', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    await expect(page.locator('#result')).toHaveText(/.{24}/);
    for (const mode of ['pass', 'user', 'pattern', 'pwd']) {
        await page.locator(`#tab-${mode}`).click();
        await expect(page.locator(`#tab-${mode}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#result')).not.toBeEmpty();
    }
});

test('tab keyboard navigation updates selection and active panel', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-pwd').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-pass')).toBeFocused();
    await expect(page.locator('#pass-options')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.locator('#tab-pattern')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('#tab-pwd')).toBeFocused();
});

test('invalid pattern removes the old result and disables transfer controls', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-pattern').click();
    await page.locator('#pattern-input').fill('[A-Z');
    await expect(page.locator('#generation-error')).toBeVisible();
    await expect(page.locator('#pattern-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#result')).toBeEmpty();
    await expect(page.locator('#copy-btn')).toBeDisabled();
    await expect(page.locator('#qr-btn')).toBeDisabled();
    await page.locator('#pattern-input').fill('[A-Z]{3}-[0-9]{4}');
    await expect(page.locator('#result')).toHaveText(/^[A-Z]{3}-\d{4}$/);
    await expect(page.locator('#generation-error')).toBeHidden();
});

test('Paranoid hides plaintext from both DOM and accessible output until reveal', async ({ page }) => {
    await page.goto('/');
    const secret = await page.locator('#result').textContent();
    await page.locator('#opt-paranoid').check();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    await expect(page.locator('#result')).toHaveAttribute('aria-live', 'off');
    expect(await page.locator('body').textContent()).not.toContain(secret);
    expect(await page.locator('body').ariaSnapshot()).not.toContain(secret);
    await page.locator('#paranoid-overlay').click();
    await expect(page.locator('#result')).toHaveText(secret);
    await page.locator('#paranoid-overlay').click();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    await openBulk(page, 2);
    for (const id of ['export-txt-btn', 'export-csv-btn', 'export-json-btn']) {
        await expect(page.locator(`#${id}`)).toBeDisabled();
    }
});

test('Paranoid URL boot and reload never write preferences or render plaintext', async ({ page }) => {
    await page.addInitScript(() => {
        window.__vaultStorageWrites = [];
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            window.__vaultStorageWrites.push(key);
            return setItem.call(this, key, value);
        };
    });
    await page.goto('/#paranoid');
    await expect(page.locator('#opt-paranoid')).toBeChecked();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    await page.locator('#generate-btn').click();
    await page.reload();
    await expect(page.locator('#opt-paranoid')).toBeChecked();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    expect(await page.evaluate(() => window.__vaultStorageWrites)).toEqual([]);
});

test('enabling Paranoid removes only application preferences and persists through reload', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('unrelated-app', 'keep-me'));
    await page.goto('/');
    await page.locator('#length-num').fill('32');
    await page.locator('#length-num').blur();
    await page.locator('#opt-paranoid').check();
    expect(await page.evaluate(() => localStorage.getItem('unrelated-app'))).toBe('keep-me');
    expect(await page.evaluate(() => localStorage.getItem('vault_settings'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('vault_theme'))).toBeNull();
    await expect(page).toHaveURL(/#.*paranoid/);
    await page.reload();
    await expect(page.locator('#opt-paranoid')).toBeChecked();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
});

for (const eventName of ['blur', 'pagehide']) {
    test(`Paranoid clears result and QR on window ${eventName}`, async ({ page }) => {
        await page.goto('/#paranoid');
        await page.locator('#qr-btn').click();
        await expect(page.locator('#qr-modal')).toBeVisible();
        // Dispatch the lifecycle event directly so this regression is reliable
        // in headless browsers, where operating-system focus is not controllable.
        await page.evaluate((name) => window.dispatchEvent(new Event(name)), eventName);
        await expect(page.locator('#result')).toBeEmpty();
        await expect(page.locator('#qr-modal')).not.toBeVisible();
        await expect(page.locator('#qr-container')).toBeEmpty();
        await expect(page.locator('#copy-btn')).toBeDisabled();
    });
}

test('Paranoid clears on hidden-document visibilitychange', async ({ page }) => {
    await page.goto('/#paranoid');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#result')).toBeEmpty();
    await expect(page.locator('#copy-btn')).toBeDisabled();
});

test('Clear now removes displayed credential, QR and copy countdown', async ({ page }) => {
    await installClipboard(page);
    await page.goto('/');
    await page.locator('#copy-btn').click();
    await expect(page.locator('#clear-countdown')).toContainText('Clears in');
    await page.locator('#clear-btn').click();
    await expect(page.locator('#result')).toBeEmpty();
    await expect(page.locator('#clear-countdown')).toBeEmpty();
    await expect(page.locator('#copy-btn')).toBeDisabled();
    await expect(page.locator('#qr-container')).toBeEmpty();
});

test('copy timer expires at its displayed deadline', async ({ page }) => {
    await installClipboard(page);
    await page.clock.install();
    await page.goto('/');
    await page.locator('#clear-time').selectOption('30000');
    await page.locator('#copy-btn').click();
    await expect(page.locator('#clear-countdown')).toContainText('Clears in');
    await page.clock.fastForward(29000);
    await expect(page.locator('#result')).not.toBeEmpty();
    await page.clock.fastForward(1100);
    await expect(page.locator('#result')).toBeEmpty();
    await expect(page.locator('#clear-countdown')).toBeEmpty();
});

test('out-of-order clipboard completion cannot cancel the newer clear timer', async ({ page }) => {
    await installClipboard(page, true);
    await page.clock.install();
    await page.goto('/');
    await page.locator('#clear-time').selectOption('30000');
    await pattern(page, 'COPY-A');
    await page.locator('#copy-btn').click();
    await page.locator('#pattern-input').fill('COPY-B');
    await page.locator('#copy-btn').click();
    expect(await page.evaluate(() => window.__vaultTestCopies.map(({ value }) => value))).toEqual(['COPY-A', 'COPY-B']);
    await page.evaluate(() => window.__vaultTestCopies[1].resolve());
    await expect(page.locator('#clear-countdown')).toContainText('Clears in');
    await page.evaluate(() => window.__vaultTestCopies[0].resolve());
    await page.clock.fastForward(30100);
    await expect(page.locator('#result')).toBeEmpty();
});

test('old clipboard completion is ignored even when a new generation has identical text', async ({ page }) => {
    await installClipboard(page, true);
    await page.clock.install();
    await page.goto('/');
    await pattern(page, 'SAME-VALUE');
    await page.locator('#copy-btn').click();
    await page.locator('#generate-btn').click();
    await page.evaluate(() => window.__vaultTestCopies[0].resolve());
    await expect(page.locator('#clear-countdown')).toBeEmpty();
    await expect(page.locator('#copy-btn')).toHaveText('Copy');
    await page.clock.fastForward(61000);
    await expect(page.locator('#result')).toHaveText('SAME-VALUE');
});

test('blocked preference storage still allows generation and copying', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { throw new DOMException('Blocked for test', 'SecurityError'); },
        });
    });
    await installClipboard(page);
    await page.goto('/');
    await expect(page.locator('#result')).not.toBeEmpty();
    await page.locator('#tab-pass').click();
    await page.locator('#copy-btn').click();
    await expect(page.locator('#copy-btn')).toHaveText('Copied');
    await page.locator('#opt-paranoid').check();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
});

test('malformed stored settings recover to a usable application', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vault_settings', '{not-json'));
    await page.goto('/');
    await expect(page.locator('#result')).not.toBeEmpty();
    await page.locator('#tab-user').click();
    await expect(page.locator('#result')).not.toBeEmpty();
});

test('TXT bulk download preserves numeric credentials exactly', async ({ page }) => {
    await page.goto('/');
    await pattern(page, '00001234567890123456789');
    await openBulk(page, 3);
    const pending = page.waitForEvent('download');
    await page.locator('#export-txt-btn').click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/\.txt$/);
    expect(await downloadText(download)).toBe(Array(3).fill('00001234567890123456789').join('\n'));
});

test('JSON bulk download preserves formula-shaped credentials as strings', async ({ page }) => {
    await page.goto('/');
    await pattern(page, '=1+1');
    await openBulk(page, 3);
    const pending = page.waitForEvent('download');
    await page.locator('#export-json-btn').click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    expect(JSON.parse(await downloadText(download))).toEqual(['=1+1', '=1+1', '=1+1']);
});

test('CSV download requires acknowledging text import and preserves exact bytes', async ({ page }) => {
    await page.goto('/');
    await pattern(page, '=1+1');
    await openBulk(page, 2);
    const unexpectedDownloads = [];
    page.on('download', (download) => unexpectedDownloads.push(download));
    await page.locator('#export-csv-btn').click();
    await expect(page.locator('#csv-export-dialog')).toBeVisible();
    await expect(page.locator('#csv-export-confirm')).toBeDisabled();
    expect(unexpectedDownloads).toHaveLength(0);
    await page.locator('#csv-text-ack').check();
    const pending = page.waitForEvent('download');
    await page.locator('#csv-export-confirm').click();
    const download = await pending;
    expect(await downloadText(download)).toBe('\uFEFFCredential\r\n"=1+1"\r\n"=1+1"');
    await expect(page.locator('#csv-export-dialog')).not.toBeVisible();
});

test('bulk generation can be cancelled before downloading partial credentials', async ({ page }) => {
    await page.goto('/');
    await pattern(page, '[A-Z]{512}');
    await openBulk(page, 10000);
    const downloads = [];
    page.on('download', (download) => downloads.push(download));
    await page.locator('#export-txt-btn').click();
    await expect(page.locator('#bulk-progress')).toBeVisible();
    await page.locator('#bulk-cancel-btn').click();
    await expect(page.locator('#bulk-cancel-btn')).not.toBeVisible();
    await expect(page.locator('#generate-btn')).toBeEnabled();
    expect(downloads).toHaveLength(0);
});

test('QR encodes the exact credential and removes all generated nodes on close', async ({ page }) => {
    await page.goto('/');
    const secret = await page.locator('#result').textContent();
    await page.locator('#qr-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#qr-modal')).toBeVisible();
    const pixels = await page.locator('#qr-container canvas').evaluate((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        data: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data),
    }));
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    expect(decoded && decoded.data).toBe(secret);
    await expect(page.locator('#qr-container')).not.toHaveAttribute('title');
    await page.keyboard.press('Escape');
    await expect(page.locator('#qr-modal')).not.toBeVisible();
    await expect(page.locator('#qr-container')).toBeEmpty();
    await expect(page.locator('#qr-btn')).toBeFocused();
});

test('QR has four modules of white margin in the dark theme', async ({ page }) => {
    await page.goto('/');
    await pattern(page, 'SHORT');
    if (!(await page.locator('body').evaluate((body) => body.classList.contains('dark-mode')))) {
        await page.locator('#theme-btn').click();
    }
    await page.locator('#qr-btn').click();
    const pixels = await page.locator('#qr-container canvas').evaluate((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        data: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data),
    }));
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    expect(decoded && decoded.data).toBe('SHORT');
    const moduleCount = decoded.version * 4 + 17;
    const quietZone = await page.locator('#qr-container').evaluate((element, moduleCount) => {
        const rendered = [...element.querySelectorAll('canvas, img, svg')]
            .find((node) => node.getBoundingClientRect().width > 0);
        const style = getComputedStyle(element);
        return {
            padding: Math.min(...['Top', 'Right', 'Bottom', 'Left'].map((side) => parseFloat(style[`padding${side}`]))),
            required: rendered.getBoundingClientRect().width / moduleCount * 4,
            background: style.backgroundColor,
        };
    }, moduleCount);
    expect(quietZone.padding).toBeGreaterThanOrEqual(quietZone.required - 0.5);
    expect(quietZone.background).toBe('rgb(255, 255, 255)');
});

test('lowercase username option produces only lowercase words and digits', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-user').click();
    await page.locator('#opt-user-lower').check();
    await expect(page.locator('#result')).toHaveText(/^[a-z0-9-]+$/);
    await page.reload();
    await expect(page.locator('#opt-user-lower')).toBeChecked();
    await expect(page.locator('#result')).toHaveText(/^[a-z0-9-]+$/);
});

test('target length limit reports an advisory without truncating the generated secret', async ({ page }) => {
    await page.goto('/');
    await pattern(page, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.locator('#target-max-length').fill('8');
    await page.locator('#target-max-length').blur();
    await expect(page.locator('#result')).toHaveText('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await expect(page.locator('#compatibility-warning')).toContainText('Exceeds the target limit by 18 characters');
    await expect(page.locator('#copy-btn')).toBeEnabled();
});

test('saved presets are independent snapshots and survive a reload', async ({ page }) => {
    await page.goto('/');
    await page.locator('.preset-panel > summary').click();
    await page.locator('#profile-name').fill('My 24 character password');
    await page.locator('#profile-save-btn').click();
    await page.locator('#length-num').fill('40');
    await page.locator('#length-num').blur();
    await expect(page.locator('#result')).toHaveText(/^.{40}$/);
    await page.locator('#profile-select').selectOption('saved:0');
    await expect(page.locator('#length-num')).toHaveValue('24');
    await expect(page.locator('#result')).toHaveText(/^.{24}$/);
    await page.reload();
    await page.locator('.preset-panel > summary').click();
    await page.locator('#profile-select').selectOption('saved:0');
    await expect(page.locator('#length-num')).toHaveValue('24');
    await page.locator('#profile-delete-btn').click();
    await expect(page.locator('#saved-profiles option')).toHaveCount(0);
});

test('built-in PIN preset preserves numeric-only generation', async ({ page }) => {
    await page.goto('/');
    await page.locator('.preset-panel > summary').click();
    await page.locator('#profile-select').selectOption('pin');
    await expect(page.locator('#result')).toHaveText(/^\d{6}$/);
    await expect(page.locator('#opt-upper')).not.toBeChecked();
    await expect(page.locator('#opt-lower')).not.toBeChecked();
    await expect(page.locator('#opt-syms')).not.toBeChecked();
});

test('allowed-character preview follows presets, exclusions and normalized custom symbols', async ({ page }) => {
    await page.goto('/');
    await page.locator('.preset-panel > summary').click();
    await page.locator('#profile-select').selectOption('alphanumeric');
    await page.locator('#allowed-characters > summary').click();
    const preview = page.locator('#allowed-character-preview');
    await expect(preview).toHaveText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    await expect(page.locator('#allowed-character-count')).toHaveText('(62)');
    await page.locator('#opt-upper').uncheck();
    await page.locator('#opt-ambig').check();
    await expect(preview).toHaveText('abcdefghijkmnopqrstuvwxyz23456789');
    await expect(page.locator('#allowed-character-count')).toHaveText('(33)');
    await page.locator('#opt-syms').check();
    await page.locator('#symbol-preset').selectOption('custom');
    await page.locator('#sym-input').fill('!!<<..a 0💡');
    await expect(preview).toHaveText('abcdefghijkmnopqrstuvwxyz23456789!<.');
    await expect(page.locator('#allowed-character-count')).toHaveText('(36)');
    await page.locator('#opt-paranoid').check();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    await expect(preview).toHaveText('abcdefghijkmnopqrstuvwxyz23456789!<.');
    for (const id of ['opt-lower', 'opt-nums', 'opt-syms']) await page.locator(`#${id}`).uncheck();
    await expect(preview).toHaveText('Select at least one character set.');
    await expect(page.locator('#allowed-character-count')).toHaveText('(unavailable)');
});

test('normalizing a numeric input after loading a preset regenerates the displayed credential', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-user').click();
    await page.locator('#opt-user-sep').selectOption('_');
    await page.locator('#user-num-count').fill('5');
    await page.locator('#user-num-count').blur();
    await page.locator('.preset-panel > summary').click();
    await page.locator('#profile-name').fill('Five digit suffix');
    await page.locator('#profile-save-btn').click();
    await page.locator('#user-num-count').fill('3');
    await page.locator('#user-num-count').blur();
    await page.locator('#profile-select').selectOption('saved:0');
    await expect(page.locator('#result')).toHaveText(/_\d{5}$/);
    await page.locator('#user-num-count').fill('');
    await page.locator('#user-num-count').blur();
    await expect(page.locator('#user-num-count')).toHaveValue('3');
    await expect(page.locator('#result')).toHaveText(/_\d{3}$/);
});

test('320px layout keeps all modes, expanded settings and the QR inside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto('/');
    for (const summary of ['.preset-panel > summary', '.export-panel > summary', '.about-panel > summary', '#allowed-characters > summary']) {
        await page.locator(summary).click();
    }
    for (const mode of ['pwd', 'pass', 'user', 'pattern']) {
        await page.locator(`#tab-${mode}`).click();
        if (mode === 'pattern') await page.locator('#pattern-input').fill('[A-Z]{512}');
        const dimensions = await page.evaluate(() => ({
            viewport: document.documentElement.clientWidth,
            content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        }));
        expect(dimensions.content, `${mode} must not cause horizontal scrolling`).toBeLessThanOrEqual(dimensions.viewport + 1);
    }
    await page.locator('#pattern-input').fill('SHORT');
    await page.locator('#qr-btn').click();
    await expect(page.locator('#qr-modal')).toBeVisible();
    const qrDimensions = await page.locator('#qr-modal').evaluate((dialog) => {
        const symbol = [...dialog.querySelectorAll('canvas, img')]
            .find((element) => element.getBoundingClientRect().width > 0);
        const bounds = symbol.getBoundingClientRect();
        const dialogBounds = dialog.getBoundingClientRect();
        return {
            scrollWidth: dialog.scrollWidth,
            clientWidth: dialog.clientWidth,
            symbolWidth: bounds.width,
            left: dialogBounds.left,
            right: dialogBounds.right,
        };
    });
    expect(qrDimensions.scrollWidth).toBeLessThanOrEqual(qrDimensions.clientWidth + 1);
    expect(qrDimensions.left).toBeGreaterThanOrEqual(0);
    expect(qrDimensions.right).toBeLessThanOrEqual(320);
    expect(qrDimensions.symbolWidth).toBeGreaterThanOrEqual(120);
    await page.locator('#qr-close').click();
    await expect(page.locator('#qr-modal')).not.toBeVisible();
});

test('About shows build and connection status with working local license links', async ({ page }) => {
    await page.goto('/');
    await page.locator('.about-panel > summary').click();
    await expect(page.locator('#build-info')).toContainText('Version 2.2.0');
    await expect(page.locator('#connection-info')).toHaveText('Connection: loopback HTTP');
    await expect(page.locator('#delivery-warning')).toBeHidden();
    for (const [name, filename, expectedContent] of [
        ['License', 'LICENSE', 'MIT License'],
        ['Third-party notices', 'THIRD_PARTY_NOTICES.md', 'QRCode'],
    ]) {
        const link = page.getByRole('link', { name, exact: true });
        await expect(link).toHaveAttribute('href', filename);
        const url = new URL(await link.getAttribute('href'), page.url());
        expect(url.origin).toBe(new URL(page.url()).origin);
        const response = await page.request.get(url.href);
        expect(response.ok()).toBe(true);
        expect(await response.text()).toContain(expectedContent);
        expect(response.headers()['content-type']).toContain('text/plain');
    }
});

test('a non-loopback HTTP origin shows the delivery warning without making a remote connection', async ({ page }) => {
    // Every request for this reserved .invalid host is fulfilled from the local
    // test server; the browser still observes a non-secure remote HTTP origin.
    await page.route('http://vault-test.invalid/**', async (route) => {
        const resource = new URL(route.request().url());
        const response = await page.request.get(`http://127.0.0.1:4173${resource.pathname}${resource.search}`);
        await route.fulfill({ response });
    });
    await page.goto('http://vault-test.invalid/');
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await expect(page.locator('#delivery-warning')).toBeVisible();
    await expect(page.locator('#delivery-warning')).toContainText('unencrypted HTTP');
    await page.locator('.about-panel > summary').click();
    await expect(page.locator('#connection-info')).toHaveText('Connection: unencrypted HTTP');
});

test('local file works with network offline for generation and QR rendering', async ({ page, context }) => {
    // WebKit's emulated offline flag rejects file: navigation itself. Deny all
    // HTTP requests during bootstrap, then turn on offline emulation once the
    // document is loaded to verify runtime behavior in every browser engine.
    const networkAttempts = [];
    await page.route(/^https?:\/\//, (route) => {
        networkAttempts.push(route.request().url());
        return route.abort();
    });
    const entry = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;
    await page.goto(entry);
    await context.setOffline(true);
    await expect(page.locator('#result')).toHaveText(/^.{24}$/);
    await pattern(page, 'OFFLINE-[0-9]{6}');
    await expect(page.locator('#result')).toHaveText(/^OFFLINE-\d{6}$/);
    await page.locator('#qr-btn').click();
    await expect(page.locator('#qr-modal')).toBeVisible();
    await expect(page.locator('#qr-container canvas')).toHaveCount(1);
    await page.locator('#qr-close').click();
    await page.locator('.about-panel > summary').click();
    await expect(page.locator('#connection-info')).toHaveText('Connection: local file');
    await expect(page.locator('#delivery-warning')).toBeHidden();
    expect(networkAttempts).toEqual([]);
});
