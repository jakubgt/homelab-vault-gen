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

// --- CORE LOGIC ---

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
    if (document.getElementById('opt-upper').checked) pool += CHARS.upper;
    if (document.getElementById('opt-lower').checked) pool += CHARS.lower;
    if (document.getElementById('opt-nums').checked) pool += CHARS.nums;
    if (document.getElementById('opt-syms').checked) pool += CHARS.syms;
    if (document.getElementById('opt-ambig').checked) pool = pool.replace(/[lI1O0]/g, "");

    if (!pool) { el.result.textContent = "Select a pool!"; return; }

    let pwd = "";
    for (let i = 0; i < len; i++) pwd += pool[getSecureRandomInt(pool.length)];
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

// --- FEEDBACK & UI ---

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'show';
    setTimeout(() => { toast.className = ''; }, 3000);
}

function triggerCopyFeedback() {
    const delay = parseInt(el.clearTime.value);
    el.resultContainer.classList.add('copy-flash');
    setTimeout(() => el.resultContainer.classList.remove('copy-flash'), 500);

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
        if (document.getElementById('opt-syms').checked) poolSize += 28;
        entropy = len * Math.log2(poolSize || 1);
    }
    el.entropyText.textContent = `Entropy: ${Math.round(entropy)} bits`;
    el.entropyBar.style.width = `${Math.min(100, (entropy/128)*100)}%`;
    el.entropyBar.style.backgroundColor = entropy > 100 ? "#20c997" : entropy > 60 ? "#ffc107" : "#dc3545";
}

// --- EVENT LISTENERS ---
el.generateBtn.addEventListener('click', generate);
el.copyBtn.addEventListener('click', triggerCopyFeedback);
el.length.addEventListener('input', () => { el.lengthVal.textContent = el.length.value; generate(); });
el.tabPwd.addEventListener('click', () => { isPassphrase = false; updateUI(); });
el.tabPass.addEventListener('click', () => { isPassphrase = true; updateUI(); });

function updateUI() {
    el.tabPwd.classList.toggle('active', !isPassphrase);
    el.tabPass.classList.toggle('active', isPassphrase);
    el.pwdOpts.classList.toggle('hidden', isPassphrase);
    el.passOpts.classList.toggle('hidden', !isPassphrase);
    el.lengthLabel.textContent = isPassphrase ? "Words" : "Length";
    el.length.min = isPassphrase ? 3 : 8;
    el.length.max = isPassphrase ? 12 : 64;
    generate();
}

document.getElementById('opt-paranoid').addEventListener('change', (e) => {
    document.body.classList.toggle('paranoid-active', e.target.checked);
    el.paranoidOverlay.classList.toggle('hidden', !e.target.checked);
});

generate();
