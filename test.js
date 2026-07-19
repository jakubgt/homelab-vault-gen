/*
 * Homelab Vault — zero-dependency production-core tests
 * Run with: node test.js
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    CHARS,
    DEFAULT_SYMS,
    CONFIG_FRIENDLY_SYMS,
    calculatePasswordEntropy,
    generatePasswordBytes,
    getSecureRandomInt,
    normalizeSymbolPool,
    parsePattern
} = require('./core.js');

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
    return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

function loadWords() {
    const source = read('words.js');
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

const html = read('index.html');
const app = read('app.js');
const nginx = read('nginx.conf');
const caddy = read('Caddyfile');
const compose = read('docker-compose.yml');
const readme = read('README.md');
const activeCaddy = caddy
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const renderedCaddy = activeCaddy
    .replace('<LXC_IPV4>', '192.0.2.1')
    .replace(/^\s*ip_address_must_be_configured\s*$/m, '');

check('HTML contains no inline style attributes', !/\sstyle\s*=/i.test(html));
check('HTML contains no inline scripts', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
check('shared production core loads before app.js', html.indexOf('core.js') > -1 && html.indexOf('core.js') < html.indexOf('app.js'));
check('Docker serves the shared production core', compose.includes('./core.js:'));
check('Paranoid Mode never clears unrelated origin storage', !app.includes('localStorage.clear'));
check('QR cleanup removes the library title copy', app.includes("removeAttribute('title')"));
check('served CSP does not allow unsafe inline code', !nginx.includes("'unsafe-inline'") && !caddy.includes("'unsafe-inline'"));
check('served CSP permits local QR data images', [nginx, caddy].every((config) => config.includes("img-src 'self' data:")));
check(
    'Caddy requires the LXC IPv4 and uses its internal CA',
    /^https:\/\/<LXC_IPV4>\s*\{/m.test(activeCaddy) &&
        (activeCaddy.match(/<LXC_IPV4>/g) || []).length === 1 &&
        /^\s*ip_address_must_be_configured\s*$/m.test(activeCaddy) &&
        /^\s*tls internal\s*$/m.test(activeCaddy)
);
check(
    'Caddy IP template renders one exact active address',
    !renderedCaddy.includes('<LXC_IPV4>') &&
        !renderedCaddy.includes('ip_address_must_be_configured') &&
        (renderedCaddy.match(/^https:\/\/192\.0\.2\.1\s*\{/gm) || []).length === 1
);
check('Caddy skips automatic host trust-store changes', /^\s*skip_install_trust\s*$/m.test(activeCaddy));
check(
    'Caddy leaves localhost and vault.lan alternatives disabled',
    !/^localhost\s*\{/m.test(activeCaddy) && !/^https:\/\/vault\.lan\s*\{/m.test(activeCaddy)
);
check(
    'README prompts for and verifies the LXC IPv4 before Caddy starts',
    readme.includes("Enter this LXC's reserved IPv4 address") &&
        readme.includes('ip -4 -o address show scope global') &&
        readme.includes('s|^https://<LXC_IPV4> {|https://${VAULT_IP} {|')
);

console.log(`\n${'-'.repeat(58)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
