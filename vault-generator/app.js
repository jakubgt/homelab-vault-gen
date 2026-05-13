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
    paranoidOverlay: document.getElementById('paranoid-overlay')
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
        }
    }
    
    if (document.getElementById('opt-ambig').checked) {
        pool = pool.replace(/[lI1O0]/g, "");
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

    // Character Class Guarantee with Max Iteration Failsafe
    while (!isValid && iterations < maxIterations) {
        pwd = "";
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
        isValid = activeSets.every(set => {
            const setChars = document.getElementById('opt-ambig').checked ? set.replace(/[lI1O0]/g, "") : set;
            return pwd.split('').some(char => setChars.includes(char));
        });
        iterations++;
    }

    // Fallback: Best-effort string if constraints somehow fail
    if (iterations >= maxIterations) {
        pwd = "";
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
    }

    el.result.textContent = pwd;
}

function generatePassphrase() {
    const count = lengths.pass;
    const sep = document.getElementById('opt-pass-sep').value;
    const doCaps = document.getElementById('opt-pass-caps').checked;
    const randCaps = document.getElementById('opt-pass-caps-rand').checked;
    
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
        for (let i = 0; i < numCount; i++) {
            let targetIdx = getSecureRandomInt(phrase.length);
            phrase[targetIdx] += getSecureRandomInt(10);
        }
    }

    el.result.textContent = phrase.join(sep);
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
        if (document.getElementById('opt-pass-nums').checked) {
            let numCount = +document.getElementById('pass-num-count').value;
            entropy += numCount * Math.log2(10); 
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
        entropy = lengths.pwd * Math.log2(poolSize || 1);
    }
    
    el.entropyText.textContent = `Entropy: ${Math.round(entropy)} bits`;
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

function triggerCopyFeedback() {
    let delay;
    if (el.clearTime.value === 'custom') {
        let customSecs = parseInt(el.customClearTime.value);
        if (isNaN(customSecs) || customSecs <= 0) customSecs = 60; 
        delay = customSecs * 1000;
    } else {
        delay = parseInt(el.clearTime.value);
    }

    navigator.clipboard.writeText(el.result.textContent).then(() => {
        showToast(`Copied! Clearing in ${delay/1000}s`);
        el.copyBtn.textContent = `Copied! (${delay/1000}s)`;
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
            // Overwrite with garbage data first, then clear, to defeat clipboard history managers
            navigator.clipboard.writeText("00000000000000000000000000000000").then(() => {
                setTimeout(() => navigator.clipboard.writeText(""), 50);
            }).catch(() => {});

            el.copyBtn.textContent = "Copy";
            showToast("Clipboard cleared.");
        }, delay);
    });
}

function toggleNestedInputs() {
    document.getElementById('opt-pass-caps-rand-wrapper').classList.toggle('hidden', !document.getElementById('opt-pass-caps').checked);
    document.getElementById('pass-num-count-wrapper').classList.toggle('hidden', !document.getElementById('opt-pass-nums').checked);
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
        if (localStorage.getItem('vault_theme') === 'dark') {
            document.body.classList.add('dark-mode');
            el.themeBtn.textContent = '☀️';
        }
        
        const saved = JSON.parse(localStorage.getItem('vault_settings'));
        if (saved) {
            if (saved.lengths) lengths = saved.lengths;
            
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
el.copyBtn.addEventListener('click', triggerCopyFeedback);
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

window.addEventListener('beforeunload', () => {
    if (document.getElementById('opt-paranoid').checked) {
        try { localStorage.clear(); } catch(err) {}
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && document.getElementById('opt-paranoid').checked) el.result.textContent = "";
});

// Init
loadSettings();
updateUI();
