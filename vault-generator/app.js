const el = {
    result: document.getElementById('result'),
    resultContainer: document.getElementById('result-container'),
    length: document.getElementById('length'),
    lengthNum: document.getElementById('length-num'),
    lengthLabel: document.getElementById('length-label'),
    generateBtn: document.getElementById('generate-btn'),
    copyBtn: document.getElementById('copy-btn'),
    themeBtn: document.getElementById('theme-btn'),
    clearTime: document.getElementById('clear-time'),
    entropyText: document.getElementById('entropy-text'),
    entropyBar: document.getElementById('entropy-bar'),
    tabPwd: document.getElementById('tab-pwd'),
    tabPass: document.getElementById('tab-pass'),
    pwdOpts: document.getElementById('pwd-options'),
    passOpts: document.getElementById('pass-options'),
    paranoidOverlay: document.getElementById('paranoid-overlay')
};

const CHARS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    nums: "0123456789",
    syms: "!@#$%^&*()-_=+[]{};:,.<>/?|~"
};

let isPassphrase = false;
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
    isPassphrase ? generatePassphrase() : generatePassword();
    calculateEntropy();
}

function generatePassword() {
    const len = +el.length.value;
    let pool = "";
    const activeSets = [];

    if (document.getElementById('opt-upper').checked) { pool += CHARS.upper; activeSets.push(CHARS.upper); }
    if (document.getElementById('opt-lower').checked) { pool += CHARS.lower; activeSets.push(CHARS.lower); }
    if (document.getElementById('opt-nums').checked) { pool += CHARS.nums; activeSets.push(CHARS.nums); }
    
    // Updated Symbol Logic for Terminal / YAML Safe Mode
    if (document.getElementById('opt-syms').checked) {
        let symPool = CHARS.syms;
        if (document.getElementById('opt-safe').checked) {
            symPool = "!@#%^*-_=+:./?"; 
        }
        pool += symPool;
        activeSets.push(symPool);
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

function calculateEntropy() {
    let entropy = 0;
    const len = +el.length.value;
    if (isPassphrase) {
        let combinations = WORDS.length;
        if (document.getElementById('opt-pass-caps').checked) combinations *= 2;
        if (document.getElementById('opt-pass-nums').checked) combinations *= 10;
        entropy = len * Math.log2(combinations);
    } else {
        let poolSize = 0;
        if (document.getElementById('opt-upper').checked) poolSize += 26;
        if (document.getElementById('opt-lower').checked) poolSize += 26;
        if (document.getElementById('opt-nums').checked) poolSize += 10;
        if (document.getElementById('opt-syms').checked) {
            // Adjust entropy calculation if safe mode reduces the symbol pool
            poolSize += document.getElementById('opt-safe').checked ? 16 : 28;
        }
        entropy = len * Math.log2(poolSize || 1);
    }
    el.entropyText.textContent = `Entropy: ${Math.round(entropy)} bits`;
    el.entropyBar.style.width = `${Math.min(100, (entropy/128)*100)}%`;
    el.entropyBar.style.backgroundColor = entropy > 100 ? "#20c997" : entropy > 60 ? "#ffc107" : "#dc3545";
}

function updateUI() {
    el.tabPwd.classList.toggle('active', !isPassphrase);
    el.tabPass.classList.toggle('active', isPassphrase);
    el.pwdOpts.classList.toggle('hidden', isPassphrase);
    el.passOpts.classList.toggle('hidden', !isPassphrase);
    el.lengthLabel.textContent = isPassphrase ? "Words" : "Length";
    
    if (isPassphrase) {
        el.length.min = el.lengthNum.min = 3;
        el.length.max = el.lengthNum.max = 20;
        if (el.length.value > 20) el.length.value = el.lengthNum.value = 10;
    } else {
        el.length.min = el.lengthNum.min = 4;
        el.length.max = el.lengthNum.max = 128;
    }
    generate();
}

// --- THEME ---
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    el.themeBtn.textContent = isDark ? '☀️' : '🌙';
    try { localStorage.setItem('vault_theme', isDark ? 'dark' : 'light'); } catch (e) {}
}

// --- LISTENERS ---
el.themeBtn.addEventListener('click', toggleTheme);
el.generateBtn.addEventListener('click', generate);
el.copyBtn.addEventListener('click', triggerCopyFeedback);
el.length.addEventListener('input', syncLength);
el.lengthNum.addEventListener('input', syncLength);
el.tabPwd.addEventListener('click', () => { isPassphrase = false; updateUI(); });
el.tabPass.addEventListener('click', () => { isPassphrase = true; updateUI(); });

// Regenerate immediately if any options change
document.querySelectorAll('.options-grid input, #opt-pass-sep').forEach(input => {
    input.addEventListener('change', generate);
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

// Load prefs and init
try {
    if (localStorage.getItem('vault_theme') === 'dark') {
        document.body.classList.add('dark-mode');
        el.themeBtn.textContent = '☀️';
    }
} catch (e) {}

generate();
