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
    const DEFAULT_PATTERN = '[A-Z]{3}-[0-9]{4}-[a-z]{5}';
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

    function requireRawSecretOptions(settings) {
        if (![32, 64].includes(settings.byteLength)) {
            throw new RangeError('byteLength must be 32 or 64.');
        }
        if (!['hex', 'base64', 'base64url'].includes(settings.encoding)) {
            throw new RangeError('encoding must be hex, base64, or base64url.');
        }
    }

    function generateRawSecretBytes(options = {}, randomSource = globalThis.crypto) {
        const settings = normalizeOptions(options, { byteLength: 32, encoding: 'hex' }, []);
        requireRawSecretOptions(settings);
        requireRandomSource(randomSource);

        const raw = new Uint8Array(settings.byteLength);
        try {
            randomSource.getRandomValues(raw);
            if (settings.encoding === 'hex') {
                const alphabet = '0123456789abcdef';
                const output = new Uint8Array(raw.length * 2);
                for (let index = 0; index < raw.length; index++) {
                    output[index * 2] = alphabet.charCodeAt(raw[index] >>> 4);
                    output[index * 2 + 1] = alphabet.charCodeAt(raw[index] & 15);
                }
                return output;
            }

            const urlSafe = settings.encoding === 'base64url';
            const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' + (urlSafe ? '-_' : '+/');
            const output = new Uint8Array(urlSafe ? Math.ceil(raw.length * 4 / 3) : Math.ceil(raw.length / 3) * 4);
            let offset = 0;
            for (let index = 0; index < raw.length; index += 3) {
                const remaining = raw.length - index;
                const value = (raw[index] << 16) | ((raw[index + 1] || 0) << 8) | (raw[index + 2] || 0);
                output[offset++] = alphabet.charCodeAt((value >>> 18) & 63);
                output[offset++] = alphabet.charCodeAt((value >>> 12) & 63);
                if (remaining > 1) output[offset++] = alphabet.charCodeAt((value >>> 6) & 63);
                else if (!urlSafe) output[offset++] = 61;
                if (remaining > 2) output[offset++] = alphabet.charCodeAt(value & 63);
                else if (!urlSafe) output[offset++] = 61;
            }
            return output;
        } finally {
            // Keep the encoded working buffer for the caller's normal wipe path,
            // but do not retain an additional copy of the original random bytes.
            raw.fill(0);
        }
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
        return writePassphrase(settings, passphraseWordlist(settings, words), randomInt);
    }

    function writePassphrase(settings, list, randomInt, pickWord = () => randomInt(list.length)) {
        const indices = new Uint32Array(settings.count);
        const capitals = new Uint8Array(settings.count);
        let totalLength = settings.count - 1;

        for (let index = 0; index < settings.count; index++) {
            indices[index] = pickWord(index);
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
        return passphraseEntropyDetails(settings, list.length, settings.count * Math.log2(list.length)).entropy;
    }

    function normalizeUsernameOptions(options) {
        const settings = normalizeOptions(options === undefined ? {} : options, {
            count: 2, separator: '', appendNumbers: true, numberCount: 3, lowercase: false
        }, ['appendNumbers', 'lowercase']);
        requireInteger(settings.count, 1, 10, 'count');
        requireInteger(settings.numberCount, 1, 9, 'numberCount');
        if (!['', '-', '_', '.'].includes(settings.separator)) {
            throw new RangeError('Unsupported username separator.');
        }
        return settings;
    }

    function generateUsernameBytes(options, words, randomInt = getSecureRandomInt) {
        return writeUsername(normalizeUsernameOptions(options), getWordlist(words).words, randomInt);
    }

    function writeUsername(settings, list, randomInt, pickWord = () => randomInt(list.length)) {
        const indices = new Uint32Array(settings.count);
        let totalLength = settings.separator.length * (settings.count - 1);
        for (let index = 0; index < settings.count; index++) {
            indices[index] = pickWord(index);
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

    const PASSWORD_CLASSES = [
        ['upper', 'minUpper', CHARS.upper], ['lower', 'minLower', CHARS.lower],
        ['nums', 'minNums', CHARS.nums], ['syms', 'minSyms']
    ];
    const PROFILE_OPTIONS = Object.freeze({
        password: ['length', 'upper', 'lower', 'nums', 'syms', 'ambig', 'symbols', 'exclude',
            'minUpper', 'minLower', 'minNums', 'minSyms', 'maxLength'],
        passphrase: ['count', 'separator', 'capitalize', 'randomizeCaps', 'insertNumbers',
            'numberCount', 'randomizePositions', 'maxWordLength', 'maxLength'],
        username: ['count', 'separator', 'appendNumbers', 'numberCount', 'lowercase', 'maxLength'],
        pattern: ['template', 'maxLength'],
        raw: ['byteLength', 'encoding', 'maxLength']
    });

    function requireProfileKeys(object, allowed, label) {
        if (!object || typeof object !== 'object' || Array.isArray(object)) {
            throw new TypeError(`${label} must be an object.`);
        }
        for (const key of Object.keys(object)) {
            if (!allowed.includes(key)) throw new RangeError(`${label} contains an unsupported field.`);
        }
    }

    function normalizePasswordProfileOptions(options) {
        const settings = normalizeOptions(options, {
            length: 24, upper: true, lower: true, nums: true, syms: true, ambig: false,
            symbols: DEFAULT_SYMS, exclude: ''
        }, ['upper', 'lower', 'nums', 'syms', 'ambig']);
        requireInteger(settings.length, 4, 128, 'length');
        if (typeof settings.symbols !== 'string' || settings.symbols.length > 128) {
            throw new RangeError('Symbols must be a string of up to 128 characters.');
        }
        settings.symbols = normalizeSymbolPool(settings.symbols);
        if (settings.syms && !settings.symbols) {
            throw new RangeError('Add at least one printable ASCII symbol or turn off Symbols.');
        }
        if (typeof settings.exclude !== 'string' || !/^[\x21-\x7e]{0,94}$/.test(settings.exclude)) {
            throw new RangeError('Excluded characters must be printable ASCII without spaces.');
        }
        settings.exclude = uniqueChars(settings.exclude);
        for (const [enabled, minimum] of PASSWORD_CLASSES) {
            if (!Object.hasOwn(settings, minimum)) settings[minimum] = Number(settings[enabled]);
            requireInteger(settings[minimum], 0, 128, minimum);
            if (!settings[enabled] && settings[minimum] > 0) {
                throw new RangeError('Enable every character class with a positive minimum.');
            }
        }
        return settings;
    }

    function normalizeGenerationProfile(profile) {
        requireProfileKeys(profile, ['version', 'mode', 'options'], 'Profile');
        if (profile.version !== 1) throw new RangeError('Unsupported generation profile version.');
        if (typeof profile.mode !== 'string' || !Object.hasOwn(PROFILE_OPTIONS, profile.mode)) {
            throw new RangeError('Unsupported generation mode.');
        }
        const { mode, options } = profile;
        requireProfileKeys(options, PROFILE_OPTIONS[mode], 'Profile options');

        let settings;
        if (mode === 'password') settings = normalizePasswordProfileOptions(options);
        else if (mode === 'passphrase') {
            settings = normalizePassphraseOptions(options);
            settings.maxWordLength = options.maxWordLength ?? null;
            if (settings.maxWordLength !== null) requireInteger(settings.maxWordLength, 1, 512, 'maxWordLength');
        } else if (mode === 'username') settings = normalizeUsernameOptions(options);
        else if (mode === 'pattern') {
            settings = { template: Object.hasOwn(options, 'template') ? options.template : DEFAULT_PATTERN };
            if (typeof settings.template !== 'string' || settings.template.length > 512) {
                throw new RangeError('Pattern must be a string of up to 512 characters.');
            }
        } else {
            settings = normalizeOptions(options, { byteLength: 32, encoding: 'hex' }, []);
            requireRawSecretOptions(settings);
        }
        settings.maxLength = options.maxLength ?? null;
        if (settings.maxLength !== null) requireInteger(settings.maxLength, 1, 1000, 'maxLength');
        return Object.freeze({ version: 1, mode, options: Object.freeze(settings) });
    }

    function getPasswordProfileGroups(settings) {
        const groups = [];
        const excluded = settings.ambig ? settings.exclude + 'lI1O0' : settings.exclude;
        for (const [enabled, minimum, standardPool] of PASSWORD_CLASSES) {
            if (!settings[enabled]) continue;
            const pool = Array.from(standardPool ?? settings.symbols).filter((char) => !excluded.includes(char)).join('');
            if (pool) groups.push({ pool, minimum: settings[minimum] });
            else if (settings[minimum] > 0) throw new RangeError('A required character class has no allowed characters.');
        }
        if (!groups.length) throw new RangeError('Select at least one character set.');
        return groups;
    }

    function getPasswordProfileCharsets(options) {
        return getPasswordProfileGroups(normalizePasswordProfileOptions(options)).map(({ pool }) => pool);
    }

    function randomBigInt(max, randomInt) {
        if (max <= 1n) return 0n;
        if (max <= BigInt(UINT32_RANGE)) return BigInt(randomInt(Number(max)));
        const bits = (max - 1n).toString(2).length;
        const leading = bits % 32 || 32;
        let value;
        do {
            value = BigInt(randomInt(2 ** leading));
            for (let remaining = bits - leading; remaining > 0; remaining -= 32) {
                value = (value << 32n) + BigInt(randomInt(UINT32_RANGE));
            }
        } while (value >= max);
        return value;
    }

    function chooseWeighted(values, weight, total, randomInt) {
        let rank = randomBigInt(total, randomInt);
        for (const value of values) {
            const size = weight(value);
            if (rank < size) return value;
            rank -= size;
        }
        throw new RangeError('Random source returned a value outside the requested range.');
    }

    function enforceFixedLength(length, maxLength) {
        if (maxLength !== null && length > maxLength) {
            throw new RangeError(`Requested length exceeds the target maximum of ${maxLength} characters.`);
        }
    }

    function preparePassword(settings) {
        const { length, maxLength } = settings;
        enforceFixedLength(length, maxLength);
        const groups = getPasswordProfileGroups(settings);
        const minimumTotal = groups.reduce((sum, group) => sum + group.minimum, 0);
        if (length < minimumTotal) throw new RangeError('Length must be at least the number of required characters.');

        if (groups.every(({ minimum }) => minimum === 1)) {
            const sets = groups.map(({ pool }) => pool);
            const entropy = calculatePasswordEntropy(length, sets);
            const poolSize = sets.reduce((sum, set) => sum + set.length, 0);
            // Reuse the simple sampler when acceptance is at least 1 in 32.
            if (entropy >= length * Math.log2(poolSize) - 5) {
                return { entropy, minLength: length, maxLength: length,
                    generate: (randomInt) => generatePasswordBytes(length, sets, randomInt) };
            }
        }

        // Count valid strings by class allocation. Binomial factors count all
        // placements of that class and the power counts each character choice.
        const choose = [[1n]];
        for (let size = 1; size <= length; size++) {
            choose.push(Array.from({ length: size + 1 }, (_, count) => (
                (choose[size - 1][count - 1] ?? 0n) + (choose[size - 1][count] ?? 0n)
            )));
        }
        const amounts = groups.map(({ minimum }) => Array.from({ length: length - minimum + 1 }, (_, i) => minimum + i));
        const powers = groups.map(({ pool }) => Array.from({ length: length + 1 }, (_, count) => BigInt(pool.length) ** BigInt(count)));
        const ways = Array.from({ length: groups.length + 1 }, () => Array(length + 1).fill(0n));
        ways[groups.length][0] = 1n;
        const weight = (group, remaining, count) => count <= remaining
            ? choose[remaining][count] * powers[group][count] * ways[group + 1][remaining - count]
            : 0n;
        for (let group = groups.length - 1; group >= 0; group--) {
            for (let remaining = 0; remaining <= length; remaining++) {
                ways[group][remaining] = amounts[group].reduce((sum, count) => sum + weight(group, remaining, count), 0n);
            }
        }
        function generate(randomInt = getSecureRandomInt) {
            let remaining = length;
            const counts = groups.map((_, group) => {
                if (group === groups.length - 1) return remaining;
                const count = chooseWeighted(amounts[group], (count) => weight(group, remaining, count), ways[group][remaining], randomInt);
                remaining -= count;
                return count;
            });
            const output = new Uint8Array(length);
            for (let index = 0; index < output.length; index++) {
                let rank = randomInt(length - index);
                let group = 0;
                while (rank >= counts[group]) rank -= counts[group++];
                counts[group]--;
                const { pool } = groups[group];
                output[index] = pool.charCodeAt(randomInt(pool.length));
            }
            return output;
        }
        return { entropy: Math.log2(Number(ways[0][length])), minLength: length, maxLength: length, generate };
    }

    function passphraseEntropyDetails(settings, wordListSize, wordBits, constrained = false) {
        const capitalizationBits = settings.capitalize && settings.randomizeCaps ? settings.count : 0;
        const separatorBits = settings.separator === 'random' ? (settings.count - 1) * Math.log2(RANDOM_SEPARATOR_POOL.length) : 0;
        // Different insertion histories can lead to the same output. Credit
        // independent digit values only.
        const digitBits = settings.insertNumbers
            ? settings.numberCount * (settings.randomizePositions ? 1 : settings.count) * Math.log2(10)
            : 0;
        return { entropy: wordBits + capitalizationBits + separatorBits + digitBits,
            entropyDetails: { wordBits, capitalizationBits, separatorBits, digitBits, wordListSize, constrained } };
    }

    const wordLengthCache = new WeakMap();

    function groupWordIndicesByLength(words) {
        if (wordLengthCache.has(words)) return wordLengthCache.get(words);
        const byLength = new Map();
        words.forEach((word, index) => {
            if (!byLength.has(word.length)) byLength.set(word.length, []);
            byLength.get(word.length).push(index);
        });
        const groups = Array.from(byLength, ([length, indices]) => ({ length, indices })).sort((a, b) => a.length - b.length);
        wordLengthCache.set(words, groups);
        return groups;
    }

    function prepareWordChoices(words, count, fixedLength, limit, mode, maxWordLength = null) {
        const groups = groupWordIndicesByLength(words).filter(({ length }) => maxWordLength === null || length <= maxWordLength);
        if (!groups.length) throw new RangeError('No words fit the selected maximum word length.');
        const wordListSize = groups.reduce((total, group) => total + group.indices.length, 0);
        const minLength = groups[0].length * count + fixedLength;
        const uncappedMax = groups[groups.length - 1].length * count + fixedLength;
        if (limit !== null && limit < minLength) {
            throw new RangeError(`The target maximum of ${limit} characters is too short for these ${mode} settings.`);
        }
        const isFiltered = wordListSize !== words.length;
        if (limit === null || limit >= uncappedMax) {
            const indices = isFiltered ? groups.flatMap((group) => group.indices) : null;
            return { wordListSize, wordBits: count * Math.log2(wordListSize), minLength, maxLength: uncappedMax,
                constrained: isFiltered, makePicker: (randomInt) => indices ? () => indices[randomInt(indices.length)] : undefined };
        }

        // ways[slots][budget] counts all ordered word sequences fitting the
        // remaining character budget. A branch counts the words in that length
        // group times the number of continuations after choosing one.
        const budget = limit - fixedLength;
        const ways = [Array(budget + 1).fill(1n)];
        const weight = (slots, remaining, group) => remaining < group.length ? 0n
            : BigInt(group.indices.length) * ways[slots - 1][remaining - group.length];
        for (let slots = 1; slots <= count; slots++) {
            ways.push(Array.from({ length: budget + 1 }, (_, remaining) => (
                groups.reduce((total, group) => total + weight(slots, remaining, group), 0n)
            )));
        }
        const total = ways[count][budget];
        let maxBudget = budget;
        while (ways[count][maxBudget - 1] === total) maxBudget--;

        function makePicker(randomInt) {
            let remaining = budget;
            return (index) => {
                const slots = count - index;
                const group = chooseWeighted(groups, (group) => weight(slots, remaining, group), ways[slots][remaining], randomInt);
                remaining -= group.length;
                return group.indices[randomInt(group.indices.length)];
            };
        }
        return { wordListSize, wordBits: Math.log2(Number(total)), minLength, maxLength: maxBudget + fixedLength,
            constrained: true, makePicker };
    }

    function preparePassphrase(settings, words) {
        const list = passphraseWordlist(settings, words);
        const digits = settings.insertNumbers ? settings.numberCount * (settings.randomizePositions ? 1 : settings.count) : 0;
        const { wordListSize, wordBits, minLength, maxLength, constrained, makePicker } = prepareWordChoices(
            list, settings.count, settings.count - 1 + digits, settings.maxLength, 'passphrase', settings.maxWordLength
        );
        return { ...passphraseEntropyDetails(settings, wordListSize, wordBits, constrained), minLength, maxLength,
            generate: (randomInt = getSecureRandomInt) => writePassphrase(settings, list, randomInt, makePicker(randomInt)) };
    }

    function prepareUsername(settings, words) {
        const list = getWordlist(words).words;
        const fixedLength = (settings.count - 1) * settings.separator.length
            + (settings.appendNumbers ? settings.numberCount + settings.separator.length : 0);
        const { minLength, maxLength, makePicker } = prepareWordChoices(list, settings.count, fixedLength, settings.maxLength, 'username');
        return { entropy: null, minLength, maxLength,
            generate: (randomInt = getSecureRandomInt) => writeUsername(settings, list, randomInt, makePicker(randomInt)) };
    }

    function preparePattern(settings) {
        const { tokens, totalLength, entropy, error } = parsePattern(settings.template, settings.maxLength ?? 1000);
        if (error) throw new RangeError(error);
        function generate(randomInt = getSecureRandomInt) {
            const output = new Uint8Array(totalLength);
            let offset = 0;
            for (const { pool, count } of tokens) {
                if (pool.length === 1) {
                    output.fill(pool.charCodeAt(0), offset, offset + count);
                    offset += count;
                } else {
                    for (let index = 0; index < count; index++) output[offset++] = pool.charCodeAt(randomInt(pool.length));
                }
            }
            return output;
        }
        return { entropy, minLength: totalLength, maxLength: totalLength, generate };
    }

    function prepareRawSecret(settings) {
        const { byteLength, encoding, maxLength } = settings;
        const length = encoding === 'hex' ? byteLength * 2
            : encoding === 'base64' ? Math.ceil(byteLength / 3) * 4 : Math.ceil(byteLength * 4 / 3);
        enforceFixedLength(length, maxLength);
        function generate(randomInt) {
            if (randomInt === undefined) return generateRawSecretBytes(settings);
            return generateRawSecretBytes(settings, {
                getRandomValues(bytes) {
                    for (let index = 0; index < bytes.length; index++) bytes[index] = randomInt(256);
                    return bytes;
                }
            });
        }
        return { entropy: byteLength * 8, minLength: length, maxLength: length, generate };
    }

    const PREPARE_MODE = Object.freeze({
        password: preparePassword, passphrase: preparePassphrase, username: prepareUsername,
        pattern: preparePattern, raw: prepareRawSecret
    });

    function prepareGenerationProfile(value, words) {
        const profile = normalizeGenerationProfile(value);
        const { mode, options } = profile;
        return { profile, ...PREPARE_MODE[mode](options, words) };
    }

    return Object.freeze({
        CHARS,
        DEFAULT_SYMS,
        DEFAULT_PATTERN,
        CONFIG_FRIENDLY_SYMS,
        RANDOM_SEPARATOR_POOL,
        calculatePassphraseEntropy,
        calculatePasswordEntropy,
        generatePassphraseBytes,
        generatePasswordBytes,
        generateRawSecretBytes,
        generateUsernameBytes,
        getPasswordProfileCharsets,
        getSecureRandomInt,
        normalizeGenerationProfile,
        normalizeSymbolPool,
        parsePattern,
        prepareGenerationProfile,
        uniqueChars
    });
}));
