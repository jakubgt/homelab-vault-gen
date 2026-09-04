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
    const RANDOM_SEPARATOR_POOL = '!@#$%^&*-_=+';
    const randomWord = new Uint32Array(1);
    const wordlistCache = new WeakMap();

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
        if (charsets.length > 4) {
            throw new RangeError('At most four character sets are supported.');
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
        requireInteger(length, 1, 128, 'length');

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
        requireInteger(length, 1, 128, 'length');
        const sets = normalizeCharsets(charsets);
        if (length < sets.length || sets.length === 0) return 0;

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

    function requireInteger(value, min, max, name) {
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
        }
    }

    function normalizeOptions(options, defaults, booleanKeys) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('options must be an object.');
        }
        const normalized = { ...defaults, ...options };
        for (const key of booleanKeys) {
            if (typeof normalized[key] !== 'boolean') {
                throw new TypeError(`${key} must be a boolean.`);
            }
        }
        return normalized;
    }

    function getWordlist(words) {
        if (!Array.isArray(words) || words.length === 0 || words.length > UINT32_RANGE) {
            throw new RangeError('words must be a nonempty array.');
        }
        if (wordlistCache.has(words)) return wordlistCache.get(words);

        // Keep a private immutable snapshot so a cached validation cannot be
        // invalidated by a later mutation of the caller's array.
        const snapshot = Object.freeze(words.slice());
        const unique = new Set();
        for (const word of snapshot) {
            if (typeof word !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(word)) {
                throw new RangeError('Words must contain lowercase ASCII letters, with optional internal hyphens.');
            }
            if (unique.has(word)) throw new RangeError('Wordlist entries must be unique.');
            unique.add(word);
        }

        // A word followed by '-' must not be a prefix of another such codeword.
        // This guarantees unique word boundaries for fixed and random separators.
        const hyphenSafe = snapshot.every((word) => {
            for (let index = word.indexOf('-'); index !== -1; index = word.indexOf('-', index + 1)) {
                if (unique.has(word.slice(0, index))) return false;
            }
            return true;
        });
        const result = Object.freeze({ words: snapshot, hyphenSafe });
        wordlistCache.set(words, result);
        return result;
    }

    function normalizePassphraseOptions(options = {}) {
        const settings = normalizeOptions(options, {
            count: 6, separator: '-', capitalize: true, randomizeCaps: false,
            insertNumbers: false, numberCount: 2, randomizePositions: true
        }, ['capitalize', 'randomizeCaps', 'insertNumbers', 'randomizePositions']);
        requireInteger(settings.count, 3, 20, 'count');
        requireInteger(settings.numberCount, 1, 10, 'numberCount');
        if (!['-', '_', '.', ' ', 'random'].includes(settings.separator)) {
            throw new RangeError('Unsupported passphrase separator.');
        }
        return settings;
    }

    function passphraseWordlist(settings, words) {
        const list = getWordlist(words);
        if ((settings.separator === '-' || settings.separator === 'random') && !list.hyphenSafe) {
            throw new RangeError('Wordlist entries must be unambiguous with hyphen separators.');
        }
        return list.words;
    }

    function writeWord(output, offset, word, capitalize) {
        for (let index = 0; index < word.length; index++) {
            output[offset++] = word.charCodeAt(index) - (capitalize && index === 0 ? 32 : 0);
        }
        return offset;
    }

    function generatePassphraseBytes(options, words, randomInt = getSecureRandomInt) {
        const settings = normalizePassphraseOptions(options);
        const list = passphraseWordlist(settings, words);
        const indices = new Uint32Array(settings.count);
        const capitals = new Uint8Array(settings.count);
        let totalLength = settings.count - 1;

        for (let index = 0; index < settings.count; index++) {
            indices[index] = randomInt(list.length);
            totalLength += list[indices[index]].length;
            capitals[index] = settings.capitalize && (!settings.randomizeCaps || randomInt(2) === 1);
        }
        if (settings.insertNumbers) {
            totalLength += settings.numberCount * (settings.randomizePositions ? 1 : settings.count);
        }

        const output = new Uint8Array(totalLength);
        let offset = 0;
        for (let index = 0; index < settings.count; index++) {
            offset = writeWord(output, offset, list[indices[index]], capitals[index]);
            if (settings.insertNumbers && !settings.randomizePositions) {
                for (let digit = 0; digit < settings.numberCount; digit++) {
                    output[offset++] = 48 + randomInt(10);
                }
            }
            if (index < settings.count - 1) {
                output[offset++] = settings.separator === 'random'
                    ? RANDOM_SEPARATOR_POOL.charCodeAt(randomInt(RANDOM_SEPARATOR_POOL.length))
                    : settings.separator.charCodeAt(0);
            }
        }
        indices.fill(0);
        capitals.fill(0);

        if (settings.insertNumbers && settings.randomizePositions) {
            for (let digit = 0; digit < settings.numberCount; digit++) {
                const target = randomInt(offset + 1);
                output.copyWithin(target + 1, target, offset);
                output[target] = 48 + randomInt(10);
                offset++;
            }
        }
        return output;
    }

    function calculatePassphraseEntropy(options, words) {
        const settings = normalizePassphraseOptions(options);
        const list = passphraseWordlist(settings, words);
        let entropy = settings.count * Math.log2(list.length);
        if (settings.capitalize && settings.randomizeCaps) entropy += settings.count;
        if (settings.separator === 'random') {
            entropy += (settings.count - 1) * Math.log2(RANDOM_SEPARATOR_POOL.length);
        }
        if (settings.insertNumbers) {
            // Do not credit random insertion positions: different insertion
            // histories can lead to the same output. Digit values remain random.
            entropy += settings.numberCount * (settings.randomizePositions ? 1 : settings.count) * Math.log2(10);
        }
        return entropy;
    }

    function generateUsernameBytes(options, words, randomInt = getSecureRandomInt) {
        const settings = normalizeOptions(options === undefined ? {} : options, {
            count: 2, separator: '', appendNumbers: true, numberCount: 3, lowercase: false
        }, ['appendNumbers', 'lowercase']);
        requireInteger(settings.count, 1, 10, 'count');
        requireInteger(settings.numberCount, 1, 9, 'numberCount');
        if (!['', '-', '_', '.'].includes(settings.separator)) {
            throw new RangeError('Unsupported username separator.');
        }
        const list = getWordlist(words).words;
        const indices = new Uint32Array(settings.count);
        let totalLength = settings.separator.length * (settings.count - 1);
        for (let index = 0; index < settings.count; index++) {
            indices[index] = randomInt(list.length);
            totalLength += list[indices[index]].length;
        }
        if (settings.appendNumbers) totalLength += settings.numberCount + settings.separator.length;

        const output = new Uint8Array(totalLength);
        let offset = 0;
        for (let index = 0; index < settings.count; index++) {
            offset = writeWord(output, offset, list[indices[index]], !settings.lowercase);
            if (index < settings.count - 1 && settings.separator) {
                output[offset++] = settings.separator.charCodeAt(0);
            }
        }
        indices.fill(0);
        if (settings.appendNumbers) {
            if (settings.separator) output[offset++] = settings.separator.charCodeAt(0);
            for (let digit = 0; digit < settings.numberCount; digit++) {
                output[offset++] = 48 + randomInt(10);
            }
        }
        return output;
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
        RANDOM_SEPARATOR_POOL,
        calculatePassphraseEntropy,
        calculatePasswordEntropy,
        generatePassphraseBytes,
        generatePasswordBytes,
        generateUsernameBytes,
        getSecureRandomInt,
        normalizeSymbolPool,
        parsePattern,
        uniqueChars
    });
}));
