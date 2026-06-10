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
    tabPattern: document.getElementById('tab-pattern'),
    pwdOpts: document.getElementById('pwd-options'),
    passOpts: document.getElementById('pass-options'),
    userOpts: document.getElementById('user-options'),
    patternOpts: document.getElementById('pattern-options'),
    patternInput: document.getElementById('pattern-input'),
    symInput: document.getElementById('sym-input'),
    optCustomSyms: document.getElementById('opt-custom-syms'),
    paranoidOverlay: document.getElementById('paranoid-overlay'),
    poolInfo: document.getElementById('pool-info'),
    insecureWarning: document.getElementById('insecure-warning'),
    qrBtn: document.getElementById('qr-btn'),
    qrModal: document.getElementById('qr-modal'),
    qrClose: document.getElementById('qr-close'),
    qrContainer: document.getElementById('qr-container'),
    bulkCount: document.getElementById('bulk-count'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
    exportTxtBtn: document.getElementById('export-txt-btn')
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

// --- WORKING-BUFFER WIPING  ---
function wipeMemory() {
    if (activeSecretBuffer) {
        crypto.getRandomValues(activeSecretBuffer); 
        activeSecretBuffer.fill(0);                 
        activeSecretBuffer = null;
    }
}

function wipeSecret() {
    wipeMemory();
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
    const maxValid = Math.floor(4294967296 / max) * max;
    while (true) {
        crypto.getRandomValues(randomBytes);
        if (randomBytes[0] < maxValid) return randomBytes[0] % max;
    }
}

function readIntField(id, min, max, def) {
    const v = parseInt(document.getElementById(id).value, 10);
    if (!Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
}

function parsePattern(patternStr) {
    let tokens = [];
    const tokenRegex = /(\[[^\]]+\]|\\[\[\]\{\}\\]|.)(?:\{(\d+)\})?/g;
    let match;
    
    const expandCharset = (str) => {
        let res = "";
        for (let i = 0; i < str.length; i++) {
            if (str[i+1] === '-' && i+2 < str.length) {
                let start = str.charCodeAt(i);
                let end = str.charCodeAt(i+2);
                if (start <= end) {
                    for (let c = start; c <= end; c++) res += String.fromCharCode(c);
                }
                i += 2; 
            } else {
                res += str[i];
            }
        }
        return Array.from(new Set(res.split(''))).join('');
    };

    tokenRegex.lastIndex = 0;
    while ((match = tokenRegex.exec(patternStr)) !== null) {
        if (match[0] === '') { tokenRegex.lastIndex++; continue; } 
        
        let part = match[1];
        let count = match[2] ? parseInt(match[2], 10) : 1;
        
        let pool = "";
        if (part.startsWith('[') && part.endsWith(']')) {
            pool = expandCharset(part.slice(1, -1));
        } else if (part.startsWith('\\')) {
            pool = part.length > 1 ? part[1] : part; 
        } else {
            pool = part; 
        }
        
        if (pool.length > 0 && count > 0) tokens.push({ pool, count });
    }
    return tokens;
}

function generatePattern(skipDomUpdate = false) {
    wipeMemory();
    const patternStr = el.patternInput.value;
    if (!patternStr) {
        if (!skipDomUpdate) el.result.textContent = "Please enter a pattern.";
        return null;
    }

    const tokens = parsePattern(patternStr);
    let totalLen = tokens.reduce((sum, t) => sum + t.count, 0);

    if (totalLen === 0) {
        if (!skipDomUpdate) el.result.textContent = "Invalid pattern.";
        return null;
    }
    if (totalLen > 1000) {
        if (!skipDomUpdate) el.result.textContent = "Pattern too long (max 1000 chars).";
        return null;
    }

    activeSecretBuffer = new Uint8Array(totalLen);
    let offset = 0;
    
    for (let t of tokens) {
        for (let i = 0; i < t.count; i++) {
            activeSecretBuffer[offset++] = t.pool.charCodeAt(getSecureRandomInt(t.pool.length));
        }
    }
    
    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) el.result.textContent = generatedText;
    return generatedText;
}

function generate() {
    if (currentMode === 'pwd') generatePassword();
    else if (currentMode === 'pattern') generatePattern();
    else if (currentMode === 'pass') generatePassphrase();
    else if (currentMode === 'user') generateUsername();
    
    if (currentMode !== 'user') calculateEntropyAndStrength();
}

function generatePassword(skipDomUpdate = false) {
    wipeMemory(); 
    
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
            if (!skipDomUpdate) el.result.textContent = "Symbols enabled but pool is empty \u2014 add symbols or uncheck.";
            return null;
        }
    }
    
    if (document.getElementById('opt-ambig').checked) {
        pool = pool.replace(/[lI1O0]/g, "");
        for (let i = activeSets.length - 1; i >= 0; i--) {
            activeSets[i] = activeSets[i].replace(/[lI1O0]/g, "");
            if (activeSets[i].length === 0) activeSets.splice(i, 1);
        }
    }

    if (!pool) { if (!skipDomUpdate) el.result.textContent = "Select a pool!"; return null; }
    if (len < activeSets.length) { if (!skipDomUpdate) el.result.textContent = "Length must be \u2265 active sets!"; return null; }

    let isValid = false;
    let iterations = 0;
    const maxIterations = 1000;
    
    let activeSetsCodes = activeSets.map(set => {
        let arr = new Uint8Array(set.length);
        for(let i=0; i<set.length; i++) arr[i] = set.charCodeAt(i);
        return arr;
    });

    activeSecretBuffer = new Uint8Array(len);

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

    if (iterations >= maxIterations) {
        for (let i = 0; i < len; i++) {
            activeSecretBuffer[i] = pool.charCodeAt(getSecureRandomInt(pool.length));
        }
    }

    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) el.result.textContent = generatedText;
    return generatedText;
}

function generatePassphrase(skipDomUpdate = false) {
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

    if (doNums && !randomizePositions) { totalLength += (numCount * count); }
    if (count > 1) {
        if (sepChoice === 'random') totalLength += (count - 1);
        else if (sepChoice !== '') totalLength += (sepChoice.length * (count - 1));
    }
    if (doNums && randomizePositions) { totalLength += numCount; }

    activeSecretBuffer = new Uint8Array(totalLength);
    let offset = 0;

    const writeStr = (str) => {
        for(let i=0; i<str.length; i++) activeSecretBuffer[offset++] = str.charCodeAt(i);
    };

    for (let i = 0; i < count; i++) {
        let word = WORDS[wordIndices[i]];
        if (capMask[i]) {
            activeSecretBuffer[offset++] = word.charCodeAt(0) - 32; 
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

    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) el.result.textContent = generatedText;
    return generatedText;
}

function generateUsername(skipDomUpdate = false) {
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
    if (doNums) { totalLength += numCount; }

    activeSecretBuffer = new Uint8Array(totalLength);
    let offset = 0;

    const writeStr = (str) => {
        for(let i=0; i<str.length; i++) activeSecretBuffer[offset++] = str.charCodeAt(i);
    };

    for (let i = 0; i < count; i++) {
        let word = WORDS[wordIndices[i]];
        activeSecretBuffer[offset++] = word.charCodeAt(0) - 32; 
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
    
    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) el.result.textContent = generatedText;
    return generatedText;
}

// --- BULK EXPORT ---
function bulkExport(format) {
    let count = parseInt(el.bulkCount.value, 10);
    if (isNaN(count) || count < 1) count = 50;
    if (count > 10000) count = 10000;

    const results = [];
    for (let i = 0; i < count; i++) {
        let res;
        if (currentMode === 'pwd') res = generatePassword(true);
        else if (currentMode === 'pattern') res = generatePattern(true);
        else if (currentMode === 'pass') res = generatePassphrase(true);
        else if (currentMode === 'user') res = generateUsername(true);
        
        if (res) results.push(res);
        else break;
    }

    if (results.length === 0) {
        showToast("Failed to generate. Check your settings.");
        return;
    }

    el.result.textContent = results[results.length - 1];
    if (currentMode !== 'user') calculateEntropyAndStrength();

    let output = "";
    if (format === 'csv') {
        output = "Credential\n" + results.map(r => `"${r.replace(/"/g, '""')}"`).join("\n");
    } else {
        output = results.join("\n");
    }

    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `homelab_vault_${currentMode}_x${results.length}_${Date.now()}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${results.length} credentials!`);
    wipeMemory(); 
}

// --- STATS AND ENTROPY ---
function formatCrackTime(seconds) {
    if (!isFinite(seconds)) return 'longer than the age of the universe';
    if (seconds < 1) return 'instant';
    const MIN = 60, HOUR = 3600, DAY = 86400, YEAR = 31557600;
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
        if (document.getElementById('opt-pass-sep').value === 'random') {
            entropy += Math.max(0, lengths.pass - 1) * Math.log2(11);
        }
        if (document.getElementById('opt-pass-nums').checked) {
            let numCount = readIntField('pass-num-count', 1, 10, 2);
            let randomizePositions = document.getElementById('opt-pass-nums-rand').checked;
            
            if (randomizePositions) {
                entropy += numCount * Math.log2(10);
            } else {
                entropy += (numCount * lengths.pass) * Math.log2(10);
            }
        }
    } else if (currentMode === 'pattern') {
        const tokens = parsePattern(el.patternInput.value);
        let totalLen = 0;
        for (let t of tokens) {
            if (t.pool.length > 1) {
                entropy += t.count * Math.log2(t.pool.length);
            }
            totalLen += t.count;
        }
        if (el.poolInfo) el.poolInfo.textContent = `Pattern Length: ${totalLen} chars`;
    } else {
        let poolSize = 0;
        if (document.getElementById('opt-upper').checked) poolSize += 26;
        if (document.getElementById('opt-lower').checked) poolSize += 26;
        if (document.getElementById('opt-nums').checked) poolSize += 10;
        if (document.getElementById('opt-syms').checked) {
            const uniqueSyms = new Set(el.symInput.value.split('')).size;
            poolSize += uniqueSyms;
        }
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
    el.entropyBar.style.width = `${Math.min(100, (entropy/128)*100)}%`;
    
    let strength = "Weak";
    let colorClass = "strength-weak";
    let barColor = "#dc3545";
    const seconds = Math.pow(2, entropy) / 1e11;

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

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0"; textArea.style.left = "0"; textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try { document.execCommand('copy'); } catch (err) { console.error('Fallback: Oops, unable to copy', err); }
    document.body.removeChild(textArea);
}

function triggerCopyFeedback() {
    const textToCopy = el.result.textContent;
    if (!textToCopy) return; 

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
            wipeSecret();
            const garbageLen = 24 + getSecureRandomInt(24);
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

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(textToCopy).then(onSuccess).catch(err => {
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
    el.tabPattern.classList.toggle('active', currentMode === 'pattern');
    el.tabPass.classList.toggle('active', currentMode === 'pass');
    el.tabUser.classList.toggle('active', currentMode === 'user');
    
    el.pwdOpts.classList.toggle('hidden', currentMode !== 'pwd');
    el.patternOpts.classList.toggle('hidden', currentMode !== 'pattern');
    el.passOpts.classList.toggle('hidden', currentMode !== 'pass');
    el.userOpts.classList.toggle('hidden', currentMode !== 'user');
    
    if (currentMode === 'user') {
        el.lengthContainer.classList.remove('hidden'); el.length.classList.remove('hidden');
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
    } else if (currentMode === 'pattern') {
        el.lengthContainer.classList.add('hidden');
        el.length.classList.add('hidden');
        el.metricsContainer.classList.remove('hidden'); 
    } else {
        el.lengthContainer.classList.remove('hidden');
        el.length.classList.remove('hidden');
        el.metricsContainer.classList.remove('hidden'); 
        el.lengthLabel.textContent = "Length";
        el.length.min = el.lengthNum.min = 4;
        el.length.max = el.lengthNum.max = 128;
    }
    
    if (currentMode !== 'pattern') el.length.value = el.lengthNum.value = lengths[currentMode];
    toggleNestedInputs();
    generate();
}

function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    el.themeBtn.textContent = isDark ? '☀️' : '🌙';
    try { localStorage.setItem('vault_theme', isDark ? 'dark' : 'light'); } catch (e) {}
}

function saveSettings() {
    if (document.getElementById('opt-paranoid').checked) return; 
    
    const settings = {
        lengths: lengths,
        clearTime: el.clearTime.value,
        customClearTime: el.customClearTime.value,
        bulkCount: el.bulkCount.value,
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
        symPool: el.symInput.value,
        patternStr: el.patternInput.value
    };
    try { localStorage.setItem('vault_settings', JSON.stringify(settings)); } catch(e) {}
}

function loadSettings() {
    try {
        const savedTheme = localStorage.getItem('vault_theme');
        if (savedTheme === 'dark') {
            document.body.classList.add('dark-mode');
            el.themeBtn.textContent = '☀️';
        } else if (savedTheme === null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.body.classList.add('dark-mode');
            el.themeBtn.textContent = '☀️';
        }
        
        const saved = JSON.parse(localStorage.getItem('vault_settings'));
        if (saved) {
            if (saved.lengths && typeof saved.lengths === 'object') {
                const clamp = (v, min, max, def) => (Number.isInteger(v) && v >= min && v <= max) ? v : def;
                lengths.pwd  = clamp(saved.lengths.pwd, 4, 128, 24);
                lengths.pass = clamp(saved.lengths.pass, 3, 20, 6);
                lengths.user = clamp(saved.lengths.user, 1, 10, 2);
            }
            if (saved.clearTime !== undefined) {
                el.clearTime.value = saved.clearTime;
                el.customClearTime.classList.toggle('hidden', saved.clearTime !== 'custom');
            }
            if (saved.customClearTime !== undefined) el.customClearTime.value = saved.customClearTime;
            if (saved.bulkCount !== undefined) el.bulkCount.value = saved.bulkCount;
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
            if (saved.patternStr !== undefined) el.patternInput.value = saved.patternStr;
        }
    } catch(e) {}
}

// --- LISTENERS ---
el.themeBtn.addEventListener('click', toggleTheme);
el.generateBtn.addEventListener('click', generate);
el.copyBtn.addEventListener('click', triggerCopyFeedback);
el.resultContainer.addEventListener('click', triggerCopyFeedback); 
el.length.addEventListener('input', syncLength);
el.lengthNum.addEventListener('input', syncLength);
el.tabPwd.addEventListener('click', () => { currentMode = 'pwd'; updateUI(); saveSettings(); });
el.tabPass.addEventListener('click', () => { currentMode = 'pass'; updateUI(); saveSettings(); });
el.tabUser.addEventListener('click', () => { currentMode = 'user'; updateUI(); saveSettings(); });
el.tabPattern.addEventListener('click', () => { currentMode = 'pattern'; updateUI(); saveSettings(); });
el.patternInput.addEventListener('input', () => { generate(); saveSettings(); });
el.clearTime.addEventListener('change', (e) => { el.customClearTime.classList.toggle('hidden', e.target.value !== 'custom'); saveSettings(); });
el.customClearTime.addEventListener('input', saveSettings);
document.getElementById('opt-pass-caps').addEventListener('change', () => { toggleNestedInputs(); generate(); saveSettings(); });
document.getElementById('opt-pass-nums').addEventListener('change', () => { toggleNestedInputs(); generate(); saveSettings(); });
document.getElementById('opt-user-nums').addEventListener('change', () => { toggleNestedInputs(); generate(); saveSettings(); });
el.symInput.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\s+/g, ''); });
el.optCustomSyms.addEventListener('change', (e) => {
    el.symInput.classList.toggle('hidden', !e.target.checked);
    if (!e.target.checked) el.symInput.value = document.getElementById('opt-safe').checked ? SAFE_SYMS : DEFAULT_SYMS;
    generate();
    saveSettings();
});
document.getElementById('opt-safe').addEventListener('change', (e) => {
    if (e.target.checked) el.symInput.value = SAFE_SYMS;
    else el.symInput.value = DEFAULT_SYMS;
    generate();
});
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
    if (e.target.checked) { try { localStorage.clear(); } catch(err) {} } else { saveSettings(); }
});
window.addEventListener('beforeunload', () => {
    if (document.getElementById('opt-paranoid').checked) { wipeSecret(); try { localStorage.clear(); } catch(err) {} }
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && document.getElementById('opt-paranoid').checked) { wipeSecret(); }
});
document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return;
    e.preventDefault();
    generate();
});
function checkSecureContext() {
    if (!el.insecureWarning) return;
    const cryptoOk = window.crypto && typeof window.crypto.getRandomValues === 'function';
    if (!cryptoOk) el.insecureWarning.classList.remove('hidden');
}
el.exportCsvBtn.addEventListener('click', () => bulkExport('csv'));
el.exportTxtBtn.addEventListener('click', () => bulkExport('txt'));
el.bulkCount.addEventListener('input', saveSettings);

// --- QR CODE EXPORT ---
el.qrBtn.addEventListener('click', () => {
    const text = el.result.textContent;
    if (!text) return;
    if (typeof QRCode === 'undefined') { showToast("QR Library missing. Download qrcode.min.js!"); return; }
    el.qrContainer.innerHTML = "";
    new QRCode(el.qrContainer, { text: text, width: 200, height: 200, colorDark : "#000000", colorLight : "#ffffff", correctLevel : QRCode.CorrectLevel.M });
    el.qrModal.classList.remove('hidden');
});
el.qrClose.addEventListener('click', () => {
    el.qrModal.classList.add('hidden');
    el.qrContainer.innerHTML = "";
});

loadSettings();
updateUI();
checkSecureContext();
