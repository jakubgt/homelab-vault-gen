// DOM Elements
const el = {
    result: document.getElementById('result'),
    resultContainer: document.getElementById('result-container'),
    length: document.getElementById('length'),
    lengthVal: document.getElementById('length-val'),
    lengthLabel: document.getElementById('length-label'),
    generateBtn: document.getElementById('generate-btn'),
    copyBtn: document.getElementById('copy-btn'),
    themeBtn: document.getElementById('theme-btn'),
    clearTime: document.getElementById('clear-time'),
    customTime: document.getElementById('custom-time'),
    entropyText: document.getElementById('entropy-text'),
    entropyBar: document.getElementById('entropy-bar'),
    tabPwd: document.getElementById('tab-pwd'),
    tabPass: document.getElementById('tab-pass'),
    pwdOpts: document.getElementById('pwd-options'),
    passOpts: document.getElementById('pass-options'),
    paranoidOverlay: document.getElementById('paranoid-overlay')
};

// Character Sets
const CHARS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    nums: "0123456789",
    syms: "!@#$%^&*()-_=+[]{};:,.<>/?|~"
};
const AMBIGUOUS = /[lI1O0]/g;

// A small subset of the EFF short wordlist for demonstration. 
// In a true homelab, replace this array with the full 7776 EFF wordlist.
const WORDS = ["apple", "battery", "staple", "horse", "quantum", "solar", "river", "lantern", "cyber", "vault", "shield", "nexus", "pulse", "orbit", "cipher", "beacon"];

let isPassphrase = false;
let clearTimer;

// --- INITIALIZATION & STATE ---
function init() {
    loadPrefs();
    updateUI();
    generate();
}

function safeSetItem(key, value) {
    if (!document.getElementById('opt-paranoid').checked) {
        localStorage.setItem(key, value);
    }
}

function loadPrefs() {
    if (localStorage.getItem('vault_paranoid') === 'true') {
        document.getElementById('opt-paranoid').checked = true;
        return; // Don't load other prefs if paranoid
    }
    
    if (localStorage.getItem('vault_theme') === 'dark') toggleTheme(true);
    if (localStorage.getItem('vault_len')) el.length.value = localStorage.getItem('vault_len');
    if (localStorage.getItem('vault_timer_type')) el.clearTime.value = localStorage.getItem('vault_timer_type');
    
    ['upper', 'lower', 'nums', 'syms', 'ambig', 'pass-caps', 'pass-nums'].forEach(id => {
        const val = localStorage.getItem(`vault_${id}`);
        if (val !== null) document.getElementById(`opt-${id}`).checked = (val === 'true');
    });
}

function toggleTheme(forceDark = false) {
    const isDark = forceDark || !document.body.classList.contains('dark-mode');
    document.body.classList.toggle('dark-mode', isDark);
    el.themeBtn.textContent = isDark ? '☀️' : '🌙';
    safeSetItem('vault_theme', isDark ? 'dark' : 'light');
}

function updateUI() {
    el.lengthVal.textContent = el.length.value;
    el.customTime.style.display = el.clearTime.value === 'custom' ? 'block' : 'none';
    
    el.pwdOpts.classList.toggle('hidden', isPassphrase);
    el.passOpts.classList.toggle('hidden', !isPassphrase);
    el.lengthLabel.textContent = isPassphrase ? 'Words' : 'Length';
    
    // Adjust slider limits
    el.length.min = isPassphrase ? 3 : 8;
    el.length.max = isPassphrase ? 12 : 128;
    
    const isParanoid = document.getElementById('opt-paranoid').checked;
    document.body.classList.toggle('paranoid-active', isParanoid);
    el.paranoidOverlay.classList.toggle('hidden', !isParanoid);
    
    if (isParanoid) {
        localStorage.clear(); // Nuke storage
        el.copyBtn.disabled = true;
        el.copyBtn.textContent = "Copy Disabled (Paranoid)";
    } else {
        el.copyBtn.disabled = false;
        el.copyBtn.textContent = "Copy";
    }
}

// --- GENERATION LOGIC ---

// Cryptographically secure random integer using rejection sampling
function getSecureRandomInt(max) {
    const randomBytes = new Uint8Array(1);
    const maxValid = Math.floor(256 / max) * max;
    while (true) {
        crypto.getRandomValues(randomBytes);
        if (randomBytes[0] < maxValid) {
            return randomBytes[0] % max;
        }
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
    if (document.getElementById('opt-syms').checked) { pool += CHARS.syms; activeSets.push(CHARS.syms); }

    if (document.getElementById('opt-ambig').checked) {
        pool = pool.replace(AMBIGUOUS, "");
        activeSets.forEach((set, i) => activeSets[i] = set.replace(AMBIGUOUS, ""));
    }

    if (!pool) {
        el.result.textContent = "Select at least one character set!";
        return;
    }

    let password;
    let valid = false;

    // Generate and enforce Character Class Guarantees
    while (!valid) {
        password = "";
        for (let i = 0; i < len; i++) {
            password += pool[getSecureRandomInt(pool.length)];
        }
        
        valid = true;
        for (const set of activeSets) {
            if (set.length > 0 && !password.split('').some(c => set.includes(c))) {
                valid = false;
                break;
            }
        }
    }

    el.result.textContent = password;
}

function generatePassphrase() {
    const count = +el.length.value;
    const sep = document.getElementById('opt-pass-sep').value;
    const caps = document.getElementById('opt-pass-caps').checked;
    const nums = document.getElementById('opt-pass-nums').checked;
    
    let phrase = [];
    for (let i = 0; i < count; i++) {
        let word = WORDS[getSecureRandomInt(WORDS.length)];
        if (caps) word = word.charAt(0).toUpperCase() + word.slice(1);
        if (nums) word += getSecureRandomInt(10); // Append 0-9
        phrase.push(word);
    }
    el.result.textContent = phrase.join(sep);
}

function calculateEntropy() {
    let entropy = 0;
    if (isPassphrase) {
        const count = +el.length.value;
        let combinations = WORDS.length;
        if (document.getElementById('opt-pass-caps').checked) combinations *= 2;
        if (document.getElementById('opt-pass-nums').checked) combinations *= 10;
        entropy = count * Math.log2(combinations);
    } else {
        const len = +el.length.value;
        let poolSize = 0;
        if (document.getElementById('opt-upper').checked) poolSize += 26;
        if (document.getElementById('opt-lower').checked) poolSize += 26;
        if (document.getElementById('opt-nums').checked) poolSize += 10;
        if (document.getElementById('opt-syms').checked) poolSize += 28;
        if (document.getElementById('opt-ambig').checked) poolSize = Math.max(1, poolSize - 5);
        
        if (poolSize > 0) {
            entropy = len * Math.log2(poolSize);
        }
    }

    entropy = Math.round(entropy);
    el.entropyText.textContent = `Entropy: ${entropy} bits`;
    
    // Update Bar Color
    let color = "#dc3545"; // weak
    let pct = Math.min(100, (entropy / 128) * 100);
    if (entropy > 60) color = "#ffc107"; // ok
    if (entropy > 80) color = "#28a745"; // strong
    if (entropy > 120) color = "#20c997"; // overkill
    
    el.entropyBar.style.width = `${pct}%`;
    el.entropyBar.style.backgroundColor = color;
}

// --- EVENT LISTENERS ---

el.themeBtn.addEventListener('click', () => toggleTheme(false));
el.generateBtn.addEventListener('click', generate);

// Keyboard UX: Enter generates new password
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') generate();
});

// Auto-select on click & Click to Copy
el.resultContainer.addEventListener('click', () => {
    if (document.getElementById('opt-paranoid').checked) return;
    
    const range = document.createRange();
    range.selectNodeContents(el.result);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    
    navigator.clipboard.writeText(el.result.textContent).then(triggerCopyFeedback);
});

el.copyBtn.addEventListener('click', () => {
    if (document.getElementById('opt-paranoid').checked) return;
    navigator.clipboard.writeText(el.result.textContent).then(triggerCopyFeedback);
});

function triggerCopyFeedback() {
    let delay = el.clearTime.value === 'custom' ? parseInt(el.customTime.value) * 1000 : parseInt(el.clearTime.value);
    if (isNaN(delay) || delay <= 0) delay = 60000;

    el.copyBtn.textContent = `Copied! (Clears in ${delay/1000}s)`;
    clearTimeout(clearTimer);
    
    clearTimer = setTimeout(() => {
        navigator.clipboard.writeText("");
        el.copyBtn.textContent = "Copy";
    }, delay);
}

// Tabs
el.tabPwd.addEventListener('click', () => { isPassphrase = false; el.tabPwd.classList.add('active'); el.tabPass.classList.remove('active'); updateUI(); generate(); });
el.tabPass.addEventListener('click', () => { isPassphrase = true; el.tabPass.classList.add('active'); el.tabPwd.classList.remove('active'); updateUI(); generate(); });

// Controls
el.length.addEventListener('input', () => { safeSetItem('vault_len', el.length.value); updateUI(); generate(); });
el.clearTime.addEventListener('change', () => { safeSetItem('vault_timer_type', el.clearTime.value); updateUI(); });

// Auto-save & generate on option change
document.querySelectorAll('.options-grid input, .options-grid select, #opt-paranoid').forEach(input => {
    input.addEventListener('change', (e) => {
        if (e.target.id) safeSetItem(`vault_${e.target.id.replace('opt-', '')}`, e.target.checked);
        updateUI();
        generate();
    });
});

// Memory Wiping: Clear password on tab hide / unload
document.addEventListener('visibilitychange', () => {
    if (document.hidden) el.result.textContent = "";
    else generate(); // Regenerate on focus
});
window.addEventListener('beforeunload', () => { el.result.textContent = ""; });

init();
