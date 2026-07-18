(function (root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.VaultCore = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const UINT32_RANGE = 0x100000000;
    const CHARS = Object.freeze({
        upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        lower: 'abcdefghijklmnopqrstuvwxyz',
        nums: '0123456789'
    });
    const DEFAULT_SYMS = '!@#$%^&*()-_=+[]{};:,.<>/?|~';
    const CONFIG_FRIENDLY_SYMS = '._-+=';
    const randomWord = new Uint32Array(1);

    function uniqueChars(value) {
        return Array.from(new Set(Array.from(value))).join('');
    }

    function normalizeSymbolPool(value) {
        return uniqueChars(String(value))
            .split('')
            .filter((char) => /^[\x21-\x7e]$/.test(char) && !/[A-Za-z0-9]/.test(char))
            .join('');
    }

    function requireRandomSource(randomSource) {
        if (!randomSource || typeof randomSource.getRandomValues !== 'function') {
            throw new Error('A cryptographically secure random source is required.');
        }
    }

    function getSecureRandomInt(max, randomSource = globalThis.crypto) {
        if (!Number.isSafeInteger(max) || max < 1 || max > UINT32_RANGE) {
            throw new RangeError('max must be an integer between 1 and 2^32.');
        }

        requireRandomSource(randomSource);
        const limit = Math.floor(UINT32_RANGE / max) * max;

        do {
            randomSource.getRandomValues(randomWord);
        } while (randomWord[0] >= limit);

        return randomWord[0] % max;
    }

    function normalizeCharsets(charsets) {
        if (!Array.isArray(charsets)) {
            throw new TypeError('charsets must be an array.');
        }

        const seen = new Set();
        return charsets.map((rawSet) => {
            const set = uniqueChars(String(rawSet));
            if (!set || !/^[\x21-\x7e]+$/.test(set)) {
                throw new RangeError('Character sets must contain printable ASCII characters.');
            }

            for (const char of set) {
                if (seen.has(char)) {
                    throw new RangeError('Character sets must not overlap.');
                }
                seen.add(char);
            }
            return set;
        });
    }

    function generatePasswordBytes(length, charsets, randomInt = getSecureRandomInt) {
        if (!Number.isInteger(length) || length < 1) {
            throw new RangeError('length must be a positive integer.');
        }

        const sets = normalizeCharsets(charsets);
        if (sets.length === 0) return null;
        if (length < sets.length) return null;

        const pool = sets.join('');
        const setCodes = sets.map((set) => Uint8Array.from(set, (char) => char.charCodeAt(0)));
        const output = new Uint8Array(length);

        // Rejection sampling keeps every accepted password equally likely while
        // guaranteeing that each selected character class is represented.
        do {
            for (let index = 0; index < length; index++) {
                output[index] = pool.charCodeAt(randomInt(pool.length));
            }
        } while (!setCodes.every((set) => set.some((code) => output.includes(code))));

        return output;
    }

    function calculatePasswordEntropy(length, charsets) {
        const sets = normalizeCharsets(charsets);
        if (!Number.isInteger(length) || length < sets.length || sets.length === 0) return 0;

        const poolSize = sets.reduce((sum, set) => sum + set.length, 0);
        let validOutputs = 0;

        // Inclusion-exclusion counts the exact output space after enforcing one
        // character from every selected (disjoint) character class.
        for (let mask = 0; mask < (1 << sets.length); mask++) {
            let excludedSize = 0;
            let excludedSets = 0;

            for (let index = 0; index < sets.length; index++) {
                if (mask & (1 << index)) {
                    excludedSize += sets[index].length;
                    excludedSets++;
                }
            }

            const available = poolSize - excludedSize;
            const count = available === 0 ? 0 : Math.pow(available, length);
            validOutputs += excludedSets % 2 === 0 ? count : -count;
        }

        return validOutputs > 0 ? Math.log2(validOutputs) : 0;
    }

    function expandCharset(source) {
        let expanded = '';

        for (let index = 0; index < source.length; index++) {
            if (source[index + 1] === '-' && index + 2 < source.length) {
                const start = source.charCodeAt(index);
                const end = source.charCodeAt(index + 2);
                if (start > end) {
                    return { error: `Descending range ${source[index]}-${source[index + 2]} is not supported.` };
                }
                for (let code = start; code <= end; code++) expanded += String.fromCharCode(code);
                index += 2;
            } else {
                expanded += source[index];
            }
        }

        return { pool: uniqueChars(expanded) };
    }

    function parsePattern(pattern, maxOutputLength = 1000) {
        const source = String(pattern);
        if (!source) return { tokens: [], totalLength: 0, error: 'Enter a pattern.' };
        if (source.length > 512) return { tokens: [], totalLength: 0, error: 'Pattern is too long (max 512 input characters).' };
        if (!/^[\x20-\x7e]+$/.test(source)) {
            return { tokens: [], totalLength: 0, error: 'Patterns support printable ASCII characters only.' };
        }

        const tokens = [];
        let totalLength = 0;
        let index = 0;

        while (index < source.length) {
            let pool;
            const char = source[index];

            if (char === '[') {
                const closeIndex = source.indexOf(']', index + 1);
                if (closeIndex === -1) {
                    return { tokens: [], totalLength: 0, error: 'Character class is missing a closing bracket.' };
                }

                const classSource = source.slice(index + 1, closeIndex);
                if (!classSource) {
                    return { tokens: [], totalLength: 0, error: 'Character classes cannot be empty.' };
                }

                const expanded = expandCharset(classSource);
                if (expanded.error) return { tokens: [], totalLength: 0, error: expanded.error };
                pool = expanded.pool;
                index = closeIndex + 1;
            } else if (char === '\\') {
                if (index + 1 >= source.length) {
                    return { tokens: [], totalLength: 0, error: 'Pattern cannot end with an escape character.' };
                }
                pool = source[index + 1];
                index += 2;
            } else if ('][]{}'.includes(char)) {
                return { tokens: [], totalLength: 0, error: `Escape the literal character ${char} with a backslash.` };
            } else {
                pool = char;
                index++;
            }

            let count = 1;
            if (source[index] === '{') {
                const repeat = source.slice(index).match(/^\{(\d+)\}/);
                if (!repeat) {
                    return { tokens: [], totalLength: 0, error: 'Repetition must use a positive integer, such as {4}.' };
                }
                count = Number(repeat[1]);
                if (!Number.isSafeInteger(count) || count < 1) {
                    return { tokens: [], totalLength: 0, error: 'Repetition must be a positive integer.' };
                }
                index += repeat[0].length;
            }

            totalLength += count;
            if (totalLength > maxOutputLength) {
                return { tokens: [], totalLength, error: `Pattern output is too long (max ${maxOutputLength} characters).` };
            }
            tokens.push({ pool, count });
        }

        const entropy = tokens.reduce((sum, token) => (
            sum + (token.pool.length > 1 ? token.count * Math.log2(token.pool.length) : 0)
        ), 0);

        return { tokens, totalLength, entropy, error: null };
    }

    return Object.freeze({
        CHARS,
        DEFAULT_SYMS,
        CONFIG_FRIENDLY_SYMS,
        calculatePasswordEntropy,
        generatePasswordBytes,
        getSecureRandomInt,
        normalizeSymbolPool,
        parsePattern,
        uniqueChars
    });
}));
