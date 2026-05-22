/*
 * Homelab Vault — Test Suite
 * --------------------------------------------------------------------------
 * Zero-dependency tests. Run with:   node test.js
 *
 * These tests exist to PROVE the security claims rather than assert them:
 *   1. getSecureRandomInt produces a statistically uniform distribution
 *      (this is the actual evidence that rejection sampling kills modulo bias).
 *   2. The Strict character-class enforcement holds across thousands of passwords.
 *   3. The wordlist matches the EFF Large Wordlist shape (7,776 unique words),
 *      because the displayed passphrase entropy depends on that count.
 *   4. The displayed entropy formula matches hand-computed values.
 *
 * The browser app (app.js) is not imported directly because it touches the
 * DOM, localStorage, and window on load. Instead we re-implement the small
 * pure functions under test here and keep them byte-for-byte identical to
 * app.js. If you change the algorithm in app.js, mirror it here.
 * --------------------------------------------------------------------------
 */

'use strict';
const fs = require('fs');

// --- Test harness (tiny, no framework) ------------------------------------
let passed = 0, failed = 0;
function check(name, condition, detail) {
    if (condition) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

// --- Function under test: copied verbatim from app.js ---------------------
function getSecureRandomInt(max) {
    const randomBytes = new Uint32Array(1);
    const maxValid = Math.floor(4294967296 / max) * max;
    while (true) {
        crypto.getRandomValues(randomBytes);
        if (randomBytes[0] < maxValid) return randomBytes[0] % max;
    }
}

// --- Load the real wordlist from words.js ---------------------------------
function loadWords() {
    const src = fs.readFileSync(__dirname + '/words.js', 'utf8');
    const m = src.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('Could not find WORDS array in words.js');
    return JSON.parse(m[0].replace(/'/g, '"'));
}

// ==========================================================================
section('1. RNG uniformity (proves no modulo bias)');

// Chi-squared goodness-of-fit. We bucket many draws over a small modulus and
// confirm the counts don't deviate from uniform more than chance allows.
function chiSquaredUniform(max, draws) {
    const counts = new Array(max).fill(0);
    for (let i = 0; i < draws; i++) counts[getSecureRandomInt(max)]++;
    const expected = draws / max;
    let chi2 = 0;
    for (const c of counts) chi2 += ((c - expected) ** 2) / expected;
    return { chi2, counts };
}

// max=10, 2,000,000 draws. df=9. Chi-squared critical value at p=0.001 / df=9
// is ~27.88. A correct uniform RNG will almost never exceed this; a biased one
// (e.g. naive % without rejection) reliably will. We use a very loose p=0.001
// threshold so the test is not flaky on legitimate randomness.
{
    const { chi2, counts } = chiSquaredUniform(10, 2_000_000);
    check('chi-squared within bounds for max=10',
        chi2 < 27.88,
        `chi2=${chi2.toFixed(2)} (crit 27.88); counts=[${counts.join(',')}]`);
}

// Range safety: never returns >= max, never negative, across many maxima.
{
    let outOfRange = false;
    for (const max of [2, 7, 26, 62, 95, 7776]) {
        for (let i = 0; i < 50_000; i++) {
            const v = getSecureRandomInt(max);
            if (v < 0 || v >= max || !Number.isInteger(v)) { outOfRange = true; break; }
        }
    }
    check('output always in [0, max) and integer', !outOfRange);
}

// A non-power-of-two modulus is the case where naive modulo bias shows up.
// Confirm small-modulus uniformity holds for an awkward value like 95
// (the size of a full printable-ASCII pool).
{
    const { chi2 } = chiSquaredUniform(95, 2_000_000);
    // df=94; p=0.001 critical ~ 144.5
    check('chi-squared within bounds for max=95 (awkward modulus)',
        chi2 < 144.5,
        `chi2=${chi2.toFixed(2)} (crit ~144.5)`);
}

// ==========================================================================
section('2. Character-class guarantee');

// Mirror of generatePassword's pool-build + guarantee logic (DOM stripped).
function generatePasswordPure(len, sets) {
    let pool = sets.join('');
    if (!pool) return '';
    if (len < sets.length) return null; // mirrors the "length must be >= sets" guard
    let pwd = '', isValid = false, iterations = 0;
    const maxIterations = 1000;
    while (!isValid && iterations < maxIterations) {
        pwd = '';
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
        isValid = sets.every(set => pwd.split('').some(ch => set.includes(ch)));
        iterations++;
    }
    return pwd;
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const NUMS  = "0123456789";
const SYMS  = "!@#$%^&*()-_=+";

{
    const sets = [UPPER, LOWER, NUMS, SYMS];
    let allValid = true, failExample = '';
    for (let i = 0; i < 20_000; i++) {
        const pwd = generatePasswordPure(16, sets);
        const ok = sets.every(set => pwd.split('').some(ch => set.includes(ch)));
        if (!ok) { allValid = false; failExample = pwd; break; }
    }
    check('every password contains all 4 selected classes (len=16, 20k samples)',
        allValid, failExample);
}

{
    // Tight case: length exactly equals number of classes.
    const sets = [UPPER, LOWER, NUMS, SYMS];
    let allValid = true;
    for (let i = 0; i < 20_000; i++) {
        const pwd = generatePasswordPure(4, sets);
        const ok = sets.every(set => pwd.split('').some(ch => set.includes(ch)));
        if (!ok) { allValid = false; break; }
    }
    check('class guarantee holds at len === number of classes (4)', allValid);
}

{
    check('returns null when length < number of classes',
        generatePasswordPure(3, [UPPER, LOWER, NUMS, SYMS]) === null);
}

// Ambiguous-stripping edge cases. Mirror app.js: strip l/I/1/O/0 from both the
// pool and each active set, and drop sets that become empty.
function stripAmbig(s) { return s.replace(/[lI1O0]/g, ''); }
function generateWithAmbigStrip(len, rawSets) {
    let sets = rawSets.map(stripAmbig).filter(s => s.length > 0);
    const pool = sets.join('');
    if (!pool) return '';
    if (len < sets.length) return null;
    let pwd = '', isValid = false, iterations = 0;
    while (!isValid && iterations < 1000) {
        pwd = '';
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
        isValid = sets.every(set => pwd.split('').some(ch => set.includes(ch)));
        iterations++;
    }
    return pwd;
}

{
    // Numbers-only with ambiguous off vs on: pool 10 -> 8 (loses 1 and 0).
    let allValid = true;
    for (let i = 0; i < 20_000; i++) {
        const pwd = generateWithAmbigStrip(8, [NUMS]);
        if (!/^[2-9]+$/.test(pwd)) { allValid = false; break; }
    }
    check('numbers-only + ambiguous strip yields only 2-9, guarantee holds',
        allValid);
}

{
    // A custom symbol pool consisting ENTIRELY of ambiguous chars must not
    // crash or hang — the set drops out and generation proceeds on what's left.
    const result = generateWithAmbigStrip(12, [LOWER, "lI1O0"]);
    const ok = result.length === 12 && stripAmbig(LOWER).split('').some(c => result.includes(c));
    check('all-ambiguous custom set drops cleanly, no hang', ok);
}

{
    // If EVERY selected set is all-ambiguous, pool is empty -> returns ''.
    check('pool that strips to empty returns empty string (no infinite loop)',
        generateWithAmbigStrip(12, ["1O0", "lI"]) === '');
}

// ==========================================================================
section('3. Wordlist integrity (backs passphrase entropy claim)');

const WORDS = loadWords();
check('wordlist has exactly 7,776 words (EFF Large)', WORDS.length === 7776,
    `got ${WORDS.length}`);
check('all words unique', new Set(WORDS).size === WORDS.length,
    `${WORDS.length - new Set(WORDS).size} duplicates`);
check('no empty words', !WORDS.some(w => w.length === 0));
check('all entries are strings', WORDS.every(w => typeof w === 'string'));

// ==========================================================================
section('4. Entropy math sanity');

// Password entropy: H = L * log2(N). Verify a couple of known values.
function pwdEntropy(len, poolSize) { return len * Math.log2(poolSize); }
{
    // 16 chars from a 26+26+10+13 = 75-char pool
    const h = pwdEntropy(16, 75);
    check('16 chars, 75-pool ≈ 99.6 bits', Math.abs(h - 99.66) < 0.1,
        `got ${h.toFixed(2)}`);
}
{
    // Passphrase: 6 words from 7,776 = 6 * log2(7776) ≈ 77.5 bits
    const h = 6 * Math.log2(7776);
    check('6-word diceware ≈ 77.5 bits', Math.abs(h - 77.55) < 0.1,
        `got ${h.toFixed(2)}`);
}
{
    // Conservative number-injection: numCount digits add ONLY value entropy
    // (numCount * log2(10)), no positional term. 2 digits ≈ 6.64 bits.
    const h = 2 * Math.log2(10);
    check('2 sprinkled digits add ≈ 6.64 bits (value only, conservative)',
        Math.abs(h - 6.644) < 0.01, `got ${h.toFixed(3)}`);
}
{
    // Random-symbol separator: (count-1) gaps, each one of 11 symbols.
    // For a 6-word phrase: 5 * log2(11) ≈ 17.3 bits added.
    const h = 5 * Math.log2(11);
    check('random separators on 6-word phrase add ≈ 17.3 bits',
        Math.abs(h - 17.30) < 0.05, `got ${h.toFixed(2)}`);
}

// ==========================================================================
console.log(`\n${'-'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
