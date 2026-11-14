'use strict';

const { test: base, expect } = require('@playwright/test');
const jsQR = require('jsqr');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { version } = require('../package.json');

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

async function chooseMode(page, mode) {
    if (await page.locator('#mode-select').isVisible()) await page.locator('#mode-select').selectOption(mode);
    else await page.locator(`#tab-${mode}`).click();
}

async function openDetails(page, selector) {
    const details = page.locator(selector);
    if (!await details.evaluate((element) => element.open)) await details.locator(':scope > summary').click();
}

async function pattern(page, value) {
    await chooseMode(page, 'pattern');
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

async function decodeQr(page) {
    const pixels = await page.locator('#qr-container canvas').evaluate((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        data: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data),
    }));
    return jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 900 }]) {
    test(`compact default at ${viewport.width}px keeps actions visible above collapsed settings`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/');
        for (const selector of ['#advanced-generation', '#privacy-options', '.export-panel', '.about-panel', '#strength-details']) {
            expect(await page.locator(selector).evaluate((details) => details.open)).toBe(false);
        }
        await expect(page.locator('#opt-paranoid')).toBeVisible();
        await expect(page.locator('#profile-select')).toBeVisible();
        for (const id of ['generate-btn', 'copy-btn', 'qr-btn']) await expect(page.locator(`#${id}`)).toBeInViewport();
        const card = await page.locator('.container').boundingBox();
        expect(card.height).toBeLessThan(860);
        const result = await page.locator('.result-section').boundingBox();
        const actions = await page.locator('.action-group').boundingBox();
        const presets = await page.locator('.preset-row').boundingBox();
        expect(actions.y).toBeGreaterThanOrEqual(result.y + result.height);
        expect(actions.y + actions.height).toBeLessThan(presets.y);
        const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    });
}

test('mobile mode selector supports all modes and stays synchronized with desktop tabs after reload', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/');
    await expect(page.locator('.tabs')).toBeHidden();
    await expect(page.getByLabel('Mode', { exact: true })).toBeVisible();
    for (const mode of ['pass', 'user', 'pattern', 'raw', 'pwd']) {
        await page.getByLabel('Mode', { exact: true }).selectOption(mode);
        await expect(page.locator(`#${mode}-options`)).toBeVisible();
        await expect(page.locator(`#tab-${mode}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#result')).not.toBeEmpty();
    }
    await page.locator('#mode-select').selectOption('raw');
    await page.reload();
    await expect(page.locator('#mode-select')).toHaveValue('raw');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('#mode-select')).toBeHidden();
    await expect(page.locator('#tab-raw')).toBeVisible();
    await expect(page.locator('#tab-raw')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#tab-pwd').click();
    await expect(page.locator('#mode-select')).toHaveValue('pwd');
});

test('strength breakdown is keyboard accessible without generating another secret', async ({ page }) => {
    await page.goto('/');
    const secret = await page.locator('#result').textContent();
    await expect(page.locator('#crack-text')).toBeHidden();
    await page.locator('#strength-details > summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#crack-text')).toBeVisible();
    await expect(page.locator('#pool-info')).toContainText('Character pool');
    await page.keyboard.press('Space');
    await expect(page.locator('#crack-text')).toBeHidden();
    await expect(page.locator('#result')).toHaveText(secret);
});

test('small action and disclosure links remain readable in both themes', async ({ page }) => {
    await page.goto('/');
    for (const dark of [false, true]) {
        if (await page.locator('body').evaluate((body) => body.classList.contains('dark-mode')) !== dark) {
            await page.locator('#theme-btn').click();
        }
        const ratios = await page.evaluate(() => {
            const luminance = (color) => {
                const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => {
                    const value = channel / 255;
                    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
                });
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const background = luminance(getComputedStyle(document.querySelector('.container')).backgroundColor);
            return ['#clear-btn', '#strength-details > summary', '.about-panel .text-link'].map((selector) => {
                const foreground = luminance(getComputedStyle(document.querySelector(selector)).color);
                return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
            });
        });
        for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
});

test('collapsed privacy settings keep compatibility warnings and Paranoid controls visible', async ({ page }) => {
    await page.goto('/');
    await pattern(page, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await openDetails(page, '#privacy-options');
    await page.locator('#target-max-length').fill('8');
    await page.locator('#target-max-length').blur();
    await page.locator('#clear-time').selectOption('30000');
    await page.locator('#privacy-options > summary').click();
    await expect(page.locator('#clear-setting-summary')).toHaveText('Clear after 30s');
    await expect(page.locator('#compatibility-warning')).toBeVisible();
    await expect(page.locator('#compatibility-warning')).toContainText('Exceeds the target limit by 18 characters');
    await page.locator('#opt-paranoid').check();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    await expect(page.locator('#paranoid-overlay')).toBeVisible();
    expect(await page.locator('#privacy-options').evaluate((details) => details.open)).toBe(false);
});

test('mobile bulk generation disables relocated controls and Paranoid can still cancel it', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/');
    await pattern(page, '[A-Z]{512}');
    await openBulk(page, 10000);
    const downloads = [];
    page.on('download', (download) => downloads.push(download));
    await page.locator('#export-txt-btn').click();
    await expect(page.locator('#bulk-progress')).toBeVisible();
    for (const id of ['mode-select', 'profile-select', 'pattern-input', 'raw-byte-length', 'profile-save-btn']) {
        await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    await expect(page.locator('#opt-paranoid')).toBeEnabled();
    await page.locator('#opt-paranoid').check();
    await expect(page.locator('#bulk-progress')).toBeHidden();
    await expect(page.locator('#mode-select')).toBeEnabled();
    await expect(page.locator('#export-txt-btn')).toBeDisabled();
    expect(downloads).toEqual([]);
});

test('serves hardened headers and generates each mode', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(headers['content-security-policy']).toContain("connect-src 'none'");
    expect(headers['content-security-policy']).toContain("manifest-src 'self'");
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    await expect(page.locator('#result')).toHaveText(/.{24}/);
    for (const mode of ['pass', 'user', 'pattern', 'raw', 'pwd']) {
        await chooseMode(page, mode);
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
    await expect(page.locator('#tab-raw')).toBeFocused();
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

test('raw secrets encode the selected number of random bytes without losing entropy', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-raw').click();
    for (const byteLength of [32, 64]) {
        await page.locator('#raw-byte-length').selectOption(String(byteLength));
        for (const encoding of ['hex', 'base64', 'base64url']) {
            await page.locator('#raw-encoding').selectOption(encoding);
            const secret = await page.locator('#result').textContent();
            const bytes = Buffer.from(secret, encoding);
            expect(bytes.length).toBe(byteLength);
            expect(bytes.toString(encoding)).toBe(secret);
            await expect(page.locator('#entropy-text')).toHaveText(`${byteLength * 8} bits`);
            if (encoding === 'hex') expect(secret).toMatch(new RegExp(`^[0-9a-f]{${byteLength * 2}}$`));
            if (encoding === 'base64') expect(secret).toMatch(/^[A-Za-z0-9+/]+={1,2}$/);
            if (encoding === 'base64url') expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    }
});

test('raw settings and saved presets survive reload without storing a generated secret', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-raw').click();
    await page.locator('#raw-byte-length').selectOption('64');
    await page.locator('#raw-encoding').selectOption('base64url');
    const secret = await page.locator('#result').textContent();
    await openDetails(page, '#advanced-generation');
    await page.locator('#profile-name').fill('64 random bytes as base64url');
    await page.locator('#profile-save-btn').click();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(stored).not.toContain(secret);
    await page.reload();
    await expect(page.locator('#tab-raw')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#raw-byte-length')).toHaveValue('64');
    await expect(page.locator('#raw-encoding')).toHaveValue('base64url');
    await openDetails(page, '#advanced-generation');
    await page.locator('#profile-select').selectOption('raw-hex');
    await expect(page.locator('#raw-byte-length')).toHaveValue('32');
    await expect(page.locator('#raw-encoding')).toHaveValue('hex');
    await expect(page.locator('#result')).toHaveText(/^[0-9a-f]{64}$/);
    await page.locator('#profile-select').selectOption('raw-base64');
    await expect(page.locator('#result')).toHaveText(/^[A-Za-z0-9+/]{43}=$/);
    await page.locator('#profile-select').selectOption('saved:0');
    await expect(page.locator('#raw-byte-length')).toHaveValue('64');
    await expect(page.locator('#raw-encoding')).toHaveValue('base64url');
    await expect(page.locator('#result')).toHaveText(/^[A-Za-z0-9_-]{86}$/);
});

test('raw bulk export preserves independent exact bytes and Paranoid prevents export', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tab-raw').click();
    await page.locator('#raw-byte-length').selectOption('64');
    await page.locator('#raw-encoding').selectOption('base64');
    await openBulk(page, 3);
    const pending = page.waitForEvent('download');
    await page.locator('#export-json-btn').click();
    const values = JSON.parse(await downloadText(await pending));
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
    for (const value of values) {
        expect(Buffer.from(value, 'base64').length).toBe(64);
        expect(Buffer.from(value, 'base64').toString('base64')).toBe(value);
    }
    const secret = await page.locator('#result').textContent();
    await page.locator('#opt-paranoid').check();
    await expect(page.locator('#result')).toHaveText('Credential hidden');
    expect(await page.locator('body').ariaSnapshot()).not.toContain(secret);
    for (const id of ['export-txt-btn', 'export-csv-btn', 'export-json-btn']) {
        await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('#result')).toBeEmpty();
    expect(await page.evaluate(() => localStorage.getItem('vault_settings'))).toBeNull();
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
    await openDetails(page, '#privacy-options');
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
    await openDetails(page, '#privacy-options');
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
    const decoded = await decodeQr(page);
    expect(decoded && decoded.data).toBe(secret);
    await expect(page.locator('#qr-container')).not.toHaveAttribute('title');
    await page.keyboard.press('Escape');
    await expect(page.locator('#qr-modal')).not.toBeVisible();
    await expect(page.locator('#qr-container')).toBeEmpty();
    await expect(page.locator('#qr-btn')).toBeFocused();
});

for (const length of [128, 150, 512, 1000]) {
    test(`QR decodes a full ${length}-character credential exactly`, async ({ page }) => {
        await page.goto('/');
        await pattern(page, `[A-Za-z0-9]{${length}}`);
        const secret = await page.locator('#result').textContent();
        expect(secret).toHaveLength(length);
        await page.locator('#qr-btn').click();
        await expect(page.locator('#qr-modal')).toBeVisible();
        const decoded = await decodeQr(page);
        expect(decoded && decoded.data).toBe(secret);
    });
}

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
    await openDetails(page, '#privacy-options');
    await page.locator('#target-max-length').fill('8');
    await page.locator('#target-max-length').blur();
    await expect(page.locator('#result')).toHaveText('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await expect(page.locator('#compatibility-warning')).toContainText('Exceeds the target limit by 18 characters');
    await expect(page.locator('#copy-btn')).toBeEnabled();
});

test('saved presets are independent snapshots and survive a reload', async ({ page }) => {
    await page.goto('/');
    await openDetails(page, '#advanced-generation');
    await page.locator('#profile-name').fill('My 24 character password');
    await page.locator('#profile-save-btn').click();
    await page.locator('#length-num').fill('40');
    await page.locator('#length-num').blur();
    await expect(page.locator('#result')).toHaveText(/^.{40}$/);
    await page.locator('#profile-select').selectOption('saved:0');
    await expect(page.locator('#length-num')).toHaveValue('24');
    await expect(page.locator('#result')).toHaveText(/^.{24}$/);
    await page.reload();
    await openDetails(page, '#advanced-generation');
    await page.locator('#profile-select').selectOption('saved:0');
    await expect(page.locator('#length-num')).toHaveValue('24');
    await page.locator('#profile-delete-btn').click();
    await expect(page.locator('#saved-profiles option')).toHaveCount(0);
});

test('built-in PIN preset preserves numeric-only generation', async ({ page }) => {
    await page.goto('/');
    await openDetails(page, '#advanced-generation');
    await page.locator('#profile-select').selectOption('pin');
    await expect(page.locator('#result')).toHaveText(/^\d{6}$/);
    await expect(page.locator('#opt-upper')).not.toBeChecked();
    await expect(page.locator('#opt-lower')).not.toBeChecked();
    await expect(page.locator('#opt-syms')).not.toBeChecked();
});

test('allowed-character preview follows presets, exclusions and normalized custom symbols', async ({ page }) => {
    await page.goto('/');
    await openDetails(page, '#advanced-generation');
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
    await openDetails(page, '#advanced-generation');
    await page.locator('#opt-user-sep').selectOption('_');
    await page.locator('#user-num-count').fill('5');
    await page.locator('#user-num-count').blur();
    await openDetails(page, '#advanced-generation');
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
    for (const summary of ['#advanced-generation > summary', '#privacy-options > summary', '.export-panel > summary', '.about-panel > summary', '#allowed-characters > summary']) {
        await page.locator(summary).click();
    }
    for (const mode of ['raw', 'pwd', 'pass', 'user', 'pattern']) {
        await chooseMode(page, mode);
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

test('install manifest stays local and its advertised icons have the correct dimensions', async ({ page }) => {
    await page.goto('/');
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute('href', 'manifest.webmanifest');
    const manifestUrl = new URL(await manifestLink.getAttribute('href'), page.url());
    const response = await page.request.get(manifestUrl.href);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('application/manifest+json');
    const manifest = await response.json();
    expect(manifest.name).toBe('Homelab Vault');
    expect(manifest.display).toBe('standalone');
    for (const target of [manifest.id, manifest.start_url, manifest.scope, ...manifest.shortcuts.map((shortcut) => shortcut.url)]) {
        expect(new URL(target, manifestUrl).origin).toBe(new URL(page.url()).origin);
    }
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) {
        const iconUrl = new URL(icon.src, manifestUrl);
        expect(iconUrl.origin).toBe(new URL(page.url()).origin);
        const dimensions = await page.evaluate(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            return `${image.naturalWidth}x${image.naturalHeight}`;
        }, iconUrl.href);
        expect(dimensions).toBe(icon.sizes);
    }
    const registrations = await page.evaluate(async () => (
        navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map((entry) => entry.scope) : []
    ));
    expect(registrations).toEqual([]);
});

test('320px layout contains an expanded QR for a 1000-character credential', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto('/');
    await pattern(page, '[A-Za-z0-9]{1000}');
    const secret = await page.locator('#result').textContent();
    await page.locator('#qr-btn').click();
    await expect(page.locator('#qr-modal')).toBeVisible();
    const dimensions = await page.locator('#qr-modal').evaluate((dialog) => {
        const bounds = dialog.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: dialog.clientWidth, content: dialog.scrollWidth };
    });
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(320);
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    const decoded = await decodeQr(page);
    expect(decoded && decoded.data).toBe(secret);
    await page.keyboard.press('Escape');
    await expect(page.locator('#qr-modal')).not.toBeVisible();
});

test('About shows build and connection status with working local license links', async ({ page }) => {
    await page.goto('/');
    await page.locator('.about-panel > summary').click();
    await expect(page.locator('#build-info')).toContainText(`Version ${version}`);
    await expect(page.locator('#connection-info')).toHaveText('Connection: loopback HTTP');
    await expect(page.locator('#delivery-warning')).toBeHidden();
    for (const [name, href] of [
        ['@jakubgt', 'https://github.com/jakubgt'],
        ['Project on GitHub', 'https://github.com/jakubgt/homelab-vault-gen'],
    ]) {
        const link = page.getByRole('link', { name, exact: true });
        await expect(link).toHaveAttribute('href', href);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
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
    const entry = pathToFileURL(path.resolve(__dirname, '..', 'public', 'index.html')).href;
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
