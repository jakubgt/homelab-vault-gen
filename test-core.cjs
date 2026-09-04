'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const core = require('./core.js');

const words = ['alpha', 'bravo', 'charlie', 'delta'];
const decode = (bytes) => new TextDecoder().decode(bytes);
const phrase = { count: 3 };

function sequence(values) {
    let cursor = 0;
    const draw = (max) => {
        assert.ok(cursor < values.length, `Unexpected random draw with max=${max}`);
        const value = values[cursor++];
        assert.ok(Number.isInteger(value) && value >= 0 && value < max, `${value} must be in [0, ${max})`);
        return value;
    };
    draw.done = () => assert.equal(cursor, values.length, 'All expected random draws were consumed');
    return draw;
}

function generated(generate, options, expected, values, dictionary = words) {
    const random = sequence(values);
    const bytes = generate(options, dictionary, random);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(decode(bytes), expected);
    assert.equal(bytes.length, expected.length);
    assert.ok(!bytes.includes(0), 'No unwritten byte remains in the output');
    random.done();
}

test('password rejection discards the entire invalid candidate', () => {
    const random = sequence([0, 0, 1, 2]);
    assert.equal(decode(core.generatePasswordBytes(2, ['ab', '1'], random)), 'b1');
    random.done();
});

test('password entropy matches an independently enumerated small output space', () => {
    for (const sets of [['ab'], ['ab', '1'], ['ab', '1', '!'], ['a', 'b', '1', '!']]) {
        const pool = sets.join('');
        for (let length = sets.length; length <= 5; length++) {
            let accepted = 0;
            function enumerate(prefix) {
                if (prefix.length === length) {
                    if (sets.every((set) => [...prefix].some((char) => set.includes(char)))) accepted++;
                    return;
                }
                for (const char of pool) enumerate(prefix + char);
            }
            enumerate('');
            assert.ok(Math.abs(core.calculatePasswordEntropy(length, sets) - Math.log2(accepted)) < 1e-10);
        }
    }
});

test('password API explicitly bounds both generation and entropy', () => {
    for (const value of [0, -1, 129, 158, 170, 200, NaN, Infinity, 2.5, '24']) {
        assert.throws(() => core.generatePasswordBytes(value, ['ab']), RangeError);
        assert.throws(() => core.calculatePasswordEntropy(value, ['ab']), RangeError);
    }
    for (const count of [5, 31, 32]) {
        const sets = Array.from({ length: count }, (_, index) => String.fromCharCode(33 + index));
        assert.throws(() => core.generatePasswordBytes(32, sets), RangeError);
        assert.throws(() => core.calculatePasswordEntropy(32, sets), RangeError);
    }
    assert.equal(core.generatePasswordBytes(1, ['a']).length, 1);
    assert.equal(core.generatePasswordBytes(128, ['a']).length, 128);
    assert.equal(core.generatePasswordBytes(1, ['a', 'b']), null);
    assert.equal(core.calculatePasswordEntropy(1, ['a', 'b']), 0);
    const sets = [core.CHARS.upper, core.CHARS.lower, core.CHARS.nums, core.DEFAULT_SYMS];
    assert.ok(Number.isFinite(core.calculatePasswordEntropy(128, sets)));
});

test('random integer accepts inclusive maximum bound and rejects invalid sources', () => {
    const crypto = { getRandomValues: (target) => { target[0] = 0xffffffff; return target; } };
    assert.equal(core.getSecureRandomInt(0x100000000, crypto), 0xffffffff);
    for (const max of [NaN, Infinity, -1, 1.5, '2']) {
        assert.throws(() => core.getSecureRandomInt(max, crypto), RangeError);
    }
    assert.throws(() => core.getSecureRandomInt(2, null));
});

test('passphrases preserve title capitalization and every fixed separator', () => {
    for (const separator of ['-', '_', '.', ' ']) {
        generated(core.generatePassphraseBytes, { ...phrase, separator }, ['Alpha', 'Bravo', 'Charlie'].join(separator), [0, 1, 2]);
    }
});

test('random capitalization draws one independent bit per word only when enabled', () => {
    generated(core.generatePassphraseBytes, { ...phrase, randomizeCaps: true }, 'alpha-Bravo-charlie', [0, 0, 1, 1, 2, 0]);
    generated(core.generatePassphraseBytes, { ...phrase, capitalize: false, randomizeCaps: true }, 'alpha-bravo-charlie', [0, 1, 2]);
});

test('random passphrase separators are drawn independently', () => {
    generated(core.generatePassphraseBytes, { ...phrase, capitalize: false, separator: 'random' }, 'alpha!bravo+charlie', [0, 1, 2, 0, 11]);
});

test('fixed passphrase digits follow every word and preserve leading zeros', () => {
    generated(core.generatePassphraseBytes, { ...phrase, insertNumbers: true, numberCount: 2, randomizePositions: false },
        'Alpha09-Bravo18-Charlie27', [0, 1, 2, 0, 9, 1, 8, 2, 7]);
});

test('random digit insertion covers start, end, and overlapping shifts', () => {
    const options = { ...phrase, capitalize: false, insertNumbers: true, randomizePositions: true };
    generated(core.generatePassphraseBytes, { ...options, numberCount: 2 }, '7a-b-a3', [0, 1, 0, 0, 7, 6, 3], ['a', 'b']);
    generated(core.generatePassphraseBytes, { ...options, numberCount: 3 }, 'a89-b-a7', [0, 1, 0, 1, 9, 1, 8, 7, 7], ['a', 'b']);
});

test('passphrase entropy credits only enabled random choices', () => {
    const entropy = (options) => core.calculatePassphraseEntropy({ ...phrase, ...options }, words);
    assert.equal(entropy({}), 6);
    assert.equal(entropy({ capitalize: false, randomizeCaps: true }), 6);
    assert.equal(entropy({ capitalize: true, randomizeCaps: true }), 9);
    assert.equal(entropy({ separator: 'random' }), 6 + 2 * Math.log2(core.RANDOM_SEPARATOR_POOL.length));
    assert.equal(entropy({ insertNumbers: true, numberCount: 2, randomizePositions: false }), 6 + 6 * Math.log2(10));
    assert.equal(entropy({ insertNumbers: true, numberCount: 2, randomizePositions: true }), 6 + 2 * Math.log2(10));
    assert.equal(entropy({ insertNumbers: false, numberCount: 10, randomizePositions: false }), 6);
});

test('wordlist validation rejects malformed and duplicate entries', () => {
    for (const dictionary of [[], ['a', 'a'], ['A'], ['é'], ['a b'], ['a1'], ['-a'], ['a-'], ['a--b'], [null], [1]]) {
        assert.throws(() => core.generatePassphraseBytes(phrase, dictionary, () => 0), RangeError);
        assert.throws(() => core.calculatePassphraseEntropy(phrase, dictionary), RangeError);
        assert.throws(() => core.generateUsernameBytes({}, dictionary, () => 0), RangeError);
    }
    assert.throws(() => core.generatePassphraseBytes(phrase, 'not an array'), RangeError);
});

test('hyphen ambiguity is rejected for hyphen and random passphrase separators', () => {
    const dictionary = ['a', 'a-b', 'b'];
    for (const separator of ['-', 'random']) {
        const options = { ...phrase, separator };
        assert.throws(() => core.generatePassphraseBytes(options, dictionary), /unambiguous/);
        assert.throws(() => core.calculatePassphraseEntropy(options, dictionary), /unambiguous/);
    }
    generated(core.generatePassphraseBytes, { ...phrase, separator: '_' }, 'A_A-b_B', [0, 1, 2], dictionary);
});

test('the vendored EFF list remains uniquely decodable with every supported separator', () => {
    const source = fs.readFileSync(path.join(__dirname, 'words.js'), 'utf8');
    const dictionary = vm.runInNewContext(`${source}\nWORDS;`);
    const membership = new Set(dictionary);
    assert.equal(dictionary.length, 7776);
    for (const word of dictionary) {
        for (let index = word.indexOf('-'); index !== -1; index = word.indexOf('-', index + 1)) {
            assert.ok(!membership.has(word.slice(0, index)), `Ambiguous hyphen boundary in ${word}`);
        }
    }
    assert.equal(core.calculatePassphraseEntropy({ count: 6 }, dictionary), 6 * Math.log2(7776));
    const hyphenIndex = dictionary.indexOf('drop-down');
    const random = sequence([hyphenIndex, hyphenIndex, hyphenIndex]);
    assert.equal(decode(core.generatePassphraseBytes({ count: 3, capitalize: false }, dictionary, random)), 'drop-down-drop-down-drop-down');
    random.done();
});

test('cached wordlist validation uses a private snapshot', () => {
    const dictionary = ['alpha', 'bravo'];
    generated(core.generateUsernameBytes, { count: 1, appendNumbers: false }, 'Alpha', [0], dictionary);
    dictionary[0] = 'bravo';
    dictionary.push('é');
    generated(core.generateUsernameBytes, { count: 1, appendNumbers: false }, 'Alpha', [0], dictionary);
    assert.equal(core.calculatePassphraseEntropy(phrase, dictionary), 3);
});

test('username separators, casing, digits, and no-suffix mode preserve exact output', () => {
    generated(core.generateUsernameBytes, { separator: '_' }, 'Alpha_Bravo_049', [0, 1, 0, 4, 9]);
    generated(core.generateUsernameBytes, { separator: '_', lowercase: true }, 'alpha_bravo_049', [0, 1, 0, 4, 9]);
    generated(core.generateUsernameBytes, {}, 'AlphaBravo123', [0, 1, 1, 2, 3]);
    generated(core.generateUsernameBytes, { count: 1, separator: '.', appendNumbers: false, lowercase: true }, 'alpha', [0]);
    generated(core.generateUsernameBytes, { separator: '-', appendNumbers: false }, 'Alpha-Bravo', [0, 1]);
});

test('passphrase and username options enforce integer bounds and known separators', () => {
    for (const options of [null, [], 'invalid']) {
        assert.throws(() => core.generatePassphraseBytes(options, words), TypeError);
        assert.throws(() => core.calculatePassphraseEntropy(options, words), TypeError);
        assert.throws(() => core.generateUsernameBytes(options, words), TypeError);
    }
    for (const count of [2, 21, NaN, Infinity, 3.5, '6']) {
        assert.throws(() => core.generatePassphraseBytes({ count }, words), RangeError);
        assert.throws(() => core.calculatePassphraseEntropy({ count }, words), RangeError);
    }
    for (const count of [0, 11, NaN, Infinity, 1.5, '2']) {
        assert.throws(() => core.generateUsernameBytes({ count }, words), RangeError);
    }
    for (const numberCount of [0, 11, NaN, Infinity, 1.5, '2']) {
        assert.throws(() => core.generatePassphraseBytes({ numberCount }, words), RangeError);
        assert.throws(() => core.calculatePassphraseEntropy({ numberCount }, words), RangeError);
    }
    for (const numberCount of [0, 10, NaN, Infinity, 1.5, '2']) {
        assert.throws(() => core.generateUsernameBytes({ numberCount }, words), RangeError);
    }
    for (const separator of ['', ':', '🙂', '__']) {
        assert.throws(() => core.generatePassphraseBytes({ separator }, words), RangeError);
        assert.throws(() => core.calculatePassphraseEntropy({ separator }, words), RangeError);
    }
    for (const separator of [' ', ':', 'random', '__']) {
        assert.throws(() => core.generateUsernameBytes({ separator }, words), RangeError);
    }
    assert.throws(() => core.generatePassphraseBytes({ capitalize: 'false' }, words), TypeError);
    assert.throws(() => core.generateUsernameBytes({ lowercase: 'true' }, words), TypeError);
});

test('maximum word and digit settings produce complete bounded output', () => {
    const passOptions = { count: 20, insertNumbers: true, randomizePositions: false, numberCount: 10 };
    assert.equal(decode(core.generatePassphraseBytes(passOptions, ['a'], () => 0)), Array(20).fill('A0000000000').join('-'));
    const userOptions = { count: 10, appendNumbers: true, numberCount: 9, separator: '.', lowercase: true };
    assert.equal(decode(core.generateUsernameBytes(userOptions, ['a'], () => 0)), `${Array(10).fill('a').join('.')}.000000000`);
});
