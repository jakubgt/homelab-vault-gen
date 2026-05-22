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

function generate() {
    if (currentMode === 'pwd') generatePassword();
    else if (currentMode === 'pass') generatePassphrase();
    else if (currentMode === 'user') generateUsername();
    
    if (currentMode !== 'user') calculateEntropyAndStrength();
}

function generatePassword() {
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

    let pwd = "";
    let isValid = false;
    let iterations = 0;
    const maxIterations = 1000;

    // Strict character-class enforcement with Max Iteration Failsafe
    // Generate-and-check rather than placing one of each up front, because
    // forced placement subtly biases position. maxIterations is a failsafe:
    // with pathological inputs (e.g. length barely >= number of sets) the
    // probability of satisfying every set in one draw can get low enough to
    // stall, so we cap retries rather than risk a frozen tab.
    while (!isValid && iterations < maxIterations) {
        pwd = "";
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
        // activeSets is already ambiguous-stripped above, so a direct membership
        // check is correct here.
        isValid = activeSets.every(set => pwd.split('').some(char => set.includes(char)));
        iterations++;
    }

    // Failsafe path: if maxIterations draws never satisfied every class
    // (extremely unlikely outside degenerate settings), emit a fresh random
    // string WITHOUT the guarantee rather than hang or return stale output.
    // It's still full-entropy random; it just may lack one requested class.
    if (iterations >= maxIterations) {
        pwd = "";
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
    }

    el.result.textContent = pwd;
}

function generatePassphrase() {
    const count = lengths.pass;
    const sepChoice = document.getElementById('opt-pass-sep').value;
    const doCaps = document.getElementById('opt-pass-caps').checked;
    const randCaps = document.getElementById('opt-pass-caps-rand').checked;

    // "random" inserts a fresh random symbol between each pair of words, which
    // adds real entropy (see calculateEntropyAndStrength). A fixed separator
    // adds none. We resolve the actual separator(s) at join time below.
    const RAND_SEP_POOL = "!@#$%^&*-_=+";
    
    let phrase = [];
    for (let i = 0; i < count; i++) {
        let word = WORDS[getSecureRandomInt(WORDS.length)];
        
        if (doCaps) {
            if (!randCaps || getSecureRandomInt(2) === 1) {
                word = word.charAt(0).toUpperCase() + word.slice(1);
            }
        }
        phrase.push(word);
    }

    if (document.getElementById('opt-pass-nums').checked) {
        let numCount = +document.getElementById('pass-num-count').value;
        let randomizePositions = document.getElementById('opt-pass-nums-rand').checked;
        
        if (randomizePositions) {
            // Sprinkle numbers randomly across the whole phrase
            for (let i = 0; i < numCount; i++) {
                let targetIdx = getSecureRandomInt(phrase.length);
                phrase[targetIdx] += getSecureRandomInt(10);
            }
        } else {
            // Append exactly numCount to EVERY word in the phrase
            for (let i = 0; i < phrase.length; i++) {
                let nums = "";
                for (let j = 0; j < numCount; j++) {
                    nums += getSecureRandomInt(10);
                }
                phrase[i] += nums;
            }
        }
    }

    let out;
    if (sepChoice === 'random') {
        // Fresh random symbol in each gap between words.
        out = phrase[0] || "";
        for (let i = 1; i < phrase.length; i++) {
            out += RAND_SEP_POOL[getSecureRandomInt(RAND_SEP_POOL.length)] + phrase[i];
        }
    } else {
        out = phrase.join(sepChoice);
    }
    el.result.textContent = out;
}

function generateUsername() {
    const count = lengths.user;
    const sep = document.getElementById('opt-user-sep').value;
    
    let phrase = [];
    for (let i = 0; i < count; i++) {
        let word = WORDS[getSecureRandomInt(WORDS.length)];
        word = word.charAt(0).toUpperCase() + word.slice(1); 
        phrase.push(word);
    }
    
    let result = phrase.join(sep);
    
    if (document.getElementById('opt-user-nums').checked) {
        let numCount = +document.getElementById('user-num-count').value;
        let nums = "";
        for(let i = 0; i < numCount; i++) {
            nums += getSecureRandomInt(10);
        }
        result += sep ? sep + nums : nums;
    }
    
    el.result.textContent = result;
}

// --- STATS AND ENTROPY ---
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
            let numCount = +document.getElementById('pass-num-count').value;
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
    let crackTime = "Instant";
    let colorClass = "strength-weak";
    let barColor = "#dc3545";

    const seconds = Math.pow(2, entropy) / 10000000000;

    if (entropy < 40) {
        strength = "Weak"; crackTime = "Instant"; colorClass = "strength-weak"; barColor = "#dc3545";
    } else if (seconds < 86400) { 
        strength = "Fair"; crackTime = "Hours"; colorClass = "strength-fair"; barColor = "#fd7e14";
    } else if (seconds < 31536000) { 
        strength = "Good"; crackTime = "Days"; colorClass = "strength-good"; barColor = "#28a745";
    } else if (seconds < 3.15e11) { 
        strength = "Strong"; crackTime = "Centuries"; colorClass = "strength-strong"; barColor = "#20c997";
    } else {
        strength = "Very Strong"; crackTime = "Infinite"; colorClass = "strength-very-strong"; barColor = "#8a2be2";
    }

    el.strengthText.textContent = `Strength: ${strength}`;
    el.strengthText.className = colorClass;
    el.crackText.textContent = `Estimated Time to Crack: ${crackTime}`;
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
            showToast("Clipboard cleared.");
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
// minimize. Both clear localStorage / blank the result so a generated
// secret never lingers in a backgrounded or reopened tab.
window.addEventListener('beforeunload', () => {
    if (document.getElementById('opt-paranoid').checked) {
        try { localStorage.clear(); } catch(err) {}
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && document.getElementById('opt-paranoid').checked) el.result.textContent = "";
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

// Web Crypto is unavailable on plain HTTP (except localhost). If we're not in
// a secure context, surface it — generation would otherwise throw silently.
function checkSecureContext() {
    if (!el.insecureWarning) return;
    const cryptoOk = window.crypto && window.crypto.getRandomValues;
    if (!window.isSecureContext || !cryptoOk) {
        el.insecureWarning.classList.remove('hidden');
    }
}

// Init
loadSettings();
updateUI();
checkSecureContext();
