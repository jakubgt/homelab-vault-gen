const el = {
    result: document.getElementById('result'),
    resultContainer: document.getElementById('result-container'),
    length: document.getElementById('length'),
    lengthNum: document.getElementById('length-num'),
    lengthLabel: document.getElementById('length-label'),
    lengthWrapper: document.getElementById('length-wrapper'),
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
    pwdSymOpts: document.getElementById('pwd-sym-options'),
    passOpts: document.getElementById('pass-options'),
    userOpts: document.getElementById('user-options'),
    paranoidOverlay: document.getElementById('paranoid-overlay'),
    symPool: document.getElementById('sym-pool'),
    safeSyms: document.getElementById('opt-safe-syms')
};

const CHARS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    nums: "0123456789"
};

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
    else generateUsername();
}

function generatePassword() {
    const len = +el.length.value;
    let pool = "";
    const activeSets = [];

    if (document.getElementById('opt-upper').checked) { pool += CHARS.upper; activeSets.push(CHARS.upper); }
    if (document.getElementById('opt-lower').checked) { pool += CHARS.lower; activeSets.push(CHARS.lower); }
    if (document.getElementById('opt-nums').checked) { pool += CHARS.nums; activeSets.push(CHARS.nums); }
    if (document.getElementById('opt-syms').checked && el.symPool.value.length > 0) { 
        pool += el.symPool.value; 
        activeSets.push(el.symPool.value); 
    }
    
    if (document.getElementById('opt-ambig').checked) pool = pool.replace(/[lI1O0]/g, "");

    if (!pool) { el.result.textContent = "Select a pool!"; updateEntropyDisplay(0); return; }

    let pwd = "";
    let isValid = false;

    while (!isValid) {
        pwd = "";
        for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
        isValid = activeSets.every(set => {
            const setChars = document.getElementById('opt-ambig').checked ? set.replace(/[lI1O0]/g, "") : set;
            return pwd.split('').some(char => setChars.includes(char));
        });
    }
    el.result.textContent = pwd;
    
    let poolSize = pool.length;
    let entropy = len * Math.log2(poolSize || 1);
    updateEntropyDisplay(entropy);
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
    
    let combinations = WORDS.length;
    if (document.getElementById('opt-pass-caps').checked) combinations *= 2;
    if (document.getElementById('opt-pass-nums').checked) combinations *= 10;
    updateEntropyDisplay(count * Math.log2(combinations));
}

function generateUsername() {
    const sep = document.getElementById('opt-user-sep').value;
    let w1 = WORDS[getSecureRandomInt(WORDS.length)];
    let w2 = WORDS[getSecureRandomInt(WORDS.length)];
    w1 = w1.charAt(0).toUpperCase() + w1.slice(1);
    w2 = w2.charAt(0).toUpperCase() + w2.slice(1);
    
    let user = w1 + sep + w2;
    if (document.getElementById('opt-user-nums').checked) {
        user += getSecureRandomInt(1000).toString().padStart(3, '0'); // Append 000-999
    }
    
    el.result.textContent = user;
    
    let combinations = WORDS.length * WORDS.length;
    if (document.getElementById('opt-user-nums').checked) combinations *= 1000;
    updateEntropyDisplay(Math.log2(combinations));
}

// --- ENTROPY & STRENGTH ---

function formatCrackTime(entropy) {
    if (entropy <= 0) return "--";
    // Assuming offline crack speed of 100 billion hashes/second (modern GPU cluster)
    const guessesPerSec = 1e11; 
    const seconds = Math.pow(2, entropy) / guessesPerSec;
    
    if (seconds < 1) return "Instant";
    if (seconds < 60) return "Seconds";
    if (seconds < 3600) return Math.round(seconds / 60) + " mins";
    if (seconds < 86400) return Math.round(seconds / 3600) + " hours";
    if (seconds < 31536000) return Math.round(seconds / 86400) + " days";
    
    const years = seconds / 31536000;
    if (years < 100) return Math.round(years) + " years";
    if (years < 10000) return Math.round(years / 100) + " centuries";
    if (years < 1000000) return Math.round(years / 1000) + " millennia";
    return "Forever";
}

function updateEntropyDisplay(entropy) {
    el.entropyText.textContent = `Entropy: ${Math.round(entropy)} bits`;
    el.crackText.textContent = `Crack: ${formatCrackTime(entropy)}`;
    
    let strength = "Weak";
    let color = "#dc3545"; // Red
    
    if (entropy >= 80) { strength = "Very Strong"; color = "#8e44ad"; } // Purple
    else if (entropy >= 60) { strength = "Strong"; color = "#20c997"; } // Green
    else if (entropy >= 40) { strength = "Moderate"; color = "#ffc107"; } // Yellow
    
    el.strengthText.textContent = `Strength: ${strength}`;
    el.strengthText.style.color = color;
    
    el.entropyBar.style.width = `${Math.min(100, (entropy/128)*100)}%`;
    el.entropyBar.style.backgroundColor = color;
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
    el.pwdSymOpts.classList.toggle('hidden', currentMode !== 'pwd');
    el.passOpts.classList.toggle('hidden', currentMode !== 'pass');
    el.userOpts.classList.toggle('hidden', currentMode !== 'user');
    
    if (currentMode === 'pass') {
        el.lengthWrapper.classList.remove('hidden');
        el.lengthLabel.textContent = "Words";
        el.length.min = el.lengthNum.min = 3;
        el.length.max = el.lengthNum.max = 20;
        if (el.length.value > 20) el.length.value = el.lengthNum.value = 10;
    } else if (currentMode === 'pwd') {
        el.lengthWrapper.classList.remove('hidden');
        el.lengthLabel.textContent = "Length";
        el.length.min = el.lengthNum.min = 4;
        el.length.max = el.lengthNum.max = 128;
    } else if (currentMode === 'user') {
        el.lengthWrapper.classList.add('hidden'); // Fixed length for generated usernames
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

el.tabPwd.addEventListener('click', () => { currentMode = 'pwd'; updateUI(); });
el.tabPass.addEventListener('click', () => { currentMode = 'pass'; updateUI(); });
el.tabUser.addEventListener('click', () => { currentMode = 'user'; updateUI(); });

el.safeSyms.addEventListener('change', (e) => {
    el.symPool.value = e.target.checked ? "!@#$%^&*_-+=" : "!@#$%^&*()-_=+[]{};:,.<>/?|~";
    if (document.getElementById('opt-syms').checked) generate();
});
el.symPool.addEventListener('input', generate);

// Re-generate automatically when options change
document.querySelectorAll('input[type=checkbox], select').forEach(opt => {
    opt.addEventListener('change', generate);
});

document.getElementById('opt-paranoid').addEventListener('change', (e) => {
    document.body.classList.toggle('paranoid-active', e.target.checked);
    el.paranoidOverlay.classList.toggle('hidden', !e.target.checked);
});

// Load prefs and init
try {
    if (localStorage.getItem('vault_theme') === 'dark') {
        document.body.classList.add('dark-mode');
        el.themeBtn.textContent = '☀️';
    }
} catch (e) {}

updateUI();
