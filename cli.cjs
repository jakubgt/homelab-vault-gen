#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const core = require('./core.js');

const HELP = `Homelab Vault — dependency-free local credential generation (Node.js 22+)

Usage: node cli.cjs [password|passphrase|username|pattern|raw] [options]

Common:     --count N          1–1000 results, one exact value per line (default 1)
Password:   --length N         4–128 characters (default 24)
            --no-symbols       Uppercase, lowercase, and digits only
            --config-friendly  Use ._-+= as the symbol pool
Passphrase: --words N          3–20 EFF words (default 6)
            --separator CHAR   One of - _ . or space (default -)
Username:   --words N          1–10 EFF words (default 2)
            --digits N         1–9 suffix digits (default 3)
            --lowercase        Lowercase words
            --separator CHAR   One of - _ . or empty (default empty)
Pattern:    --template VALUE   Printable-ASCII generation template, max 512 characters
            --template-stdin   Read that template from stdin instead
Raw:        --bytes N          32 or 64 random bytes (default 32)
            --encoding FORMAT  hex, base64, or base64url (default hex)
Other:      --help             Show this help
            --version          Show the source package version

Output is plaintext. Redirect or pipe it only to a destination you trust.
Templates describe generation rules; never put an existing secret in an argument.
No credentials are stored, copied to the clipboard, or sent over the network.
`;

function fail(message) { throw new Error(message); }

function integer(value, name, min, max) {
    if (!/^[1-9][0-9]*$/.test(value || '')) fail(`${name} must be an integer from ${min} to ${max}.`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${name} must be an integer from ${min} to ${max}.`);
    return number;
}

function parse(argv) {
    if (argv.length === 1 && argv[0] === '--help') return { help: true };
    if (argv.length === 1 && argv[0] === '--version') return { version: true };
    const input = [...argv];
    const mode = input[0] && !input[0].startsWith('--') ? input.shift() : 'password';
    if (!['password', 'passphrase', 'username', 'pattern', 'raw'].includes(mode)) fail('Unknown generation mode. Use --help for usage.');
    const allowed = {
        password: ['--length', '--no-symbols', '--config-friendly'],
        passphrase: ['--words', '--separator'],
        username: ['--words', '--digits', '--separator', '--lowercase'],
        pattern: ['--template', '--template-stdin'],
        raw: ['--bytes', '--encoding']
    };
    const flags = new Set(['--no-symbols', '--config-friendly', '--lowercase', '--template-stdin']);
    const options = { mode, count: 1 };
    const seen = new Set();
    while (input.length) {
        const flag = input.shift();
        if (flag !== '--count' && !allowed[mode].includes(flag)) fail('Unknown option for this mode. Use --help for usage.');
        if (seen.has(flag)) fail('Duplicate options are not allowed.');
        seen.add(flag);
        if (flags.has(flag)) options[flag.slice(2)] = true;
        else {
            if (!input.length || input[0].startsWith('--')) fail('An option is missing its value.');
            options[flag.slice(2)] = input.shift();
        }
    }
    options.count = integer(String(options.count), '--count', 1, 1000);
    if (mode === 'password') {
        options.length = integer(options.length ?? '24', '--length', 4, 128);
        if (options['no-symbols'] && options['config-friendly']) fail('Choose either --no-symbols or --config-friendly.');
    } else if (mode === 'passphrase' || mode === 'username') {
        options.words = integer(options.words ?? (mode === 'passphrase' ? '6' : '2'), '--words', mode === 'passphrase' ? 3 : 1, mode === 'passphrase' ? 20 : 10);
        options.separator = options.separator === undefined ? (mode === 'passphrase' ? '-' : '') : options.separator;
        const choices = mode === 'passphrase' ? ['-', '_', '.', ' '] : ['', '-', '_', '.'];
        if (!choices.includes(options.separator)) fail('Unsupported separator. Use --help for allowed values.');
        if (mode === 'username') options.digits = integer(options.digits ?? '3', '--digits', 1, 9);
    } else if (mode === 'raw') {
        options.bytes = integer(options.bytes ?? '32', '--bytes', 32, 64);
        if (![32, 64].includes(options.bytes)) fail('--bytes must be 32 or 64.');
        options.encoding = options.encoding ?? 'hex';
        if (!['hex', 'base64', 'base64url'].includes(options.encoding)) fail('--encoding must be hex, base64, or base64url.');
    } else if (Boolean(options.template) === Boolean(options['template-stdin'])) {
        fail('Pattern mode requires exactly one of --template or --template-stdin.');
    }
    return options;
}

function loadWords() {
    const source = fs.readFileSync(path.join(__dirname, 'words.js'), 'utf8').trim();
    // Parse only the vendored data declaration; never evaluate JavaScript.
    const match = /^const WORDS = (\[(?:\s*'[a-z-]+'\s*,?)*\]);$/.exec(source);
    if (!match) fail('The bundled EFF wordlist is not in its expected data format.');
    const words = JSON.parse(match[1].replace(/'/g, '"'));
    if (words.length !== 7776 || new Set(words).size !== 7776) fail('The bundled EFF wordlist is incomplete.');
    return words;
}

async function readTemplate(stream) {
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
        length += chunk.length;
        if (length > 514) fail('The template exceeds the 512-character limit.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function generator(options, words) {
    if (options.mode === 'password') {
        const sets = [core.CHARS.upper, core.CHARS.lower, core.CHARS.nums];
        if (!options['no-symbols']) sets.push(options['config-friendly'] ? core.CONFIG_FRIENDLY_SYMS : core.DEFAULT_SYMS);
        return () => core.generatePasswordBytes(options.length, sets);
    }
    if (options.mode === 'passphrase') return () => core.generatePassphraseBytes({ count: options.words, separator: options.separator }, words);
    if (options.mode === 'username') return () => core.generateUsernameBytes({ count: options.words, separator: options.separator, numberCount: options.digits, lowercase: Boolean(options.lowercase) }, words);
    if (options.mode === 'raw') return () => core.generateRawSecretBytes({ byteLength: options.bytes, encoding: options.encoding });
    const parsed = core.parsePattern(options.template);
    if (parsed.error) fail('The template is invalid. Check the documented pattern syntax.');
    return () => {
        const bytes = new Uint8Array(parsed.totalLength);
        let offset = 0;
        for (const token of parsed.tokens) {
            for (let index = 0; index < token.count; index++) bytes[offset++] = token.pool.charCodeAt(core.getSecureRandomInt(token.pool.length));
        }
        return bytes;
    };
}

async function main(argv, stdin = process.stdin, stdout = process.stdout) {
    const options = parse(argv);
    if (options.help) { stdout.write(HELP); return; }
    if (options.version) {
        const source = fs.readFileSync(path.join(__dirname, 'version.js'), 'utf8');
        const match = /\bversion:\s*['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/.exec(source);
        if (!match) fail('The bundled version metadata is invalid.');
        stdout.write(match[1] + '\n');
        return;
    }
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') fail('Node.js 22 or newer with Web Crypto support is required.');
    if (options['template-stdin']) options.template = await readTemplate(stdin);
    const words = ['passphrase', 'username'].includes(options.mode) ? loadWords() : null;
    const generate = generator(options, words);
    let total = 0;
    for (let index = 0; index < options.count; index++) {
        const bytes = generate();
        if (!(bytes instanceof Uint8Array)) fail('Generation failed.');
        try {
            total += bytes.length + 1;
            if (total > 1024 * 1024) fail('Output exceeds the 1 MiB limit.');
            // Copy before wiping the working buffer: a pipe may flush asynchronously.
            const line = Buffer.alloc(bytes.length + 1);
            line.set(bytes);
            line[line.length - 1] = 10;
            if (!stdout.write(line)) await once(stdout, 'drain');
        } finally { bytes.fill(0); }
    }
}

if (require.main === module) {
    process.stdout.on('error', error => {
        if (error.code === 'EPIPE') process.exit(0);
        process.stderr.write('Unable to write credential output.\n');
        process.exit(1);
    });
    main(process.argv.slice(2)).catch(error => {
        // Controlled messages omit user-supplied templates and generated output.
        process.stderr.write(`Homelab Vault: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main, parse, loadWords };
