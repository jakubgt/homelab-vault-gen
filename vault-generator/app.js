const el = {
    result: document.getElementById('result'),
    resultContainer: document.getElementById('result-container'),
    length: document.getElementById('length'),
    lengthNum: document.getElementById('length-num'),
    lengthLabel: document.getElementById('length-label'),
    lengthContainer: document.getElementById('length-container'),
    generateBtn: document.getElementById('generate-btn'),
    copyBtn: document.getElementById('copy-btn'),
    themeBtn: document.getElementById('theme-btn'),
    clearTime: document.getElementById('clear-time'),
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
    paranoidOverlay: document.getElementById('paranoid-overlay')
};

const CHARS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    nums: "0123456789"
};
const DEFAULT_SYMS = "!@#$%^&*()-_=+[]{};:,.<>/?|~";
const SAFE_SYMS = "!@#%^*-_=+:./?";

let currentMode = 'pwd'; // 'pwd', 'pass', 'user'
let clearTimer;

// --- DUAL-SYNC LENGTH LOGIC ---
function syncLength(e) {
    let val = parseInt(e.target.value);
    const min = parseInt(el.length.min);
    const max = parseInt(el.length.max);
    
    if (isNaN(val)) return;
    if (val < min) val = min;
    if (val > max) val = max;

    el.length.value = val;
    el.lengthNum.value = val;
    generate();
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
    
    calculateEntropyAndStrength();
}

function generatePassword() {
    const len = +el.length.value;
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

    let pwd = "";
    let isValid = false;

    // Character Class Guarantee
    while (!isValid) {
        pwd = "";
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
        isValid = activeSets.every(set => {
            const setChars = document.getElementById('opt-ambig').checked ? set.replace(/[lI1O0]/g, "") : set;
            return pwd.split('').some(char => setChars.includes(char));
        });
    }
    el.result.textContent = pwd;
}

function generatePassphrase() {
    const count = +el.length.value;
    const sep = document.getElementById('opt-pass-sep').value;
    let phrase = [];
    for (let i = 0; i < count; i++) {
        let word = WORDS[getSecureRandomInt(WORDS.length)];
        if (document.getElementById('opt-pass-caps').checked) word = word.charAt(0).toUpperCase() + word.slice(1);
        if (document.getElementById('opt-pass-nums').checked) word += getSecureRandomInt(10);
        phrase.push(word);
    }
    el.result.textContent = phrase.join(sep);
}

function generateUsername() {
    let w1 = WORDS[getSecureRandomInt(WORDS.length)];
    let w2 = WORDS[getSecureRandomInt(WORDS.length)];
    
    w1 = w1.charAt(0).toUpperCase() + w1.slice(1);
    w2 = w2.charAt(0).toUpperCase() + w2.slice(1);
    
    const sep = document.getElementById('opt-user-sep').value;
    let result = w1 + sep + w2;
    
    if (document.getElementById('opt-user-nums').checked) {
        let num = getSecureRandomInt(1000).toString().padStart(3, '0');
        result += sep ? sep + num : num;
    }
    
    el.result.textContent = result;
}

// --- STATS AND ENTROPY ---
function calculateEntropyAndStrength() {
    let entropy = 0;
    const len = +el.length.value;
    
    if (currentMode === 'pass') {
        let combinations = WORDS.length;
        if (document.getElementById('opt-pass-caps').checked) combinations *= 2;
        if (document.getElementById('opt-pass-nums').checked) combinations *= 10;
        entropy = len * Math.log2(combinations);
    } else if (currentMode === 'user') {
        entropy = 2 * Math.log2(WORDS.length);
        if (document.getElementById('opt-user-nums').checked) {
            entropy += Math.log2(1000); 
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
        entropy = len * Math.log2(poolSize || 1);
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
        strength = "Very Strong"; crackTime = "Indefinite"; colorClass = "strength-very-strong"; barColor = "#8a2be2";
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
    const delay = parseInt(el.clearTime.value);
    navigator.clipboard.writeText(el.result.textContent).then(() => {
        showToast(`Copied! Clearing in ${delay/1000}s`);
        el.copyBtn.textContent = `Copied! (${delay/1000}s)`;
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
            navigator.clipboard.writeText("");
            el.copyBtn.textContent = "Copy";
            showToast("Clipboard cleared.");
        }, delay);
    });
}

function updateUI() {
    el.tabPwd.classList.toggle('active', currentMode === 'pwd');
    el.tabPass.classList.toggle('active', currentMode === 'pass');
    el.tabUser.classList.toggle('active', currentMode === 'user');
    
    el.pwdOpts.classList.toggle('hidden', currentMode !== 'pwd');
    el.passOpts.classList.toggle('hidden', currentMode !== 'pass');
    el.userOpts.classList.toggle('hidden', currentMode !== 'user');
    
    if (currentMode === 'user') {
        el.lengthContainer.classList.add('hidden');
        el.length.classList.add('hidden');
    } else {
        el.lengthContainer.classList.remove('hidden');
        el.length.classList.remove('hidden');
        
        el.lengthLabel.textContent = currentMode === 'pass' ? "Words" : "Length";
        if (currentMode === 'pass') {
            el.length.min = el.lengthNum.min = 3;
            el.length.max = el.lengthNum.max = 20;
            if (el.length.value > 20) el.length.value = el.lengthNum.value = 10;
        } else {
            el.length.min = el.lengthNum.min = 4;
            el.length.max = el.lengthNum.max = 128;
            if (el.length.value < 12) el.length.value = el.lengthNum.value = 24;
        }
    }
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
    if (document.getElementById('opt-paranoid').checked) return; // Zero-persistence in paranoid mode
    
    const settings = {
        mode: currentMode,
        length: el.length.value,
        clearTime: el.clearTime.value,
        upper: document.getElementById('opt-upper').checked,
        lower: document.getElementById('opt-lower').checked,
        nums: document.getElementById('opt-nums').checked,
        syms: document.getElementById('opt-syms').checked,
        ambig: document.getElementById('opt-ambig').checked,
        safe: document.getElementById('opt-safe').checked,
        passCaps: document.getElementById('opt-pass-caps').checked,
        passNums: document.getElementById('opt-pass-nums').checked,
        passSep: document.getElementById('opt-pass-sep').value,
        userNums: document.getElementById('opt-user-nums').checked,
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
            if (saved.mode) currentMode = saved.mode;
            el.length.value = el.lengthNum.value = saved.length || 24;
            el.clearTime.value = saved.clearTime || "60000";
            
            if (saved.upper !== undefined) document.getElementById('opt-upper').checked = saved.upper;
            if (saved.lower !== undefined) document.getElementById('opt-lower').checked = saved.lower;
            if (saved.nums !== undefined) document.getElementById('opt-nums').checked = saved.nums;
            if (saved.syms !== undefined) document.getElementById('opt-syms').checked = saved.syms;
            if (saved.ambig !== undefined) document.getElementById('opt-ambig').checked = saved.ambig;
            if (saved.safe !== undefined) document.getElementById('opt-safe').checked = saved.safe;
            
            if (saved.passCaps !== undefined) document.getElementById('opt-pass-caps').checked = saved.passCaps;
            if (saved.passNums !== undefined) document.getElementById('opt-pass-nums').checked = saved.passNums;
            if (saved.passSep !== undefined) document.getElementById('opt-pass-sep').value = saved.passSep;
            
            if (saved.userNums !== undefined) document.getElementById('opt-user-nums').checked = saved.userNums;
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

// Handle Safe Only Characters Toggle
document.getElementById('opt-safe').addEventListener('change', (e) => {
    if (e.target.checked) {
        el.symInput.value = SAFE_SYMS;
    } else {
        el.symInput.value = DEFAULT_SYMS;
    }
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

document.getElementById('opt-paranoid').addEventListener('change', (e) => {
    document.body.classList.toggle('paranoid-active', e.target.checked);
    el.paranoidOverlay.classList.toggle('hidden', !e.target.checked);
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && document.getElementById('opt-paranoid').checked) {
        el.result.textContent = "";
    }
});

// Init
loadSettings();
updateUI();
