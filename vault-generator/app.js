const el = {
    result: document.getElementById('result'),
    resultContainer: document.getElementById('result-container'),
    length: document.getElementById('length'),
    lengthNum: document.getElementById('length-num'),
    lengthLabel: document.getElementById('length-label'),
    lengthContainer: document.getElementById('length-container'),
    metricsContainer: document.getElementById('metrics-container'),
    generateBtn: document.getElementById('generate-btn'),
    copyBtn: document.getElementById('copy-btn'),
    themeBtn: document.getElementById('theme-btn'),
    clearTime: document.getElementById('clear-time'),
    customClearTime: document.getElementById('custom-clear-time'),
    entropyText: document.getElementById('entropy-text'),
    strengthText: document.getElementById('strength-text'),
    crackText: document.getElementById('crack-text'),
    entropyBar: document.getElementById('entropy-bar'),
    tabPwd: document.getElementById('tab-pwd'),
    tabPass: document.getElementById('tab-pass'),
    tabUser: document.getElementById('tab-user'),
    pwdOpts: document.getElementById('pwd-options'),
    passOpts: document.getElementById('pass-options'),
    userOpts: document.getElementById('user-options'),
    symInput: document.getElementById('sym-input'),
    optCustomSyms: document.getElementById('opt-custom-syms'),
    paranoidOverlay: document.getElementById('paranoid-overlay'),
    poolInfo: document.getElementById('pool-info'),
    insecureWarning: document.getElementById('insecure-warning')
};

const CHARS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    nums: "0123456789"
};
const DEFAULT_SYMS = "!@#$%^&*()-_=+[]{};:,.<>/?|~";
const SAFE_SYMS = "!@#%^*-_=+:./?";

let currentMode = 'pwd'; 
let clearTimer;
let lengths = { pwd: 24, pass: 6, user: 2 }; 
let activeSecretBuffer = null;

// --- WORKING-BUFFER WIPING (best-effort) ---
// Zeroes the Uint8Array that holds the secret while it's being built, then drops
// the reference. IMPORTANT: this is only ONE copy. Showing or copying a result
// also creates immutable JS strings (result.textContent, the clipboard, the
// fallback <textarea>) that the engine may duplicate internally and that cannot
// be overwritten in place or force-freed from script. So this is a best-effort
// reduction of in-memory residue over the buffer copy, NOT a guarantee the
// secret is gone from memory. The README threat model spells this out.
function wipeMemory() {
    if (activeSecretBuffer) {
        crypto.getRandomValues(activeSecretBuffer); // cover with noise...
        activeSecretBuffer.fill(0);                 // ...then zero
        activeSecretBuffer = null;
    }
}

function wipeSecret() {
    wipeMemory();
    // Clear the DOM content to ensure no visual traces remain
    el.result.textContent = "";
}

// --- DUAL-SYNC LENGTH LOGIC ---
function syncLength(e) {
    let val = parseInt(e.target.value);
    const min = parseInt(el.length.min);
    const max = parseInt(el.length.max);
    
    if (isNaN(val)) return;
    if (val < min) val = min;
    if (val > max) val = max;

    lengths[currentMode] = val; 
    el.length.value = val;
    el.lengthNum.value = val;
    generate();
    saveSettings();
}

// --- CORE GENERATION ---
function getSecureRandomInt(max) {
    const randomBytes = new Uint32Array(1);
    // Rejection sampling: discard any value in the "remainder" tail of the
    // uint32 range so the surviving values divide evenly by `max`. Without
    // this, `% max` would over-represent low values (modulo bias) whenever
    // 2^32 isn't a clean multiple of max. maxValid is the largest exact
    // multiple of max that fits in a uint32; anything >= it gets re-rolled.
    const maxValid = Math.floor(4294967296 / max) * max;
    while (true) {
        crypto.getRandomValues(randomBytes);
        if (randomBytes[0] < maxValid) return randomBytes[0] % max;
    }
}

// Read an integer from a numeric <input>, clamped to [min, max], falling back to
// `def` when the field is blank or non-numeric. The length inputs are validated
// on load (see loadSettings); these live num-count fields were not, which let a
// blank or NaN value reach the buffer-size math -- new Uint8Array(NaN) yields a
// zero-length buffer and a silently truncated/empty result.
function readIntField(id, min, max, def) {
    const v = parseInt(document.getElementById(id).value, 10);
    if (!Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
}

function generate() {
    if (currentMode === 'pwd') generatePassword();
    else if (currentMode === 'pass') generatePassphrase();
    else if (currentMode === 'user') generateUsername();
    
    if (currentMode !== 'user') calculateEntropyAndStrength();
}

function generatePassword() {
    wipeMemory(); // Securely free the previous buffer before allocating a new one
    
    const len = lengths.pwd;
    let pool = "";
    const activeSets = [];

    if (document.getElementById('opt-upper').checked) { pool += CHARS.upper; activeSets.push(CHARS.upper); }
    if (document.getElementById('opt-lower').checked) { pool += CHARS.lower; activeSets.push(CHARS.lower); }
    if (document.getElementById('opt-nums').checked) { pool += CHARS.nums; activeSets.push(CHARS.nums); }
    
    if (document.getElementById('opt-syms').checked) {
        let symPool = el.symInput.value;
        if (symPool) {
            pool += symPool;
            activeSets.push(symPool);
        } else {
            // Symbols requested but the custom pool is empty. Warn rather than
            // silently dropping a whole character class the user asked for.
            el.result.textContent = "Symbols enabled but pool is empty \u2014 add symbols or uncheck.";
            return;
        }
    }
    
    if (document.getElementById('opt-ambig').checked) {
        pool = pool.replace(/[lI1O0]/g, "");
        // Re-derive each active set with ambiguous chars stripped, and drop any
        // set that became empty (e.g. a custom symbol pool of only "l1O0").
        // Otherwise the class guarantee below could never be satisfied and we'd
        // silently fall through to the no-guarantee failsafe.
        for (let i = activeSets.length - 1; i >= 0; i--) {
            activeSets[i] = activeSets[i].replace(/[lI1O0]/g, "");
            if (activeSets[i].length === 0) activeSets.splice(i, 1);
        }
    }

    if (!pool) { el.result.textContent = "Select a pool!"; return; }

    // Infinite loop guard: Prevent freezing if length is mathematically smaller than required classes
    if (len < activeSets.length) {
        el.result.textContent = "Length must be \u2265 active sets!";
        return;
    }

    let isValid = false;
    let iterations = 0;
    const maxIterations = 1000;
    
    // Convert activeSets to typed arrays for strict validation without strings
    let activeSetsCodes = activeSets.map(set => {
        let arr = new Uint8Array(set.length);
        for(let i=0; i<set.length; i++) arr[i] = set.charCodeAt(i);
        return arr;
    });

    activeSecretBuffer = new Uint8Array(len);

    // Strict character-class enforcement with Max Iteration Failsafe
    while (!isValid && iterations < maxIterations) {
        for (let i = 0; i < len; i++) {
            activeSecretBuffer[i] = pool.charCodeAt(getSecureRandomInt(pool.length));
        }
        
        isValid = activeSetsCodes.every(set => {
            for (let i = 0; i < len; i++) {
                if (set.includes(activeSecretBuffer[i])) return true;
            }
            return false;
        });
        iterations++;
    }

    // Failsafe path: if maxIterations draws never satisfied every class,
    // emit a fresh random array WITHOUT the guarantee rather than hang.
    if (iterations >= maxIterations) {
        for (let i = 0; i < len; i++) {
            activeSecretBuffer[i] = pool.charCodeAt(getSecureRandomInt(pool.length));
        }
    }

    el.result.textContent = new TextDecoder().decode(activeSecretBuffer);
}

function generatePassphrase() {
    wipeMemory();
    
    const count = lengths.pass;
    const sepChoice = document.getElementById('opt-pass-sep').value;
    const doCaps = document.getElementById('opt-pass-caps').checked;
    const randCaps = document.getElementById('opt-pass-caps-rand').checked;
    const RAND_SEP_POOL = "!@#$%^&*-_=+";
    const doNums = document.getElementById('opt-pass-nums').checked;
    let numCount = readIntField('pass-num-count', 1, 10, 2);
    let randomizePositions = document.getElementById('opt-pass-nums-rand').checked;
    
    let wordIndices = [];
    let capMask = [];
    let totalLength = 0;

    for (let i = 0; i < count; i++) {
        let idx = getSecureRandomInt(WORDS.length);
        wordIndices.push(idx);
        totalLength += WORDS[idx].length;
        capMask.push(doCaps && (!randCaps || getSecureRandomInt(2) === 1));
    }

    // Add appended numbers length
    if (doNums && !randomizePositions) {
        totalLength += (numCount * count);
    }

    // Add separators length
    if (count > 1) {
        if (sepChoice === 'random') totalLength += (count - 1);
        else if (sepChoice !== '') totalLength += (sepChoice.length * (count - 1));
    }

    // Add sprinkled numbers length
    if (doNums && randomizePositions) {
        totalLength += numCount;
    }

    activeSecretBuffer = new Uint8Array(totalLength);
    let offset = 0;

    const writeStr = (str) => {
        for(let i=0; i<str.length; i++) activeSecretBuffer[offset++] = str.charCodeAt(i);
    };

    for (let i = 0; i < count; i++) {
        let word = WORDS[wordIndices[i]];
        if (capMask[i]) {
            activeSecretBuffer[offset++] = word.charCodeAt(0) - 32; // Capitalize
            writeStr(word.slice(1));
        } else {
            writeStr(word);
        }
        
        if (doNums && !randomizePositions) {
            for (let j = 0; j < numCount; j++) {
                activeSecretBuffer[offset++] = 48 + getSecureRandomInt(10);
            }
        }
        
        if (i < count - 1) {
            if (sepChoice === 'random') {
                activeSecretBuffer[offset++] = RAND_SEP_POOL.charCodeAt(getSecureRandomInt(RAND_SEP_POOL.length));
            } else if (sepChoice !== '') {
                writeStr(sepChoice);
            }
        }
    }

    // In-place shifting for sprinkled numbers (avoids string/array allocation)
    if (doNums && randomizePositions) {
        let currentLen = offset;
        for (let i = 0; i < numCount; i++) {
            let targetIdx = getSecureRandomInt(currentLen + 1);
            for (let j = currentLen; j > targetIdx; j--) {
                activeSecretBuffer[j] = activeSecretBuffer[j - 1];
            }
            activeSecretBuffer[targetIdx] = 48 + getSecureRandomInt(10);
            currentLen++;
        }
    }

    el.result.textContent = new TextDecoder().decode(activeSecretBuffer);
}

function generateUsername() {
    wipeMemory();
    
    const count = lengths.user;
    const sep = document.getElementById('opt-user-sep').value;
    const doNums = document.getElementById('opt-user-nums').checked;
    let numCount = readIntField('user-num-count', 1, 9, 3);

    let wordIndices = [];
    let totalLength = 0;

    for (let i = 0; i < count; i++) {
        let idx = getSecureRandomInt(WORDS.length);
        wordIndices.push(idx);
        totalLength += WORDS[idx].length;
    }
    
    if (sep !== '') {
        totalLength += sep.length * (count - 1);
        if (doNums) totalLength += sep.length;
    }
    
    if (doNums) {
        totalLength += numCount;
    }

    activeSecretBuffer = new Uint8Array(totalLength);
    let offset = 0;

    const writeStr = (str) => {
        for(let i=0; i<str.length; i++) activeSecretBuffer[offset++] = str.charCodeAt(i);
    };

    for (let i = 0; i < count; i++) {
        let word = WORDS[wordIndices[i]];
        activeSecretBuffer[offset++] = word.charCodeAt(0) - 32; // Capitalize
        writeStr(word.slice(1));
        
        if (i < count - 1 && sep !== '') {
            writeStr(sep);
        }
    }
    
    if (doNums) {
        if (sep !== '') writeStr(sep);
        for(let i = 0; i < numCount; i++) {
            activeSecretBuffer[offset++] = 48 + getSecureRandomInt(10);
        }
    }
    
    el.result.textContent = new TextDecoder().decode(activeSecretBuffer);
}

// --- STATS AND ENTROPY ---
// Turn a raw "seconds to exhaust the keyspace" figure into an honest, finite,
// human-readable duration. Deliberately never returns "infinite" -- for very
// large keyspaces it falls back to scientific-notation years, which is both
// truthful and still clearly communicates "not happening".
function formatCrackTime(seconds) {
    if (!isFinite(seconds)) return 'longer than the age of the universe';
    if (seconds < 1) return 'instant';
    const MIN = 60, HOUR = 3600, DAY = 86400, YEAR = 31557600; // 365.25 days
    if (seconds < MIN)  return `${Math.round(seconds)} seconds`;
    if (seconds < HOUR) return `${Math.round(seconds / MIN)} minutes`;
    if (seconds < DAY)  return `${Math.round(seconds / HOUR)} hours`;
    if (seconds < YEAR) return `${Math.round(seconds / DAY)} days`;

    const years = seconds / YEAR;
    if (years < 1000) return `${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'}`;
    const scales = [
        [1e6,  1e3,  'thousand'],
        [1e9,  1e6,  'million'],
        [1e12, 1e9,  'billion'],
        [1e15, 1e12, 'trillion'],
    ];
    for (const [hi, div, name] of scales) {
        if (years < hi) return `${(years / div).toFixed(1)} ${name} years`;
    }
    return `${years.toExponential(1)} years`;
}

function calculateEntropyAndStrength() {
    let entropy = 0;
    
    if (currentMode === 'pass') {
        entropy = lengths.pass * Math.log2(WORDS.length);
        
        if (document.getElementById('opt-pass-caps').checked && document.getElementById('opt-pass-caps-rand').checked) {
            entropy += lengths.pass; 
        }
        // Random-symbol separator: each of the (count-1) gaps holds one of 11
        // symbols, so each adds log2(11) bits. Fixed separators add nothing.
        if (document.getElementById('opt-pass-sep').value === 'random') {
            entropy += Math.max(0, lengths.pass - 1) * Math.log2(11);
        }
        if (document.getElementById('opt-pass-nums').checked) {
            let numCount = readIntField('pass-num-count', 1, 10, 2);
            let randomizePositions = document.getElementById('opt-pass-nums-rand').checked;
            
            if (randomizePositions) {
                // Count digit VALUES only (numCount * log2(10)). We deliberately
                // do NOT add positional entropy: an attacker who knows the scheme
                // can see which words carry trailing digits in the output, so
                // position is not secret. Counting it would make the meter
                // optimistic -- and for a strength meter, erring conservative is
                // the only safe direction.
                entropy += numCount * Math.log2(10);
            } else {
                // If appending to EVERY word, we generate `numCount * lengths.pass` total random digits
                entropy += (numCount * lengths.pass) * Math.log2(10);
            }
        }
    } else {
        let poolSize = 0;
        if (document.getElementById('opt-upper').checked) poolSize += 26;
        if (document.getElementById('opt-lower').checked) poolSize += 26;
        if (document.getElementById('opt-nums').checked) poolSize += 10;
        if (document.getElementById('opt-syms').checked) {
            const uniqueSyms = new Set(el.symInput.value.split('')).size;
            poolSize += uniqueSyms;
        }
        // Ambiguous-stripping removes l, I, 1, O, 0 — but only the ones
        // actually present in the selected sets. Build the pool string and
        // strip it so the count is exact rather than a flat -5.
        if (document.getElementById('opt-ambig').checked) {
            let poolStr = "";
            if (document.getElementById('opt-upper').checked) poolStr += CHARS.upper;
            if (document.getElementById('opt-lower').checked) poolStr += CHARS.lower;
            if (document.getElementById('opt-nums').checked) poolStr += CHARS.nums;
            if (document.getElementById('opt-syms').checked) poolStr += el.symInput.value;
            poolSize = new Set(poolStr.replace(/[lI1O0]/g, "").split('')).size;
        }
        entropy = lengths.pwd * Math.log2(poolSize || 1);
        if (el.poolInfo) el.poolInfo.textContent = `Character pool: ${poolSize} symbols`;
    }
    
    el.entropyText.textContent = `Entropy: ${Math.round(entropy)} bits`;
    // The visual bar saturates at 128 bits; high-word-count passphrases can far
    // exceed that, so the bar pins at full. The numeric readout above is the
    // source of truth — the bar is just a quick visual cue.
    el.entropyBar.style.width = `${Math.min(100, (entropy/128)*100)}%`;
    
    let strength = "Weak";
    let colorClass = "strength-weak";
    let barColor = "#dc3545";

    // Single fixed rate: 100 billion guesses/sec (1e11). This assumes a FAST,
    // unsalted hash (one SHA-family round on commodity GPUs). A slow KDF such as
    // bcrypt/argon2 would be many orders of magnitude slower, so this is a rough
    // yardstick, not a guarantee -- see the README crack-time note. (The old code
    // used 1e10, which silently disagreed with the README's stated 100B/s.)
    const seconds = Math.pow(2, entropy) / 1e11;

    // The qualitative band drives the label + colour; the time itself is computed
    // by formatCrackTime so we never print a dishonest word like "Infinite".
    if (entropy < 40) {
        strength = "Weak"; colorClass = "strength-weak"; barColor = "#dc3545";
    } else if (seconds < 86400) {
        strength = "Fair"; colorClass = "strength-fair"; barColor = "#fd7e14";
    } else if (seconds < 31536000) {
        strength = "Good"; colorClass = "strength-good"; barColor = "#28a745";
    } else if (seconds < 3.15e11) {
        strength = "Strong"; colorClass = "strength-strong"; barColor = "#20c997";
    } else {
        strength = "Very Strong"; colorClass = "strength-very-strong"; barColor = "#8a2be2";
    }

    el.strengthText.textContent = `Strength: ${strength}`;
    el.strengthText.className = colorClass;
    el.crackText.textContent = `Estimated Time to Crack: ${formatCrackTime(seconds)}`;
    el.entropyBar.style.backgroundColor = barColor;
}

// --- UI HELPERS ---
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'show';
    setTimeout(() => { toast.className = ''; }, 3000);
}

// Fallback for non-HTTPS homelab environments
function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
    } catch (err) {
        console.error('Fallback: Oops, unable to copy', err);
    }
    document.body.removeChild(textArea);
}

function triggerCopyFeedback() {
    const textToCopy = el.result.textContent;
    if (!textToCopy) return; // Prevent copying empty strings

    let delay;
    if (el.clearTime.value === 'custom') {
        let customSecs = parseInt(el.customClearTime.value);
        if (isNaN(customSecs) || customSecs <= 0) customSecs = 60; 
        delay = customSecs * 1000;
    } else {
        delay = parseInt(el.clearTime.value);
    }

    const onSuccess = () => {
        showToast(`Copied! Clearing in ${delay/1000}s`);
        el.copyBtn.textContent = `Copied! (${delay/1000}s)`;
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
            // Memory & DOM Wipe Target
            wipeSecret();

            // Two-step wipe: overwrite with random cover text first, then
            // clear. Some OS-level clipboard managers keep history; a straight
            // clear can leave the real secret as the "previous" entry, whereas
            // overwriting first pushes cover into that slot. Random content of
            // varied length is used (rather than a fixed "0000..." string) so
            // the wipe entry isn't itself a recognizable "a secret was here"
            // signature. Best-effort only (see README threat model).
            const garbageLen = 24 + getSecureRandomInt(24); // 24-47 chars
            const garbageChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            let garbage = "";
            for (let i = 0; i < garbageLen; i++) garbage += garbageChars[getSecureRandomInt(garbageChars.length)];
            
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(garbage).then(() => {
                    setTimeout(() => navigator.clipboard.writeText(""), 50);
                }).catch(() => {});
            } else {
                fallbackCopyTextToClipboard(garbage);
                setTimeout(() => fallbackCopyTextToClipboard(""), 50);
            }

            el.copyBtn.textContent = "Copy";
            showToast("Clipboard and memory cleared.");
        }, delay);
    };

    // Attempt modern async clipboard first, fallback to execCommand for HTTP/IP access
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(textToCopy).then(onSuccess).catch(err => {
            console.error('Async: Could not copy text: ', err);
            fallbackCopyTextToClipboard(textToCopy);
            onSuccess();
        });
    } else {
        fallbackCopyTextToClipboard(textToCopy);
        onSuccess();
    }
}

function toggleNestedInputs() {
    document.getElementById('opt-pass-caps-rand-wrapper').classList.toggle('hidden', !document.getElementById('opt-pass-caps').checked);
    document.getElementById('pass-num-options-wrapper').classList.toggle('hidden', !document.getElementById('opt-pass-nums').checked);
    document.getElementById('user-num-count-wrapper').classList.toggle('hidden', !document.getElementById('opt-user-nums').checked);
}

function updateUI() {
    el.tabPwd.classList.toggle('active', currentMode === 'pwd');
    el.tabPass.classList.toggle('active', currentMode === 'pass');
    el.tabUser.classList.toggle('active', currentMode === 'user');
    
    el.pwdOpts.classList.toggle('hidden', currentMode !== 'pwd');
    el.passOpts.classList.toggle('hidden', currentMode !== 'pass');
    el.userOpts.classList.toggle('hidden', currentMode !== 'user');
    
    if (currentMode === 'user') {
        el.lengthContainer.classList.remove('hidden'); 
        el.length.classList.remove('hidden');
        el.metricsContainer.classList.add('hidden'); 
        
        el.lengthLabel.textContent = "Words";
        el.length.min = el.lengthNum.min = 1;
        el.length.max = el.lengthNum.max = 10;
    } else if (currentMode === 'pass') {
        el.lengthContainer.classList.remove('hidden');
        el.length.classList.remove('hidden');
        el.metricsContainer.classList.remove('hidden'); 
        
        el.lengthLabel.textContent = "Words";
        el.length.min = el.lengthNum.min = 3;
        el.length.max = el.lengthNum.max = 20;
    } else {
        el.lengthContainer.classList.remove('hidden');
        el.length.classList.remove('hidden');
        el.metricsContainer.classList.remove('hidden'); 
        
        el.lengthLabel.textContent = "Length";
        el.length.min = el.lengthNum.min = 4;
        el.length.max = el.lengthNum.max = 128;
    }
    
    el.length.value = el.lengthNum.value = lengths[currentMode];
    toggleNestedInputs();
    generate();
}

// --- THEME ---
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    el.themeBtn.textContent = isDark ? '☀️' : '🌙';
    try { localStorage.setItem('vault_theme', isDark ? 'dark' : 'light'); } catch (e) {}
}

// --- PERSISTENT SETTINGS ---
function saveSettings() {
    if (document.getElementById('opt-paranoid').checked) return; 
    
    const settings = {
        lengths: lengths,
        clearTime: el.clearTime.value,
        customClearTime: el.customClearTime.value,
        upper: document.getElementById('opt-upper').checked,
        lower: document.getElementById('opt-lower').checked,
        nums: document.getElementById('opt-nums').checked,
        syms: document.getElementById('opt-syms').checked,
        ambig: document.getElementById('opt-ambig').checked,
        safe: document.getElementById('opt-safe').checked,
        customSyms: el.optCustomSyms.checked,
        passCaps: document.getElementById('opt-pass-caps').checked,
        passCapsRand: document.getElementById('opt-pass-caps-rand').checked,
        passNums: document.getElementById('opt-pass-nums').checked,
        passNumsRand: document.getElementById('opt-pass-nums-rand').checked,
        passNumCount: document.getElementById('pass-num-count').value,
        passSep: document.getElementById('opt-pass-sep').value,
        userNums: document.getElementById('opt-user-nums').checked,
        userNumCount: document.getElementById('user-num-count').value,
        userSep: document.getElementById('opt-user-sep').value,
        symPool: el.symInput.value
    };
    try { localStorage.setItem('vault_settings', JSON.stringify(settings)); } catch(e) {}
}

function loadSettings() {
    try {
        const savedTheme = localStorage.getItem('vault_theme');
        if (savedTheme === 'dark') {
            document.body.classList.add('dark-mode');
            el.themeBtn.textContent = '☀️';
        } else if (savedTheme === null &&
                   window.matchMedia &&
                   window.matchMedia('(prefers-color-scheme: dark)').matches) {
            // No explicit choice saved: follow the OS/browser preference.
            document.body.classList.add('dark-mode');
            el.themeBtn.textContent = '☀️';
        }
        
        const saved = JSON.parse(localStorage.getItem('vault_settings'));
        if (saved) {
            // Validate restored lengths before they reach Math.log2 / loops.
            // localStorage is user-visible and editable, and a partial/corrupt
            // write could otherwise feed a string or undefined into the math.
            // Accept only in-range integers; fall back to defaults otherwise.
            if (saved.lengths && typeof saved.lengths === 'object') {
                const clamp = (v, min, max, def) =>
                    (Number.isInteger(v) && v >= min && v <= max) ? v : def;
                lengths.pwd  = clamp(saved.lengths.pwd, 4, 128, 24);
                lengths.pass = clamp(saved.lengths.pass, 3, 20, 6);
                lengths.user = clamp(saved.lengths.user, 1, 10, 2);
            }
            
            if (saved.clearTime !== undefined) {
                el.clearTime.value = saved.clearTime;
                el.customClearTime.classList.toggle('hidden', saved.clearTime !== 'custom');
            }
            if (saved.customClearTime !== undefined) el.customClearTime.value = saved.customClearTime;
            
            if (saved.upper !== undefined) document.getElementById('opt-upper').checked = saved.upper;
            if (saved.lower !== undefined) document.getElementById('opt-lower').checked = saved.lower;
            if (saved.nums !== undefined) document.getElementById('opt-nums').checked = saved.nums;
            if (saved.syms !== undefined) document.getElementById('opt-syms').checked = saved.syms;
            if (saved.ambig !== undefined) document.getElementById('opt-ambig').checked = saved.ambig;
            if (saved.safe !== undefined) document.getElementById('opt-safe').checked = saved.safe;
            
            if (saved.customSyms !== undefined) {
                el.optCustomSyms.checked = saved.customSyms;
                el.symInput.classList.toggle('hidden', !saved.customSyms);
            }

            if (saved.passCaps !== undefined) document.getElementById('opt-pass-caps').checked = saved.passCaps;
            if (saved.passCapsRand !== undefined) document.getElementById('opt-pass-caps-rand').checked = saved.passCapsRand;
            if (saved.passNums !== undefined) document.getElementById('opt-pass-nums').checked = saved.passNums;
            if (saved.passNumsRand !== undefined) document.getElementById('opt-pass-nums-rand').checked = saved.passNumsRand;
            if (saved.passNumCount !== undefined) document.getElementById('pass-num-count').value = saved.passNumCount;
            if (saved.passSep !== undefined) document.getElementById('opt-pass-sep').value = saved.passSep;
            
            if (saved.userNums !== undefined) document.getElementById('opt-user-nums').checked = saved.userNums;
            if (saved.userNumCount !== undefined) document.getElementById('user-num-count').value = saved.userNumCount;
            if (saved.userSep !== undefined) document.getElementById('opt-user-sep').value = saved.userSep;
            
            if (saved.symPool !== undefined) el.symInput.value = saved.symPool;
        }
    } catch(e) {}
}

// --- LISTENERS ---
el.themeBtn.addEventListener('click', toggleTheme);
el.generateBtn.addEventListener('click', generate);

// Both buttons now trigger the updated fallback-enabled copy function
el.copyBtn.addEventListener('click', triggerCopyFeedback);
el.resultContainer.addEventListener('click', triggerCopyFeedback); 

el.length.addEventListener('input', syncLength);
el.lengthNum.addEventListener('input', syncLength);

el.tabPwd.addEventListener('click', () => { currentMode = 'pwd'; updateUI(); saveSettings(); });
el.tabPass.addEventListener('click', () => { currentMode = 'pass'; updateUI(); saveSettings(); });
el.tabUser.addEventListener('click', () => { currentMode = 'user'; updateUI(); saveSettings(); });

el.clearTime.addEventListener('change', (e) => {
    el.customClearTime.classList.toggle('hidden', e.target.value !== 'custom');
    saveSettings();
});
el.customClearTime.addEventListener('input', saveSettings);

// Nested Checkbox Reveal Listeners
document.getElementById('opt-pass-caps').addEventListener('change', () => { toggleNestedInputs(); generate(); saveSettings(); });
document.getElementById('opt-pass-nums').addEventListener('change', () => { toggleNestedInputs(); generate(); saveSettings(); });
document.getElementById('opt-user-nums').addEventListener('change', () => { toggleNestedInputs(); generate(); saveSettings(); });

// Custom Symbols & Sanitize
el.symInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\s+/g, ''); // Disallow whitespace
});

el.optCustomSyms.addEventListener('change', (e) => {
    el.symInput.classList.toggle('hidden', !e.target.checked);
    if (!e.target.checked) el.symInput.value = document.getElementById('opt-safe').checked ? SAFE_SYMS : DEFAULT_SYMS;
    generate();
    saveSettings();
});

// Safe Symbols Filter
document.getElementById('opt-safe').addEventListener('change', (e) => {
    if (e.target.checked) el.symInput.value = SAFE_SYMS;
    else el.symInput.value = DEFAULT_SYMS;
    generate();
});

// Regenerate and Save immediately if any options change
document.querySelectorAll('input, select').forEach(input => {
    if (input.type === 'range' || input.type === 'number') {
        input.addEventListener('change', saveSettings); 
    } else {
        input.addEventListener('input', () => { generate(); saveSettings(); });
        input.addEventListener('change', () => { generate(); saveSettings(); });
    }
});

// Paranoid Mode Aggressive Wipe
document.getElementById('opt-paranoid').addEventListener('change', (e) => {
    document.body.classList.toggle('paranoid-active', e.target.checked);
    el.paranoidOverlay.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) {
        try { localStorage.clear(); } catch(err) {}
    } else {
        saveSettings();
    }
});

// Paranoid mode treats leaving the page as a wipe trigger. beforeunload
// covers close/refresh/navigate; visibilitychange covers tab-switch and
// minimize. Both execute cryptographic buffer wipes and clear the DOM.
window.addEventListener('beforeunload', () => {
    if (document.getElementById('opt-paranoid').checked) {
        wipeSecret();
        try { localStorage.clear(); } catch(err) {}
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && document.getElementById('opt-paranoid').checked) {
        wipeSecret();
    }
});

// Spacebar regenerates (power-user shortcut). Ignored while typing in an
// input/select/textarea so it doesn't hijack the space key in fields.
document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return;
    e.preventDefault();
    generate();
});

// The ONLY crypto primitive this app uses is crypto.getRandomValues, which is
// available in every context -- https, http, and file://. SubtleCrypto is the
// part gated behind a secure context, and we never touch it. So the only thing
// that actually prevents generation is getRandomValues being missing entirely
// (a very old or locked-down browser). Warn on that alone -- keying the banner
// off !isSecureContext (the previous behaviour) cried wolf on file:// and plain
// HTTP, where generation works perfectly and only the async clipboard degrades
// to the legacy execCommand copy path.
function checkSecureContext() {
    if (!el.insecureWarning) return;
    const cryptoOk = window.crypto && typeof window.crypto.getRandomValues === 'function';
    if (!cryptoOk) {
        el.insecureWarning.classList.remove('hidden');
    }
}

// Init
loadSettings();
updateUI();
checkSecureContext();
