'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const cli = path.join(__dirname, '..', 'cli.cjs');

function run(args, input) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, maxBuffer: 2 * 1024 * 1024, timeout: 15000 });
}

function values(args, count = 1, input) {
    const result = run(args, input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'));
    const lines = result.stdout.slice(0, -1).split('\n');
    assert.equal(lines.length, count);
    return lines;
}

test('default password subprocess writes only exact output with class guarantees', () => {
    const [password] = values([]);
    assert.equal(password.length, 24);
    for (const expression of [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/]) assert.match(password, expression);
});

test('password options preserve requested output count and pools', () => {
    for (const password of values(['password', '--length', '32', '--no-symbols', '--count', '10'], 10)) {
        assert.match(password, /^[A-Za-z0-9]{32}$/);
    }
    for (const password of values(['password', '--config-friendly', '--count', '10'], 10)) {
        assert.match(password, /^[A-Za-z0-9._+=-]{24}$/);
        assert.match(password, /[._+=-]/);
    }
});

test('word-based modes load the bundled data without package dependencies', () => {
    const [passphrase] = values(['passphrase', '--words', '6', '--separator', ' ']);
    assert.match(passphrase, /^(?:[A-Z][a-z-]* ){5}[A-Z][a-z-]*$/);
    const [username] = values(['username', '--words', '2', '--lowercase', '--separator', '.', '--digits', '4']);
    assert.match(username, /^[a-z-]+\.[a-z-]+\.[0-9]{4}$/);
});

test('pattern mode supports argument and bounded stdin templates', () => {
    assert.match(values(['pattern', '--template', '[A-Z]{3}-[0-9]{4}'])[0], /^[A-Z]{3}-[0-9]{4}$/);
    assert.match(values(['pattern', '--template-stdin'], 1, '[a-z]{8}\r\n')[0], /^[a-z]{8}$/);
    assert.equal(values(['pattern', '--template', 'literal'])[0], 'literal');
});

test('raw encodings decode to exactly the requested random-byte count', () => {
    for (const size of [32, 64]) {
        for (const encoding of ['hex', 'base64', 'base64url']) {
            const [value] = values(['raw', '--bytes', String(size), '--encoding', encoding]);
            assert.equal(Buffer.from(value, encoding).length, size);
            assert.equal(Buffer.from(value, encoding).toString(encoding), value);
        }
    }
});

test('invalid options fail without printing any generated credential or template', () => {
    const cases = [
        ['unknown'], ['--count', '0'], ['--count', '1001'], ['--count', '1e2'],
        ['--length', '3'], ['--length', '129'], ['--length', ''], ['--length'],
        ['--no-symbols', '--config-friendly'], ['--count', '2', '--count', '3'],
        ['raw', '--bytes', '48'], ['raw', '--bytes', ''], ['raw', '--encoding', ''],
        ['passphrase', '--words', ''], ['username', '--digits', ''], ['username', '--encoding', 'hex'],
        ['pattern'], ['pattern', '--template', 'DO-NOT-ECHO-THIS['],
        ['pattern', '--template', '[a]{1001}'], ['pattern', '--template', 'x', '--template-stdin']
    ];
    for (const args of cases) {
        const result = run(args);
        assert.equal(result.status, 1, args.join(' '));
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Homelab Vault: /);
        assert.ok(!result.stderr.includes('DO-NOT-ECHO-THIS'));
    }
    const oversized = run(['pattern', '--template-stdin'], 'SECRET' + 'x'.repeat(600));
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stdout, '');
    assert.ok(!oversized.stderr.includes('SECRET'));
});

test('maximum count remains bounded and each output is a complete line', () => {
    const lines = values(['pattern', '--template', '[0-9]{1000}', '--count', '1000'], 1000);
    assert.ok(lines.every(line => /^[0-9]{1000}$/.test(line)));
});

test('help/version are explicit and version works in the offline runtime layout', () => {
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Homelab Vault/);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cli-'));
    try {
        for (const name of ['cli.cjs', 'core.js', 'words.js', 'version.js']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(temporary, name));
        const version = spawnSync(process.execPath, [path.join(temporary, 'cli.cjs'), '--version'], { encoding: 'utf8' });
        assert.equal(version.status, 0, version.stderr);
        assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
        assert.ok(!fs.existsSync(path.join(temporary, 'package.json')));
    } finally {
        assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(temporary).startsWith('vault-cli-'));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});
