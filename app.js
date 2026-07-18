'use strict';

const {
    CHARS,
    DEFAULT_SYMS,
    CONFIG_FRIENDLY_SYMS,
    calculatePasswordEntropy,
    generatePasswordBytes,
    getSecureRandomInt,
    normalizeSymbolPool,
    parsePattern
} = VaultCore;

const RANDOM_SEPARATOR_POOL = '!@#$%^&*-_=+';
const STORAGE_KEYS = Object.freeze({
    settings: 'vault_settings',
    theme: 'vault_theme'
});
const MODES = Object.freeze(['pwd', 'pass', 'user', 'pattern']);

const el = {
    result: document.getElementById('result'),
    resultContainer: document.getElementById('result-container'),
    generationError: document.getElementById('generation-error'),
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
    symbolPreset: document.getElementById('symbol-preset'),
    symInput: document.getElementById('sym-input'),
    paranoidOverlay: document.getElementById('paranoid-overlay'),
    poolInfo: document.getElementById('pool-info'),
    insecureWarning: document.getElementById('insecure-warning'),
    qrBtn: document.getElementById('qr-btn'),
    qrModal: document.getElementById('qr-modal'),
    qrClose: document.getElementById('qr-close'),
    qrContainer: document.getElementById('qr-container'),
    bulkCount: document.getElementById('bulk-count'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
    exportTxtBtn: document.getElementById('export-txt-btn'),
    resetSettingsBtn: document.getElementById('reset-settings-btn'),
    toast: document.getElementById('toast')
};

const tabs = [el.tabPwd, el.tabPass, el.tabUser, el.tabPattern];
const panels = {
    pwd: el.pwdOpts,
    pass: el.passOpts,
    user: el.userOpts,
    pattern: el.patternOpts
};
const tabByMode = {
    pwd: el.tabPwd,
    pass: el.tabPass,
    user: el.tabUser,
    pattern: el.tabPattern
};

let currentMode = 'pwd';
let lengths = { pwd: 24, pass: 6, user: 2 };
let activeSecretBuffer = null;
let currentResult = null;
let clearTimer = null;
let toastTimer = null;

function hasSecureRandom() {
    return Boolean(window.crypto && typeof window.crypto.getRandomValues === 'function');
}

function isParanoid() {
    return document.getElementById('opt-paranoid').checked;
}

function wipeMemory() {
    if (!activeSecretBuffer) return;

    try {
        if (hasSecureRandom()) window.crypto.getRandomValues(activeSecretBuffer);
    } catch (error) {
        // Zero-filling still clears the mutable buffer if random overwriting fails.
    }
    activeSecretBuffer.fill(0);
    activeSecretBuffer = null;
}

function cleanupQr() {
    el.qrContainer.replaceChildren();
    el.qrContainer.removeAttribute('title');
}

function closeQr() {
    if (el.qrModal.open) el.qrModal.close();
    cleanupQr();
}

function cancelClearTimer() {
    clearTimeout(clearTimer);
    clearTimer = null;
    el.copyBtn.textContent = 'Copy';
}

function resetMetrics() {
    el.entropyText.textContent = 'Entropy: —';
    el.strengthText.textContent = 'Strength: —';
    el.strengthText.className = '';
    el.crackText.textContent = 'Estimated offline crack time: —';
    el.poolInfo.textContent = '';
    el.entropyBar.value = 0;
    el.entropyBar.className = 'entropy-weak';
}

function updateActionAvailability() {
    const canGenerate = hasSecureRandom();
    const hasResult = typeof currentResult === 'string' && currentResult.length > 0;
    const allowFiles = hasResult && canGenerate && !isParanoid();

    el.generateBtn.disabled = !canGenerate;
    el.copyBtn.disabled = !hasResult;
    el.qrBtn.disabled = !hasResult;
    el.exportCsvBtn.disabled = !allowFiles;
    el.exportTxtBtn.disabled = !allowFiles;
}

function setParanoidReveal(revealed) {
    const shouldReveal = Boolean(revealed && isParanoid());
    document.body.classList.toggle('paranoid-revealed', shouldReveal);
    el.paranoidOverlay.textContent = shouldReveal ? 'Hide' : 'Reveal';
    el.paranoidOverlay.setAttribute('aria-pressed', String(shouldReveal));
}

function clearGenerationError() {
    el.generationError.textContent = '';
    el.generationError.classList.add('hidden');
    el.patternInput.removeAttribute('aria-invalid');
    el.symInput.removeAttribute('aria-invalid');
    el.lengthNum.removeAttribute('aria-invalid');
}

function setResult(value) {
    closeQr();
    cancelClearTimer();
    clearGenerationError();
    setParanoidReveal(false);

    currentResult = value;
    el.result.textContent = value;
    el.resultContainer.classList.add('has-result');
    updateActionAvailability();
}

function setGenerationError(message, input = null) {
    closeQr();
    cancelClearTimer();
    wipeMemory();
    currentResult = null;
    el.result.textContent = '';
    el.resultContainer.classList.remove('has-result');
    el.generationError.textContent = message;
    el.generationError.classList.remove('hidden');
    if (input) input.setAttribute('aria-invalid', 'true');
    resetMetrics();
    updateActionAvailability();
}

function wipeSecret() {
    closeQr();
    cancelClearTimer();
    wipeMemory();
    setParanoidReveal(false);
    currentResult = null;
    el.result.textContent = '';
    el.resultContainer.classList.remove('has-result');
    clearGenerationError();
    resetMetrics();
    updateActionAvailability();
}

function readIntField(id, min, max, fallback) {
    const value = Number.parseInt(document.getElementById(id).value, 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function getPasswordCharsets() {
    const sets = [];
    if (document.getElementById('opt-upper').checked) sets.push(CHARS.upper);
    if (document.getElementById('opt-lower').checked) sets.push(CHARS.lower);
    if (document.getElementById('opt-nums').checked) sets.push(CHARS.nums);

    if (document.getElementById('opt-syms').checked) {
        const symbols = normalizeSymbolPool(el.symInput.value);
        el.symInput.value = symbols;
        if (!symbols) return { error: 'Add at least one printable ASCII symbol or turn off Symbols.' };
        sets.push(symbols);
    }

    const filtered = document.getElementById('opt-ambig').checked
        ? sets.map((set) => set.replace(/[lI1O0]/g, '')).filter(Boolean)
        : sets;

    if (filtered.length === 0) return { error: 'Select at least one character set.' };
    return { sets: filtered };
}

function generatePassword(skipDomUpdate = false) {
    wipeMemory();
    const selection = getPasswordCharsets();

    if (selection.error) {
        if (!skipDomUpdate) setGenerationError(selection.error, document.getElementById('opt-syms').checked ? el.symInput : null);
        return null;
    }
    if (lengths.pwd < selection.sets.length) {
        if (!skipDomUpdate) setGenerationError('Length must be at least the number of selected character sets.', el.lengthNum);
        return null;
    }

    try {
        activeSecretBuffer = generatePasswordBytes(lengths.pwd, selection.sets);
    } catch (error) {
        if (!skipDomUpdate) setGenerationError(error.message);
        return null;
    }

    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) setResult(generatedText);
    return generatedText;
}

function generatePattern(skipDomUpdate = false) {
    wipeMemory();
    const analysis = parsePattern(el.patternInput.value);

    if (analysis.error) {
        if (!skipDomUpdate) setGenerationError(analysis.error, el.patternInput);
        return null;
    }

    activeSecretBuffer = new Uint8Array(analysis.totalLength);
    let offset = 0;

    for (const token of analysis.tokens) {
        for (let index = 0; index < token.count; index++) {
            activeSecretBuffer[offset++] = token.pool.charCodeAt(getSecureRandomInt(token.pool.length));
        }
    }

    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) setResult(generatedText);
    return generatedText;
}

function generatePassphrase(skipDomUpdate = false) {
    wipeMemory();

    const count = lengths.pass;
    const separatorChoice = document.getElementById('opt-pass-sep').value;
    const capitalize = document.getElementById('opt-pass-caps').checked;
    const randomizeCaps = document.getElementById('opt-pass-caps-rand').checked;
    const insertNumbers = document.getElementById('opt-pass-nums').checked;
    const numberCount = readIntField('pass-num-count', 1, 10, 2);
    const randomizePositions = document.getElementById('opt-pass-nums-rand').checked;

    const wordIndices = [];
    const capitalizationMask = [];
    let totalLength = 0;

    for (let index = 0; index < count; index++) {
        const wordIndex = getSecureRandomInt(WORDS.length);
        wordIndices.push(wordIndex);
        totalLength += WORDS[wordIndex].length;
        capitalizationMask.push(capitalize && (!randomizeCaps || getSecureRandomInt(2) === 1));
    }

    if (insertNumbers && !randomizePositions) totalLength += numberCount * count;
    if (count > 1) totalLength += count - 1;
    if (insertNumbers && randomizePositions) totalLength += numberCount;

    activeSecretBuffer = new Uint8Array(totalLength);
    let offset = 0;

    const writeString = (value) => {
        for (let index = 0; index < value.length; index++) {
            activeSecretBuffer[offset++] = value.charCodeAt(index);
        }
    };

    for (let index = 0; index < count; index++) {
        const word = WORDS[wordIndices[index]];
        if (capitalizationMask[index]) {
            activeSecretBuffer[offset++] = word.charCodeAt(0) - 32;
            writeString(word.slice(1));
        } else {
            writeString(word);
        }

        if (insertNumbers && !randomizePositions) {
            for (let numberIndex = 0; numberIndex < numberCount; numberIndex++) {
                activeSecretBuffer[offset++] = 48 + getSecureRandomInt(10);
            }
        }

        if (index < count - 1) {
            if (separatorChoice === 'random') {
                activeSecretBuffer[offset++] = RANDOM_SEPARATOR_POOL.charCodeAt(getSecureRandomInt(RANDOM_SEPARATOR_POOL.length));
            } else {
                writeString(separatorChoice);
            }
        }
    }

    if (insertNumbers && randomizePositions) {
        let currentLength = offset;
        for (let index = 0; index < numberCount; index++) {
            const targetIndex = getSecureRandomInt(currentLength + 1);
            for (let shiftIndex = currentLength; shiftIndex > targetIndex; shiftIndex--) {
                activeSecretBuffer[shiftIndex] = activeSecretBuffer[shiftIndex - 1];
            }
            activeSecretBuffer[targetIndex] = 48 + getSecureRandomInt(10);
            currentLength++;
        }
    }

    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) setResult(generatedText);
    return generatedText;
}

function generateUsername(skipDomUpdate = false) {
    wipeMemory();

    const count = lengths.user;
    const separator = document.getElementById('opt-user-sep').value;
    const appendNumbers = document.getElementById('opt-user-nums').checked;
    const numberCount = readIntField('user-num-count', 1, 9, 3);
    const wordIndices = [];
    let totalLength = 0;

    for (let index = 0; index < count; index++) {
        const wordIndex = getSecureRandomInt(WORDS.length);
        wordIndices.push(wordIndex);
        totalLength += WORDS[wordIndex].length;
    }

    totalLength += separator.length * Math.max(0, count - 1);
    if (appendNumbers) totalLength += numberCount + (separator ? separator.length : 0);

    activeSecretBuffer = new Uint8Array(totalLength);
    let offset = 0;

    const writeString = (value) => {
        for (let index = 0; index < value.length; index++) {
            activeSecretBuffer[offset++] = value.charCodeAt(index);
        }
    };

    for (let index = 0; index < count; index++) {
        const word = WORDS[wordIndices[index]];
        activeSecretBuffer[offset++] = word.charCodeAt(0) - 32;
        writeString(word.slice(1));
        if (index < count - 1) writeString(separator);
    }

    if (appendNumbers) {
        if (separator) writeString(separator);
        for (let index = 0; index < numberCount; index++) {
            activeSecretBuffer[offset++] = 48 + getSecureRandomInt(10);
        }
    }

    const generatedText = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) setResult(generatedText);
    return generatedText;
}

function generate() {
    if (!hasSecureRandom()) {
        setGenerationError('Secure generation is unavailable in this browser.');
        return null;
    }

    clearGenerationError();
    let generatedText = null;

    if (currentMode === 'pwd') generatedText = generatePassword();
    if (currentMode === 'pass') generatedText = generatePassphrase();
    if (currentMode === 'user') generatedText = generateUsername();
    if (currentMode === 'pattern') generatedText = generatePattern();

    if (generatedText && currentMode !== 'user') calculateEntropyAndStrength();
    return generatedText;
}

function bulkExport(format) {
    if (isParanoid()) {
        showToast('File export is disabled in Paranoid mode.');
        return;
    }
    if (!hasSecureRandom()) {
        showToast('Secure generation is unavailable.');
        return;
    }

    const count = readIntField('bulk-count', 1, 10000, 50);
    el.bulkCount.value = String(count);
    const results = [];

    for (let index = 0; index < count; index++) {
        let result = null;
        if (currentMode === 'pwd') result = generatePassword(true);
        if (currentMode === 'pass') result = generatePassphrase(true);
        if (currentMode === 'user') result = generateUsername(true);
        if (currentMode === 'pattern') result = generatePattern(true);
        if (!result) break;
        results.push(result);
    }

    if (results.length !== count) {
        generate();
        showToast('Export failed. Check the generation settings.');
        return;
    }

    setResult(results[results.length - 1]);
    if (currentMode !== 'user') calculateEntropyAndStrength();

    const output = format === 'csv'
        ? `\uFEFFCredential\r\n${results.map((result) => `"${result.replace(/"/g, '""')}"`).join('\r\n')}`
        : results.join('\n');
    const mimeType = format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
    const blobUrl = URL.createObjectURL(new Blob([output], { type: mimeType }));
    const downloadLink = document.createElement('a');

    downloadLink.href = blobUrl;
    downloadLink.download = `homelab_vault_${currentMode}_x${results.length}_${Date.now()}.${format}`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    URL.revokeObjectURL(blobUrl);
    wipeMemory();
    showToast(`Exported ${results.length} credentials. Store the file securely.`);
}

function formatCrackTime(seconds) {
    if (!Number.isFinite(seconds)) return 'longer than the age of the universe';
    if (seconds < 1) return 'instant';

    const minute = 60;
    const hour = 3600;
    const day = 86400;
    const year = 31557600;
    if (seconds < minute) return `${Math.round(seconds)} seconds`;
    if (seconds < hour) return `${Math.round(seconds / minute)} minutes`;
    if (seconds < day) return `${Math.round(seconds / hour)} hours`;
    if (seconds < year) return `${Math.round(seconds / day)} days`;

    const years = seconds / year;
    if (years < 1000) return `${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'}`;

    const scales = [
        [1e6, 1e3, 'thousand'],
        [1e9, 1e6, 'million'],
        [1e12, 1e9, 'billion'],
        [1e15, 1e12, 'trillion']
    ];
    for (const [upperBound, divisor, name] of scales) {
        if (years < upperBound) return `${(years / divisor).toFixed(1)} ${name} years`;
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
            entropy += Math.max(0, lengths.pass - 1) * Math.log2(RANDOM_SEPARATOR_POOL.length);
        }
        if (document.getElementById('opt-pass-nums').checked) {
            const numberCount = readIntField('pass-num-count', 1, 10, 2);
            const randomizePositions = document.getElementById('opt-pass-nums-rand').checked;
            entropy += (randomizePositions ? numberCount : numberCount * lengths.pass) * Math.log2(10);
        }
        el.poolInfo.textContent = `${lengths.pass.toLocaleString()} words from a ${WORDS.length.toLocaleString()}-word list`;
    } else if (currentMode === 'pattern') {
        const analysis = parsePattern(el.patternInput.value);
        if (analysis.error) {
            resetMetrics();
            return;
        }
        entropy = analysis.entropy;
        el.poolInfo.textContent = `Pattern output: ${analysis.totalLength.toLocaleString()} characters`;
    } else {
        const selection = getPasswordCharsets();
        if (selection.error) {
            resetMetrics();
            return;
        }
        entropy = calculatePasswordEntropy(lengths.pwd, selection.sets);
        const poolSize = selection.sets.reduce((sum, set) => sum + set.length, 0);
        el.poolInfo.textContent = `Character pool: ${poolSize.toLocaleString()} unique symbols`;
    }

    const averageSeconds = Math.pow(2, entropy - 1) / 1e11;
    let strength = 'Weak';
    let classSuffix = 'weak';

    if (entropy >= 40 && averageSeconds < 86400) {
        strength = 'Fair';
        classSuffix = 'fair';
    } else if (averageSeconds >= 86400 && averageSeconds < 31536000) {
        strength = 'Good';
        classSuffix = 'good';
    } else if (averageSeconds >= 31536000 && averageSeconds < 3.15e11) {
        strength = 'Strong';
        classSuffix = 'strong';
    } else if (averageSeconds >= 3.15e11) {
        strength = 'Very Strong';
        classSuffix = 'very-strong';
    }

    el.entropyText.textContent = `Entropy: ${Math.round(entropy)} bits`;
    el.strengthText.textContent = `Strength: ${strength}`;
    el.strengthText.className = `strength-${classSuffix}`;
    el.crackText.textContent = `Estimated offline crack time: ${formatCrackTime(averageSeconds)}`;
    el.entropyBar.value = Math.min(128, entropy);
    el.entropyBar.className = `entropy-${classSuffix}`;
}

function showToast(message) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.add('show');
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3000);
}

function fallbackCopyTextToClipboard(text) {
    const previousFocus = document.activeElement;
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.className = 'clipboard-fallback';
    textArea.setAttribute('aria-hidden', 'true');
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch (error) {
        copied = false;
    }
    textArea.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    return copied;
}

function getClearDelay() {
    if (el.clearTime.value !== 'custom') return Number.parseInt(el.clearTime.value, 10);
    return readIntField('custom-clear-time', 1, 86400, 60) * 1000;
}

function handleCopySuccess(copiedValue) {
    const delay = getClearDelay();
    cancelClearTimer();
    el.copyBtn.textContent = 'Copied';
    showToast(`Copied. The displayed result will clear in ${delay / 1000} seconds.`);

    clearTimer = setTimeout(() => {
        clearTimer = null;
        el.copyBtn.textContent = 'Copy';
        if (currentResult === copiedValue) {
            wipeSecret();
            showToast('Displayed credential cleared. Clipboard history is controlled by your OS.');
        }
    }, delay);
}

async function copyResult() {
    if (!currentResult) {
        showToast('Generate a credential first.');
        return;
    }

    const value = currentResult;
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            handleCopySuccess(value);
            return;
        } catch (error) {
            // Fall through to the legacy path for file:// and restricted browsers.
        }
    }

    if (fallbackCopyTextToClipboard(value)) {
        handleCopySuccess(value);
    } else {
        showToast('Copy failed. Select the credential and copy it manually.');
    }
}

function toggleNestedInputs() {
    document.getElementById('opt-pass-caps-rand-wrapper').classList.toggle('hidden', !document.getElementById('opt-pass-caps').checked);
    document.getElementById('pass-num-options-wrapper').classList.toggle('hidden', !document.getElementById('opt-pass-nums').checked);
    document.getElementById('user-num-count-wrapper').classList.toggle('hidden', !document.getElementById('opt-user-nums').checked);
}

function applySymbolPreset() {
    const preset = el.symbolPreset.value;
    if (preset === 'default') el.symInput.value = DEFAULT_SYMS;
    if (preset === 'friendly') el.symInput.value = CONFIG_FRIENDLY_SYMS;
    if (preset === 'custom') el.symInput.value = normalizeSymbolPool(el.symInput.value) || DEFAULT_SYMS;
    el.symInput.classList.toggle('hidden', preset !== 'custom');
}

function updateUI(shouldGenerate = true) {
    for (const mode of MODES) {
        const active = currentMode === mode;
        const tab = tabByMode[mode];
        const panel = panels[mode];
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panel.hidden = !active;
    }

    const usesLength = currentMode !== 'pattern';
    el.lengthContainer.classList.toggle('hidden', !usesLength);
    el.length.classList.toggle('hidden', !usesLength);
    el.metricsContainer.classList.toggle('hidden', currentMode === 'user');

    if (currentMode === 'pwd') {
        el.lengthLabel.textContent = 'Length';
        el.length.min = el.lengthNum.min = 4;
        el.length.max = el.lengthNum.max = 128;
    } else if (currentMode === 'pass') {
        el.lengthLabel.textContent = 'Words';
        el.length.min = el.lengthNum.min = 3;
        el.length.max = el.lengthNum.max = 20;
    } else if (currentMode === 'user') {
        el.lengthLabel.textContent = 'Words';
        el.length.min = el.lengthNum.min = 1;
        el.length.max = el.lengthNum.max = 10;
    }

    if (usesLength) {
        el.length.value = lengths[currentMode];
        el.lengthNum.value = lengths[currentMode];
    }

    toggleNestedInputs();
    updateActionAvailability();
    if (shouldGenerate) generate();
}

function activateMode(mode, focusTab = false) {
    if (!MODES.includes(mode)) return;
    currentMode = mode;
    updateUI();
    saveSettings();
    if (focusTab) tabByMode[mode].focus();
}

function applyTheme(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    el.themeBtn.textContent = isDark ? '☀' : '☾';
    el.themeBtn.setAttribute('aria-pressed', String(isDark));
    el.themeBtn.setAttribute('aria-label', isDark ? 'Use light theme' : 'Use dark theme');
}

function toggleTheme() {
    const useDark = !document.body.classList.contains('dark-mode');
    applyTheme(useDark);
    if (!isParanoid()) {
        try {
            localStorage.setItem(STORAGE_KEYS.theme, useDark ? 'dark' : 'light');
        } catch (error) {
            // Storage can be unavailable in private or locked-down contexts.
        }
    }
}

function clearSavedPreferences() {
    try {
        localStorage.removeItem(STORAGE_KEYS.settings);
        localStorage.removeItem(STORAGE_KEYS.theme);
    } catch (error) {
        // Storage can be unavailable in private or locked-down contexts.
    }
}

function saveSettings() {
    if (isParanoid()) return;

    const settings = {
        mode: currentMode,
        lengths,
        clearTime: el.clearTime.value,
        customClearTime: el.customClearTime.value,
        bulkCount: el.bulkCount.value,
        upper: document.getElementById('opt-upper').checked,
        lower: document.getElementById('opt-lower').checked,
        nums: document.getElementById('opt-nums').checked,
        syms: document.getElementById('opt-syms').checked,
        ambig: document.getElementById('opt-ambig').checked,
        symbolPreset: el.symbolPreset.value,
        symPool: normalizeSymbolPool(el.symInput.value),
        passCaps: document.getElementById('opt-pass-caps').checked,
        passCapsRand: document.getElementById('opt-pass-caps-rand').checked,
        passNums: document.getElementById('opt-pass-nums').checked,
        passNumsRand: document.getElementById('opt-pass-nums-rand').checked,
        passNumCount: document.getElementById('pass-num-count').value,
        passSep: document.getElementById('opt-pass-sep').value,
        userNums: document.getElementById('opt-user-nums').checked,
        userNumCount: document.getElementById('user-num-count').value,
        userSep: document.getElementById('opt-user-sep').value,
        patternStr: el.patternInput.value
    };

    try {
        localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    } catch (error) {
        // Settings persistence is optional.
    }
}

function loadSettings() {
    try {
        const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyTheme(savedTheme === 'dark' || (savedTheme === null && prefersDark));

        const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
        if (!saved || typeof saved !== 'object') {
            applySymbolPreset();
            return;
        }

        const clamp = (value, min, max, fallback) => (
            Number.isInteger(value) && value >= min && value <= max ? value : fallback
        );
        if (saved.lengths && typeof saved.lengths === 'object') {
            lengths = {
                pwd: clamp(saved.lengths.pwd, 4, 128, 24),
                pass: clamp(saved.lengths.pass, 3, 20, 6),
                user: clamp(saved.lengths.user, 1, 10, 2)
            };
        }
        if (MODES.includes(saved.mode)) currentMode = saved.mode;

        const validClearTimes = ['30000', '60000', '300000', 'custom'];
        if (validClearTimes.includes(saved.clearTime)) el.clearTime.value = saved.clearTime;
        el.customClearTime.classList.toggle('hidden', el.clearTime.value !== 'custom');
        if (saved.customClearTime !== undefined) el.customClearTime.value = readStoredNumber(saved.customClearTime, 1, 86400, '');
        if (saved.bulkCount !== undefined) el.bulkCount.value = readStoredNumber(saved.bulkCount, 1, 10000, 50);

        restoreBoolean(saved, 'upper', 'opt-upper');
        restoreBoolean(saved, 'lower', 'opt-lower');
        restoreBoolean(saved, 'nums', 'opt-nums');
        restoreBoolean(saved, 'syms', 'opt-syms');
        restoreBoolean(saved, 'ambig', 'opt-ambig');
        restoreBoolean(saved, 'passCaps', 'opt-pass-caps');
        restoreBoolean(saved, 'passCapsRand', 'opt-pass-caps-rand');
        restoreBoolean(saved, 'passNums', 'opt-pass-nums');
        restoreBoolean(saved, 'passNumsRand', 'opt-pass-nums-rand');
        restoreBoolean(saved, 'userNums', 'opt-user-nums');

        if (saved.passNumCount !== undefined) document.getElementById('pass-num-count').value = readStoredNumber(saved.passNumCount, 1, 10, 2);
        if (saved.userNumCount !== undefined) document.getElementById('user-num-count').value = readStoredNumber(saved.userNumCount, 1, 9, 3);
        if (['-', '_', '.', ' ', 'random'].includes(saved.passSep)) document.getElementById('opt-pass-sep').value = saved.passSep;
        if (['', '-', '_', '.'].includes(saved.userSep)) document.getElementById('opt-user-sep').value = saved.userSep;
        if (typeof saved.patternStr === 'string') el.patternInput.value = saved.patternStr.slice(0, 512);

        const legacyPreset = saved.customSyms ? 'custom' : (saved.safe ? 'friendly' : 'default');
        el.symbolPreset.value = ['default', 'friendly', 'custom'].includes(saved.symbolPreset) ? saved.symbolPreset : legacyPreset;
        if (typeof saved.symPool === 'string') el.symInput.value = normalizeSymbolPool(saved.symPool);
        applySymbolPreset();
    } catch (error) {
        applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        applySymbolPreset();
    }
}

function restoreBoolean(saved, key, elementId) {
    if (typeof saved[key] === 'boolean') document.getElementById(elementId).checked = saved[key];
}

function readStoredNumber(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function checkSecureContext() {
    const available = hasSecureRandom();
    el.insecureWarning.classList.toggle('hidden', available);
    updateActionAvailability();
    return available;
}

function bindBoundedNumber(input, min, max, fallback) {
    let lastGeneratedValue = readIntField(input.id, min, max, fallback);

    input.addEventListener('input', () => {
        const value = Number.parseInt(input.value, 10);
        if (!Number.isInteger(value) || value < min || value > max) return;
        lastGeneratedValue = value;
        generate();
        saveSettings();
    });
    input.addEventListener('change', () => {
        const value = readIntField(input.id, min, max, fallback);
        input.value = value;
        if (value !== lastGeneratedValue) {
            lastGeneratedValue = value;
            generate();
        }
        saveSettings();
    });
}

el.themeBtn.addEventListener('click', toggleTheme);
el.generateBtn.addEventListener('click', generate);
el.copyBtn.addEventListener('click', copyResult);

el.length.addEventListener('input', () => {
    const value = Number.parseInt(el.length.value, 10);
    lengths[currentMode] = value;
    el.lengthNum.value = value;
    generate();
    saveSettings();
});
el.lengthNum.addEventListener('input', () => {
    const value = Number.parseInt(el.lengthNum.value, 10);
    const min = Number.parseInt(el.lengthNum.min, 10);
    const max = Number.parseInt(el.lengthNum.max, 10);
    if (!Number.isInteger(value) || value < min || value > max) return;
    lengths[currentMode] = value;
    el.length.value = value;
    generate();
    saveSettings();
});
el.lengthNum.addEventListener('change', () => {
    const min = Number.parseInt(el.lengthNum.min, 10);
    const max = Number.parseInt(el.lengthNum.max, 10);
    const value = readIntField('length-num', min, max, lengths[currentMode]);
    const changed = value !== lengths[currentMode];
    lengths[currentMode] = value;
    el.length.value = value;
    el.lengthNum.value = value;
    if (changed) generate();
    saveSettings();
});

for (const mode of MODES) {
    tabByMode[mode].addEventListener('click', () => activateMode(mode));
}

document.querySelector('.tabs').addEventListener('keydown', (event) => {
    const currentIndex = tabs.indexOf(document.activeElement);
    if (currentIndex === -1) return;

    let nextIndex = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    activateMode(MODES[nextIndex], true);
});

for (const id of [
    'opt-upper',
    'opt-lower',
    'opt-nums',
    'opt-syms',
    'opt-ambig',
    'opt-pass-caps-rand',
    'opt-pass-nums-rand'
]) {
    document.getElementById(id).addEventListener('change', () => {
        generate();
        saveSettings();
    });
}

for (const id of ['opt-pass-caps', 'opt-pass-nums', 'opt-user-nums']) {
    document.getElementById(id).addEventListener('change', () => {
        toggleNestedInputs();
        generate();
        saveSettings();
    });
}

for (const id of ['opt-pass-sep', 'opt-user-sep']) {
    document.getElementById(id).addEventListener('change', () => {
        generate();
        saveSettings();
    });
}

el.patternInput.addEventListener('input', () => {
    generate();
    saveSettings();
});

el.symbolPreset.addEventListener('change', () => {
    applySymbolPreset();
    generate();
    saveSettings();
});

el.symInput.addEventListener('input', () => {
    const normalized = normalizeSymbolPool(el.symInput.value);
    if (el.symInput.value !== normalized) el.symInput.value = normalized;
    generate();
    saveSettings();
});

bindBoundedNumber(document.getElementById('pass-num-count'), 1, 10, 2);
bindBoundedNumber(document.getElementById('user-num-count'), 1, 9, 3);

el.clearTime.addEventListener('change', () => {
    el.customClearTime.classList.toggle('hidden', el.clearTime.value !== 'custom');
    saveSettings();
});
el.customClearTime.addEventListener('change', () => {
    el.customClearTime.value = readIntField('custom-clear-time', 1, 86400, 60);
    saveSettings();
});
el.bulkCount.addEventListener('change', () => {
    el.bulkCount.value = readIntField('bulk-count', 1, 10000, 50);
    saveSettings();
});

document.getElementById('opt-paranoid').addEventListener('change', () => {
    const active = isParanoid();
    document.body.classList.toggle('paranoid-active', active);
    el.paranoidOverlay.classList.toggle('hidden', !active);
    setParanoidReveal(false);
    if (active) {
        clearSavedPreferences();
    } else {
        saveSettings();
        try {
            localStorage.setItem(STORAGE_KEYS.theme, document.body.classList.contains('dark-mode') ? 'dark' : 'light');
        } catch (error) {
            // Theme persistence is optional.
        }
    }
    updateActionAvailability();
});

el.paranoidOverlay.addEventListener('click', () => {
    setParanoidReveal(!document.body.classList.contains('paranoid-revealed'));
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && isParanoid()) wipeSecret();
});

window.addEventListener('beforeunload', () => {
    if (isParanoid()) {
        wipeMemory();
        cleanupQr();
        clearSavedPreferences();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || el.qrModal.open) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(tag)) return;
    event.preventDefault();
    generate();
});

el.exportCsvBtn.addEventListener('click', () => bulkExport('csv'));
el.exportTxtBtn.addEventListener('click', () => bulkExport('txt'));

el.qrBtn.addEventListener('click', () => {
    if (!currentResult) return;
    if (typeof QRCode === 'undefined') {
        showToast('The local QR library is unavailable.');
        return;
    }

    cleanupQr();
    try {
        new QRCode(el.qrContainer, {
            text: currentResult,
            width: 220,
            height: 220,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
        // QRCode.js mirrors its input into title; the canvas is sufficient.
        el.qrContainer.removeAttribute('title');
        el.qrModal.showModal();
        el.qrClose.focus();
    } catch (error) {
        cleanupQr();
        showToast('This credential is too long to encode as a QR code.');
    }
});

el.qrClose.addEventListener('click', closeQr);
el.qrModal.addEventListener('cancel', cleanupQr);
el.qrModal.addEventListener('close', cleanupQr);
el.qrModal.addEventListener('click', (event) => {
    if (event.target === el.qrModal) closeQr();
});

el.resetSettingsBtn.addEventListener('click', () => {
    if (!window.confirm('Reset all saved Homelab Vault preferences?')) return;
    clearSavedPreferences();
    window.location.reload();
});

loadSettings();
updateUI(false);
if (checkSecureContext()) generate();
else resetMetrics();
