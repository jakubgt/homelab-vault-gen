/*
 * Homelab Vault — zero-dependency production-core tests
 * Run with: node tests/repository.cjs
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
    CHARS,
    DEFAULT_SYMS,
    CONFIG_FRIENDLY_SYMS,
    calculatePasswordEntropy,
    generatePasswordBytes,
    getSecureRandomInt,
    normalizeSymbolPool,
    parsePattern
} = require('../public/core.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? `  ->  ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function expectThrow(name, callback, ErrorType = Error) {
    let error = null;
    try {
        callback();
    } catch (caught) {
        error = caught;
    }
    check(name, error instanceof ErrorType, error ? error.constructor.name : 'did not throw');
}

function read(relativePath) {
    return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function loadWords() {
    const source = read('public/words.js');
    const arrayMatch = source.match(/\[[\s\S]*\]/);
    if (!arrayMatch) throw new Error('Could not find the WORDS array in words.js');
    return JSON.parse(arrayMatch[0].replace(/'/g, '"'));
}

section('1. Secure random integer');

{
    const values = [0xffffffff, 27];
    let calls = 0;
    const fakeCrypto = {
        getRandomValues(target) {
            target[0] = values[calls++];
            return target;
        }
    };
    const result = getSecureRandomInt(10, fakeCrypto);
    check('rejects values above the unbiased boundary before using modulo', result === 7 && calls === 2, `result=${result}, calls=${calls}`);
}

{
    let inRange = true;
    for (const max of [1, 2, 7, 26, 62, 95, 7776]) {
        for (let draw = 0; draw < 20_000; draw++) {
            const result = getSecureRandomInt(max);
            if (!Number.isInteger(result) || result < 0 || result >= max) {
                inRange = false;
                break;
            }
        }
    }
    check('always returns an integer in [0, max)', inRange);
}

expectThrow('rejects max=0 instead of looping forever', () => getSecureRandomInt(0), RangeError);
expectThrow('rejects a max above the Uint32 source range', () => getSecureRandomInt(0x100000001), RangeError);
expectThrow('requires a cryptographic random source', () => getSecureRandomInt(10, {}), Error);

section('2. Symbol pools and password guarantees');

check(
    'deduplicates symbols and removes letters, digits, whitespace, and Unicode',
    normalizeSymbolPool('!!!@@A1 é🙂') === '!@'
);
check('default symbol pool is unique', new Set(DEFAULT_SYMS).size === DEFAULT_SYMS.length);
check('config-friendly pool is the documented ._-+= set', CONFIG_FRIENDLY_SYMS === '._-+=');

{
    const sets = [CHARS.upper, CHARS.lower, CHARS.nums, DEFAULT_SYMS];
    let allValid = true;
    for (let sample = 0; sample < 10_000; sample++) {
        const password = new TextDecoder().decode(generatePasswordBytes(16, sets));
        if (!sets.every((set) => Array.from(password).some((char) => set.includes(char)))) {
            allValid = false;
            break;
        }
    }
    check('every generated password contains all selected classes', allValid);
}

{
    const sets = [CHARS.upper, CHARS.lower, CHARS.nums, '!'];
    let allValid = true;
    for (let sample = 0; sample < 2_000; sample++) {
        const password = new TextDecoder().decode(generatePasswordBytes(4, sets));
        if (!sets.every((set) => Array.from(password).some((char) => set.includes(char)))) {
            allValid = false;
            break;
        }
    }
    check('class guarantee holds for the tight, one-symbol edge case', allValid);
}

check('returns null when length is below selected class count', generatePasswordBytes(3, [CHARS.upper, CHARS.lower, CHARS.nums, '!']) === null);
expectThrow('rejects overlapping character sets', () => generatePasswordBytes(12, ['ab', 'bc']), RangeError);
expectThrow('rejects non-ASCII character sets', () => generatePasswordBytes(12, ['abc', 'é']), RangeError);

section('3. Exact entropy accounting');

{
    const entropy = calculatePasswordEntropy(2, ['ab', '1']);
    check('counts the exact class-constrained output space', Math.abs(entropy - 2) < 1e-12, `got ${entropy}`);
}

{
    const entropy = calculatePasswordEntropy(4, [CHARS.upper, CHARS.lower, CHARS.nums, DEFAULT_SYMS]);
    check('default four-character constrained entropy is about 22.12 bits', Math.abs(entropy - 22.1151) < 0.001, `got ${entropy.toFixed(4)}`);
}

{
    const entropy = calculatePasswordEntropy(24, [CHARS.upper, CHARS.lower, CHARS.nums, DEFAULT_SYMS]);
    check('24-character default entropy is finite and above 150 bits', Number.isFinite(entropy) && entropy > 150, `got ${entropy.toFixed(2)}`);
}

section('4. Pattern parser');

{
    const analysis = parsePattern('[A-Z]{3}-[0-9]{4}-[a-z]{5}');
    const expectedEntropy = 8 * Math.log2(26) + 4 * Math.log2(10);
    check('parses the documented pattern length', !analysis.error && analysis.totalLength === 14, analysis.error || `length=${analysis.totalLength}`);
    check('calculates pattern entropy from randomized tokens only', Math.abs(analysis.entropy - expectedEntropy) < 1e-10, `got ${analysis.entropy}`);
}

check('supports escaped literal brackets and braces', parsePattern('\\[A-Z\\]\\{2\\}').error === null);
check('rejects a missing closing bracket', Boolean(parsePattern('[A-Z').error));
check('rejects descending ranges', Boolean(parsePattern('[Z-A]').error));
check('rejects zero repetition', Boolean(parsePattern('[A-Z]{0}').error));
check('rejects non-ASCII patterns instead of corrupting them', Boolean(parsePattern('[é]').error));
check('caps generated pattern output at 1,000 characters', Boolean(parsePattern('[A-Z]{1001}').error));

section('5. Wordlist integrity');

const words = loadWords();
const wordlistDigest = crypto.createHash('sha256').update(words.join('\n')).digest('hex');
check('wordlist has exactly 7,776 entries', words.length === 7776, `got ${words.length}`);
check('all wordlist entries are unique', new Set(words).size === words.length);
check('all wordlist entries use the expected lowercase/hyphen format', words.every((word) => /^[a-z]+(?:-[a-z]+)*$/.test(word)));
check(
    'word sequence matches the audited project fixture',
    wordlistDigest === 'abae49761b88f3f1ba31ef944bea1f61b795a3cd7e1cfb7d276ed45bf77967ba',
    wordlistDigest
);

section('6. Repository integration');

const html = read('public/index.html');
const app = read('public/app.js');
const nginx = read('deploy/nginx.conf');
const caddy = read('deploy/Caddyfile');
const compose = read('docker-compose.yml');
const readme = read('README.md');
const installer = read('install-caddy-lxc.sh');
const packageInfo = JSON.parse(read('package.json'));
const dependabot = read('.github/dependabot.yml');
const versionContext = vm.createContext({});
vm.runInContext(read('public/version.js'), versionContext, { timeout: 1000, filename: 'version.js' });
const build = versionContext.VAULT_BUILD;
const runtimeScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
const activeCaddy = caddy
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const renderedCaddy = caddy
    .replace(/^https:\/\/<LXC_IPV4>\s*\{/m, 'https://192.0.2.1 {')
    .replace(/^\s*ip_address_must_be_configured\s*$/m, '');

// Directive and source order do not change this policy. Reject duplicate
// directives, which browsers otherwise resolve by silently taking the first.
function parseCsp(policy) {
    const directives = {};
    for (const part of policy.split(';')) {
        const [rawName, ...sources] = part.trim().split(/\s+/);
        if (!rawName) continue;
        const name = rawName.toLowerCase();
        if (Object.hasOwn(directives, name)) return null;
        directives[name] = [...new Set(sources)].sort();
    }
    return Object.fromEntries(Object.entries(directives).sort(([left], [right]) => left.localeCompare(right)));
}

const nginxCspHeaders = [...nginx.matchAll(/^\s*add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always;/gm)];
const caddyCspHeaders = [...activeCaddy.matchAll(/^\s*Content-Security-Policy\s+"([^"]+)"\s*$/gm)];
const nginxPolicy = parseCsp(nginxCspHeaders[0]?.[1] || '');
const caddyPolicy = parseCsp(caddyCspHeaders[0]?.[1] || '');
const requiredCsp = {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'connect-src': ["'none'"],
    'manifest-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
};

check('HTML contains no inline style attributes', !/\sstyle\s*=/i.test(html));
check('HTML contains no inline scripts', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
check('shared production core loads before app.js', html.indexOf('core.js') > -1 && html.indexOf('core.js') < html.indexOf('app.js'));
check('Docker serves scripts from the dedicated read-only public directory',
    compose.includes('./public:/usr/share/nginx/html:ro') && runtimeScripts.length > 0 &&
    runtimeScripts.every((asset) => !asset.includes('..') && fs.statSync(path.resolve(__dirname, '..', 'public', asset)).isFile()) &&
    !compose.includes('- .:/usr/share/nginx/html'));
check('build metadata loads before app.js', runtimeScripts.indexOf('version.js') >= 0 && runtimeScripts.indexOf('version.js') < runtimeScripts.indexOf('app.js'));
check('build metadata matches the package release version', Boolean(build) && build.version === packageInfo.version);
check('build metadata identifies a source checkout or one full commit', Boolean(build) && /^(?:source|[0-9a-f]{40})$/.test(build.commit));
check('build metadata cannot be mutated accidentally', Boolean(build) && Object.isFrozen(build));
const installerVersion = installer.match(/^RELEASE_VERSION=["']([^"']+)["']\s*$/m)?.[1];
check('installer and browser identify the same release version', installerVersion === packageInfo.version);
check('Web runtime includes the application and third-party licenses',
    read('public/LICENSE') === read('LICENSE') && read('public/THIRD_PARTY_NOTICES.md').includes('QRCode'));
check('Docker healthcheck matches the IPv4 NGINX listener', compose.includes('http://127.0.0.1:8080/') && /^\s*listen 8080;/m.test(nginx));
check('Dependabot uses the Compose ecosystem for its interpolated image default', /^\s*- package-ecosystem: docker-compose\s*$/m.test(dependabot));
check('Paranoid Mode never clears unrelated origin storage', !app.includes('localStorage.clear'));
check('QR cleanup removes the library title copy', app.includes("removeAttribute('title')"));
check('served CSP does not allow unsafe inline code', !nginx.includes("'unsafe-inline'") && !caddy.includes("'unsafe-inline'"));
check('served CSP permits local QR data images', [nginx, caddy].every((config) => config.includes("img-src 'self' data:")));
check('NGINX and Caddy each define one unambiguous CSP', nginxCspHeaders.length === 1 && caddyCspHeaders.length === 1 && Boolean(nginxPolicy) && Boolean(caddyPolicy));
check('NGINX and Caddy CSP directives stay synchronized', Boolean(nginxPolicy) && Boolean(caddyPolicy) && JSON.stringify(nginxPolicy) === JSON.stringify(caddyPolicy));
check('served CSP retains required local-only sources and disables connections', [nginxPolicy, caddyPolicy].every((policy) => Boolean(policy) && Object.entries(requiredCsp).every(([name, sources]) => JSON.stringify(policy[name]) === JSON.stringify(sources))));
check(
    'Caddy requires the LXC IPv4 and uses its internal CA',
    /^https:\/\/<LXC_IPV4>\s*\{/m.test(activeCaddy) &&
        (activeCaddy.match(/<LXC_IPV4>/g) || []).length === 1 &&
        /^\s*ip_address_must_be_configured\s*$/m.test(activeCaddy) &&
        /^\s*tls internal\s*$/m.test(activeCaddy)
);
check(
    'Caddy IP template renders one exact active address',
    !/^https:\/\/<LXC_IPV4>\s*\{/m.test(renderedCaddy) &&
        !/^\s*ip_address_must_be_configured\s*$/m.test(renderedCaddy) &&
        (renderedCaddy.match(/^https:\/\/192\.0\.2\.1\s*\{/gm) || []).length === 1
);
check('Caddy skips automatic host trust-store changes', /^\s*skip_install_trust\s*$/m.test(activeCaddy));
const caddyHiddenFiles = [...activeCaddy.matchAll(/^\s*hide\s+([^\n]+)/gm)].flatMap((match) => match[1].trim().split(/\s+/));
check('Caddy hides ownership and deployment metadata', ['.homelab-vault-managed', '.homelab-vault-deployment'].every((file) => caddyHiddenFiles.includes(file)));
check(
    'Caddy leaves localhost and vault.lan alternatives disabled',
    !/^localhost\s*\{/m.test(activeCaddy) && !/^https:\/\/vault\.lan\s*\{/m.test(activeCaddy)
);
check(
    'README uses the guided Debian LXC installer',
    readme.includes('install-caddy-lxc.sh') &&
        readme.includes('homelab-vault-update') &&
        readme.includes('The installer verifies the address you enter, but it cannot reserve it for you')
);
check(
    'installer prompts for an IPv4 address assigned to the LXC',
    installer.includes("Enter this LXC's reserved IPv4 address") &&
        installer.includes('ip -4 -o address show scope global') &&
        installer.includes('END { exit !found }')
);
check(
    'installer renders and validates the guarded Caddy template',
    installer.includes('s|^https://<LXC_IPV4> {|https://${VAULT_IP} {|') &&
        installer.includes('ip_address_must_be_configured') &&
        installer.includes("^https://<LXC_IPV4>[[:space:]]*\\{") &&
        installer.includes('/usr/bin/caddy validate') &&
        installer.includes('restore_previous_caddy')
);
check(
    'installer uses the official Caddy repository without a full OS upgrade',
    installer.includes('https://dl.cloudsmith.io/public/caddy/stable/gpg.key') &&
        installer.includes('apt-get install -y caddy') &&
        !installer.includes('full-upgrade') &&
        !installer.includes('apt-get upgrade')
);
check(
    'installer publishes only the public CA certificate',
    installer.includes('caddy-root.crt') &&
        installer.includes('sha256sum "$PUBLIC_CA"') &&
        !installer.includes('/root.key')
);
check(
    'installer stages version metadata and license files with the runtime assets',
    installer.includes('/srv/.homelab-vault.new.XXXXXX') &&
        ['LICENSE', 'THIRD_PARTY_NOTICES.md'].every((asset) => installer.includes('"${SOURCE_DIR}/public/' + asset + '"')) &&
        installer.includes('"${SITE_STAGE}/version.js"') &&
        installer.includes('"${SITE_STAGE}/${DEPLOYMENT_FILE}"')
);
check(
    'installer compares itself with the selected source commit before staging',
    installer.includes('fetch_revision "$SOURCE_DIR" "$DEPLOY_COMMIT"') &&
        installer.includes('cmp -s "$0" "${SOURCE_DIR}/install-caddy-lxc.sh"') &&
        !installer.includes('raw.githubusercontent.com/jakubgt/homelab-vault-gen/main/')
);
check(
    'installer acquires its protected lock before inspecting deployment state',
    installer.includes('LOCK_FILE="/run/homelab-vault/install.lock"') &&
        installer.indexOf('\nacquire_install_lock\n') > -1 &&
        installer.indexOf('\nacquire_install_lock\n') < installer.indexOf('\nif dpkg-query')
);

console.log(`\n${'-'.repeat(58)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
