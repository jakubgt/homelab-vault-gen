'use strict';

const {
    CHARS,
    DEFAULT_SYMS,
    CONFIG_FRIENDLY_SYMS,
    calculatePasswordEntropy,
    calculatePassphraseEntropy,
    generatePasswordBytes,
    generatePassphraseBytes,
    generateUsernameBytes,
    getSecureRandomInt,
    normalizeSymbolPool,
    parsePattern
} = VaultCore;

const STORAGE_KEYS = Object.freeze({
    settings: 'vault_settings',
    theme: 'vault_theme',
    profiles: 'vault_profiles'
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
    allowedCharacterPreview: document.getElementById('allowed-character-preview'),
    allowedCharacterCount: document.getElementById('allowed-character-count'),
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
    exportJsonBtn: document.getElementById('export-json-btn'),
    clearBtn: document.getElementById('clear-btn'),
    clearCountdown: document.getElementById('clear-countdown'),
    outputLength: document.getElementById('output-length'),
    targetMaxLength: document.getElementById('target-max-length'),
    compatibilityWarning: document.getElementById('compatibility-warning'),
    csvDialog: document.getElementById('csv-export-dialog'),
    csvAck: document.getElementById('csv-text-ack'),
    csvConfirm: document.getElementById('csv-export-confirm'),
    bulkStatus: document.getElementById('bulk-status'),
    bulkProgress: document.getElementById('bulk-progress'),
    bulkProgressText: document.getElementById('bulk-progress-text'),
    profileSelect: document.getElementById('profile-select'),
    profileName: document.getElementById('profile-name'),
    profileSave: document.getElementById('profile-save-btn'),
    profileDelete: document.getElementById('profile-delete-btn'),
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
let generationRevision = 0;
let copyRequest = 0;
let clearDeadline = 0;
let countdownTimer = null;
let bulkJob = null;
let savedProfiles = [];

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
    clearInterval(countdownTimer);
    clearTimer = null;
    countdownTimer = null;
    clearDeadline = 0;
    el.clearCountdown.textContent = '';
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
    document.querySelectorAll('.controls input, .controls select, .controls button, .tabs button, .preset-panel input, .preset-panel select, .preset-panel button').forEach((control) => {
        if (control.id !== 'opt-paranoid' && control.id !== 'bulk-cancel-btn') control.disabled = Boolean(bulkJob);
    });
    const canGenerate = hasSecureRandom();
    const hasResult = typeof currentResult === 'string' && currentResult.length > 0;
    const allowFiles = hasResult && canGenerate && !isParanoid() && !bulkJob;

    el.generateBtn.disabled = !canGenerate || Boolean(bulkJob);
    el.copyBtn.disabled = !hasResult;
    el.qrBtn.disabled = !hasResult;
    el.exportCsvBtn.disabled = !allowFiles;
    el.exportTxtBtn.disabled = !allowFiles;
    el.exportJsonBtn.disabled = !allowFiles;
    el.clearBtn.disabled = !hasResult && !bulkJob;
    el.paranoidOverlay.disabled = !hasResult;
    el.profileSave.disabled = isParanoid() || Boolean(bulkJob);
    el.profileDelete.disabled = isParanoid() || Boolean(bulkJob) || !el.profileSelect.value.startsWith('saved:');
}

function setParanoidReveal(revealed) {
    const shouldReveal = Boolean(revealed && isParanoid());
    document.body.classList.toggle('paranoid-revealed', shouldReveal);
    el.paranoidOverlay.textContent = shouldReveal ? 'Hide' : 'Reveal';
    el.paranoidOverlay.setAttribute('aria-pressed', String(shouldReveal));
    renderResult();
}

function renderResult() {
    const concealed = isParanoid() && !document.body.classList.contains('paranoid-revealed');
    el.result.textContent = currentResult ? (concealed ? 'Credential hidden' : currentResult) : '';
    el.result.classList.toggle('concealed', Boolean(currentResult && concealed));
}

function updateCompatibility() {
    const length = currentResult ? currentResult.length : 0;
    el.outputLength.textContent = length ? `${length} characters` : 'No credential';
    const limit = Number(el.targetMaxLength.value);
    const tooLong = Boolean(length && limit > 0 && length > limit);
    el.compatibilityWarning.textContent = tooLong ? `Exceeds the target limit by ${length - limit} characters. Adjust your generation settings; the credential has not been shortened.` : '';
    el.compatibilityWarning.classList.toggle('hidden', !tooLong);
}

function clearGenerationError() {
    el.generationError.textContent = '';
    el.generationError.classList.add('hidden');
    el.patternInput.removeAttribute('aria-invalid');
    el.symInput.removeAttribute('aria-invalid');
    el.lengthNum.removeAttribute('aria-invalid');
}

function setResult(value) {
    generationRevision++;
    closeQr();
    cancelClearTimer();
    clearGenerationError();
    currentResult = value;
    setParanoidReveal(false);
    el.resultContainer.classList.add('has-result');
    updateActionAvailability();
    updateCompatibility();
}

function setGenerationError(message, input = null) {
    generationRevision++;
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
    updateCompatibility();
}

function wipeSecret() {
    generationRevision++;
    copyRequest++;
    cancelBulkExport();
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
    updateCompatibility();
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

function updateAllowedCharacters() {
    const selection = getPasswordCharsets();
    const pool = selection.error ? '' : selection.sets.join('');
    const preview = selection.error || pool;
    el.allowedCharacterCount.textContent = selection.error ? '(unavailable)' : `(${pool.length})`;
    if (el.allowedCharacterPreview.textContent !== preview) {
        el.allowedCharacterPreview.textContent = preview;
    }
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

function getPassphraseOptions() {
    return {
        count: lengths.pass,
        separator: document.getElementById('opt-pass-sep').value,
        capitalize: document.getElementById('opt-pass-caps').checked,
        randomizeCaps: document.getElementById('opt-pass-caps-rand').checked,
        insertNumbers: document.getElementById('opt-pass-nums').checked,
        numberCount: readIntField('pass-num-count', 1, 10, 2),
        randomizePositions: document.getElementById('opt-pass-nums-rand').checked
    };
}

function generatePassphrase(skipDomUpdate = false) {
    wipeMemory();
    activeSecretBuffer = generatePassphraseBytes(getPassphraseOptions(), WORDS);
    const text = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) setResult(text);
    return text;
}

function generateUsername(skipDomUpdate = false) {
    wipeMemory();
    activeSecretBuffer = generateUsernameBytes({
        count: lengths.user,
        separator: document.getElementById('opt-user-sep').value,
        appendNumbers: document.getElementById('opt-user-nums').checked,
        numberCount: readIntField('user-num-count', 1, 9, 3),
        lowercase: document.getElementById('opt-user-lower').checked
    }, WORDS);
    const text = new TextDecoder().decode(activeSecretBuffer);
    if (!skipDomUpdate) setResult(text);
    return text;
}

function generateValue(skipDomUpdate = false) {
    if (currentMode === 'pwd') return generatePassword(skipDomUpdate);
    if (currentMode === 'pass') return generatePassphrase(skipDomUpdate);
    if (currentMode === 'user') return generateUsername(skipDomUpdate);
    return generatePattern(skipDomUpdate);
}

function generate() {
    cancelBulkExport();
    if (currentMode === 'pwd') updateAllowedCharacters();
    if (!hasSecureRandom()) {
        setGenerationError('Secure generation is unavailable in this browser.');
        return null;
    }
    try {
        clearGenerationError();
        const text = generateValue();
        if (text && currentMode !== 'user') calculateEntropyAndStrength();
        return text;
    } catch (error) {
        setGenerationError(error.message || 'Generation failed.');
        return null;
    }
}

function cancelBulkExport() {
    if (!bulkJob) return;
    bulkJob.cancelled = true;
    bulkJob = null;
    wipeMemory();
    el.bulkStatus.classList.add('hidden');
    updateActionAvailability();
}

async function bulkExport(format, csvAcknowledged = false) {
    if (isParanoid() || !hasSecureRandom() || bulkJob || !currentResult) return;
    if (format === 'csv' && !csvAcknowledged) {
        el.csvAck.checked = false;
        el.csvConfirm.disabled = true;
        el.csvDialog.showModal();
        el.csvAck.focus();
        return;
    }
    const count = readIntField('bulk-count', 1, 10000, 50);
    el.bulkCount.value = String(count);
    const job = { cancelled: false, revision: generationRevision, mode: currentMode };
    const results = [];
    bulkJob = job;
    el.bulkStatus.classList.remove('hidden');
    el.bulkProgress.max = count;
    el.bulkProgress.value = 0;
    el.bulkProgressText.textContent = `0 / ${count}`;
    updateActionAvailability();
    try {
        // Yield between short batches so cancellation and privacy events can run.
        while (results.length < count) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (job.cancelled || isParanoid() || job.revision !== generationRevision) return;
            const started = performance.now();
            do {
                const result = generateValue(true);
                if (!result) throw new Error('Check the generation settings.');
                results.push(result);
            } while (results.length < count && results.length % 25 !== 0 && performance.now() - started < 8);
            el.bulkProgress.value = results.length;
            el.bulkProgressText.textContent = `${results.length} / ${count}`;
        }
        if (job.cancelled || isParanoid() || job.revision !== generationRevision) return;
        const output = format === 'csv'
            ? `\uFEFFCredential\r\n${results.map((result) => `"${result.replace(/"/g, '""')}"`).join('\r\n')}`
            : format === 'json' ? JSON.stringify(results, null, 2) : results.join('\n');
        const mime = { csv: 'text/csv', json: 'application/json', txt: 'text/plain' }[format];
        const url = URL.createObjectURL(new Blob([output], { type: `${mime};charset=utf-8` }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `homelab_vault_${job.mode}_x${count}_${Date.now()}.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Give browsers time to consume the download before releasing the Blob.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setResult(results[results.length - 1]);
        if (currentMode !== 'user') calculateEntropyAndStrength();
        showToast(`Exported ${count} credentials. Store the file securely.`);
    } catch (error) {
        showToast(`Export failed. ${error.message}`);
    } finally {
        results.fill('');
        if (bulkJob === job) {
            bulkJob = null;
            wipeMemory();
            el.bulkStatus.classList.add('hidden');
            updateActionAvailability();
        }
    }
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
entropy = calculatePassphraseEntropy(getPassphraseOptions(), WORDS);

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

function updateCountdown() {
    if (!clearDeadline) return;
    const remaining = clearDeadline - Date.now();
    if (remaining <= 0) {
        wipeSecret();
        showToast('Displayed credential cleared. Clipboard history is controlled by your OS.');
        return;
    }
    el.clearCountdown.textContent = `Clears in ${Math.ceil(remaining / 1000)} s`;
}

function handleCopySuccess(revision, request) {
    if (revision !== generationRevision || request !== copyRequest || !currentResult) return;
    const delay = getClearDelay();
    cancelClearTimer();
    el.copyBtn.textContent = 'Copied';
    clearDeadline = Date.now() + delay;
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 250);
    clearTimer = setTimeout(updateCountdown, delay);
    showToast(`Copied. The displayed result will clear in ${delay / 1000} seconds.`);
}

async function copyResult() {
    if (!currentResult) return;
    const value = currentResult;
    const revision = generationRevision;
    const request = ++copyRequest;
    const isCurrent = () => revision === generationRevision && request === copyRequest && Boolean(currentResult);
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            handleCopySuccess(revision, request);
            return;
        } catch (error) {
            // A focus change or new generation must not trigger a stale fallback.
            if (!isCurrent()) return;
        }
    }
    if (!isCurrent()) return;
    if (fallbackCopyTextToClipboard(value)) handleCopySuccess(revision, request);
    else showToast('Copy failed. Select the credential and copy it manually.');
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
    if (!shouldGenerate) updateAllowedCharacters();
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
        localStorage.removeItem(STORAGE_KEYS.profiles);
    } catch (error) {
        // Storage can be unavailable in private or locked-down contexts.
    }
}

function collectSettings() {
    return {
        mode: currentMode,
        lengths: { ...lengths },
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
        userLower: document.getElementById('opt-user-lower').checked,
        targetMaxLength: el.targetMaxLength.value,
        userNumCount: document.getElementById('user-num-count').value,
        userSep: document.getElementById('opt-user-sep').value,
        patternStr: el.patternInput.value
    };

}

function saveSettings() {
    el.profileSelect.value = '';
    updateActionAvailability();
    if (isParanoid()) return;
    try {
        localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(collectSettings()));
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

        applySettings(saved);
    } catch (error) {
        applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        applySymbolPreset();
    }
}

function applySettings(saved) {
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
        restoreBoolean(saved, 'userLower', 'opt-user-lower');
        el.targetMaxLength.value = saved.targetMaxLength ? readStoredNumber(saved.targetMaxLength, 1, 1000, '') : '';

        if (saved.passNumCount !== undefined) document.getElementById('pass-num-count').value = readStoredNumber(saved.passNumCount, 1, 10, 2);
        if (saved.userNumCount !== undefined) document.getElementById('user-num-count').value = readStoredNumber(saved.userNumCount, 1, 9, 3);
        if (['-', '_', '.', ' ', 'random'].includes(saved.passSep)) document.getElementById('opt-pass-sep').value = saved.passSep;
        if (['', '-', '_', '.'].includes(saved.userSep)) document.getElementById('opt-user-sep').value = saved.userSep;
        if (typeof saved.patternStr === 'string') el.patternInput.value = saved.patternStr.slice(0, 512);

        const legacyPreset = saved.customSyms ? 'custom' : (saved.safe ? 'friendly' : 'default');
        el.symbolPreset.value = ['default', 'friendly', 'custom'].includes(saved.symbolPreset) ? saved.symbolPreset : legacyPreset;
        if (typeof saved.symPool === 'string') el.symInput.value = normalizeSymbolPool(saved.symPool);
        applySymbolPreset();
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
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const remoteHttp = location.protocol === 'http:' && !local;
    document.getElementById('delivery-warning').classList.toggle('hidden', !remoteHttp);
    document.getElementById('connection-info').textContent = location.protocol === 'file:' ? 'Connection: local file'
        : remoteHttp ? 'Connection: unencrypted HTTP'
        : location.protocol === 'https:' ? 'Connection: HTTPS (verify browser trust)' : 'Connection: loopback HTTP';
    const build = globalThis.VAULT_BUILD || { version: 'unknown', commit: 'source' };
    document.getElementById('build-info').textContent = `Version ${build.version} · ${build.commit === 'source' ? 'source checkout' : `commit ${build.commit.slice(0, 12)}`}`;
    updateActionAvailability();
    return available;
}

function renderProfiles() {
    const group = document.getElementById('saved-profiles');
    group.replaceChildren();
    savedProfiles.forEach((profile, index) => {
        const option = document.createElement('option');
        option.value = `saved:${index}`;
        option.textContent = profile.name;
        group.appendChild(option);
    });
    updateActionAvailability();
}

function loadProfiles() {
    if (isParanoid()) return;
    try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEYS.profiles));
        savedProfiles = Array.isArray(value) ? value.filter((p) => p && typeof p.name === 'string' && p.name.trim() && p.name.length <= 40 && p.settings && typeof p.settings === 'object').slice(0, 20) : [];
    } catch (error) { savedProfiles = []; }
    renderProfiles();
}

function persistProfiles() {
    if (isParanoid()) return false;
    try {
        localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(savedProfiles));
        return true;
    } catch (error) {
        showToast('Storage is unavailable. This preset will last only until the page closes.');
        return false;
    }
}

function applyProfile(value) {
    const base = {
        mode: 'pwd', lengths: { pwd: 24, pass: 6, user: 2 },
        upper: true, lower: true, nums: true, syms: true, ambig: false,
        symbolPreset: 'default', passCaps: true, passCapsRand: false,
        passNums: false, passNumsRand: true, passNumCount: 2, passSep: '-',
        userNums: true, userNumCount: 3, userSep: '', userLower: false,
        targetMaxLength: '', patternStr: '[A-Z]{3}-[0-9]{4}-[a-z]{5}'
    };
    const presets = {
        balanced: {}, alphanumeric: { syms: false }, friendly: { symbolPreset: 'friendly' },
        passphrase: { mode: 'pass' }, pin: { lengths: { pwd: 6, pass: 6, user: 2 }, upper: false, lower: false, syms: false }
    };
    const profile = value.startsWith('saved:') ? savedProfiles[Number(value.slice(6))] : null;
    if (!profile && !Object.hasOwn(presets, value)) return;
    applySettings(profile ? profile.settings : { ...base, ...presets[value] });
    updateUI();
    saveSettings();
    el.profileSelect.value = value;
    el.profileName.value = profile ? profile.name : '';
    updateActionAvailability();
}

function applyParanoidMode(active, updateAddress = true) {
    document.getElementById('opt-paranoid').checked = active;
    document.body.classList.toggle('paranoid-active', active);
    el.paranoidOverlay.classList.toggle('hidden', !active);
    cancelBulkExport();
    closeQr();
    if (el.csvDialog.open) el.csvDialog.close();
    setParanoidReveal(false);
    if (active) {
        clearSavedPreferences();
        savedProfiles = [];
        renderProfiles();
    } else {
        saveSettings();
    }
    if (updateAddress) {
        const address = new URL(location.href);
        const params = new URLSearchParams(address.hash.slice(1));
        if (active) params.set('paranoid', '');
        else params.delete('paranoid');
        address.hash = params.toString();
        try { history.replaceState(null, '', address); } catch (error) { /* file:// history may be restricted */ }
    }
    updateActionAvailability();
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
        const raw = input.value;
        const value = readIntField(input.id, min, max, fallback);
        input.value = value;
        if (String(value) !== raw || value !== lastGeneratedValue) {
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
    'opt-user-lower',
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

document.getElementById('opt-paranoid').addEventListener('change', () => applyParanoidMode(isParanoid()));
window.addEventListener('hashchange', () => applyParanoidMode(new URLSearchParams(location.hash.slice(1)).has('paranoid'), false));

el.paranoidOverlay.addEventListener('click', () => {
    setParanoidReveal(!document.body.classList.contains('paranoid-revealed'));
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && isParanoid()) wipeSecret();
    else updateCountdown();
});
window.addEventListener('blur', () => { if (isParanoid()) wipeSecret(); });
window.addEventListener('pagehide', wipeSecret);

document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || el.qrModal.open) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(tag)) return;
    event.preventDefault();
    generate();
});

el.exportCsvBtn.addEventListener('click', () => bulkExport('csv'));
el.exportTxtBtn.addEventListener('click', () => bulkExport('txt'));
el.exportJsonBtn.addEventListener('click', () => bulkExport('json'));

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
            width: 210,
            height: 210,
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


el.clearBtn.addEventListener('click', () => { wipeSecret(); showToast('Displayed credential cleared.'); });
document.getElementById('bulk-cancel-btn').addEventListener('click', () => { cancelBulkExport(); showToast('Export cancelled. No file was downloaded.'); });
el.csvAck.addEventListener('change', () => { el.csvConfirm.disabled = !el.csvAck.checked; });
el.csvConfirm.addEventListener('click', () => {
    if (!el.csvAck.checked) return;
    el.csvDialog.close();
    bulkExport('csv', true);
});
document.getElementById('csv-export-cancel').addEventListener('click', () => el.csvDialog.close());
el.targetMaxLength.addEventListener('change', () => {
    if (el.targetMaxLength.value) el.targetMaxLength.value = readIntField('target-max-length', 1, 1000, '');
    updateCompatibility();
    saveSettings();
});
el.profileSelect.addEventListener('change', () => applyProfile(el.profileSelect.value));
el.profileSave.addEventListener('click', () => {
    if (isParanoid()) return;
    const name = el.profileName.value.trim().slice(0, 40);
    if (!name) { showToast('Enter a preset name.'); el.profileName.focus(); return; }
    let index = savedProfiles.findIndex((p) => p.name === name);
    if (index === -1) {
        if (savedProfiles.length >= 20) { showToast('Delete a preset before adding another (maximum 20).'); return; }
        index = savedProfiles.length;
    }
    savedProfiles[index] = { name, settings: collectSettings() };
    const persisted = persistProfiles();
    renderProfiles();
    el.profileSelect.value = `saved:${index}`;
    updateActionAvailability();
    if (persisted) showToast('Preset saved on this device.');
});
el.profileDelete.addEventListener('click', () => {
    if (isParanoid() || !el.profileSelect.value.startsWith('saved:')) return;
    savedProfiles.splice(Number(el.profileSelect.value.slice(6)), 1);
    persistProfiles();
    renderProfiles();
    el.profileName.value = '';
    showToast('Preset removed.');
});

const privateLaunch = new URLSearchParams(location.hash.slice(1)).has('paranoid');
if (privateLaunch) {
    applyParanoidMode(true, false);
    applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    applySymbolPreset();
} else {
    loadSettings();
    loadProfiles();
}
updateUI(false);
if (checkSecureContext()) generate();
else resetMetrics();
