'use strict';

const {
    DEFAULT_SYMS,
    DEFAULT_PATTERN,
    CONFIG_FRIENDLY_SYMS,
    getPasswordProfileCharsets,
    normalizeSymbolPool,
    prepareGenerationProfile
} = VaultCore;

const STORAGE_KEYS = Object.freeze({
    settings: 'vault_settings',
    theme: 'vault_theme',
    profiles: 'vault_profiles'
});
const MODES = Object.freeze(['pwd', 'pass', 'user', 'pattern', 'raw']);
const PROFILE_MODES = Object.freeze({ pwd: 'password', pass: 'passphrase', user: 'username', pattern: 'pattern', raw: 'raw' });
const PASSWORD_MINIMUMS = Object.freeze({ minUpper: 'upper', minLower: 'lower', minNums: 'nums', minSyms: 'syms' });
const GUESSES_PER_SECOND = 100_000_000_000;
const MAX_PROFILE_BYTES = 16 * 1024;

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
    entropyDetails: document.getElementById('entropy-details-text'),
    entropyBar: document.getElementById('entropy-bar'),
    tabPwd: document.getElementById('tab-pwd'),
    tabPass: document.getElementById('tab-pass'),
    tabUser: document.getElementById('tab-user'),
    tabPattern: document.getElementById('tab-pattern'),
    tabRaw: document.getElementById('tab-raw'),
    modeSelect: document.getElementById('mode-select'),
    pwdOpts: document.getElementById('pwd-options'),
    passOpts: document.getElementById('pass-options'),
    userOpts: document.getElementById('user-options'),
    patternOpts: document.getElementById('pattern-options'),
    rawOpts: document.getElementById('raw-options'),
    rawByteLength: document.getElementById('raw-byte-length'),
    rawEncoding: document.getElementById('raw-encoding'),
    patternInput: document.getElementById('pattern-input'),
    symbolPreset: document.getElementById('symbol-preset'),
    symInput: document.getElementById('sym-input'),
    passwordExclude: document.getElementById('password-exclude'),
    passMaxWordLength: document.getElementById('pass-max-word-length'),
    passLengthRange: document.getElementById('pass-length-range'),
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
    downloadCurrent: document.getElementById('download-current-btn'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
    exportTxtBtn: document.getElementById('export-txt-btn'),
    exportJsonBtn: document.getElementById('export-json-btn'),
    clearBtn: document.getElementById('clear-btn'),
    clearCountdown: document.getElementById('clear-countdown'),
    outputLength: document.getElementById('output-length'),
    targetMaxLength: document.getElementById('target-max-length'),
    strictLength: document.getElementById('target-strict-length'),
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
    profileExport: document.getElementById('profile-export-btn'),
    profileImport: document.getElementById('profile-import-btn'),
    profileFile: document.getElementById('profile-import-file'),
    resetSettingsBtn: document.getElementById('reset-settings-btn'),
    toast: document.getElementById('toast')
};

const tabs = [el.tabPwd, el.tabPass, el.tabUser, el.tabPattern, el.tabRaw];
const panels = {
    pwd: el.pwdOpts,
    pass: el.passOpts,
    user: el.userOpts,
    pattern: el.patternOpts,
    raw: el.rawOpts
};
const tabByMode = {
    pwd: el.tabPwd,
    pass: el.tabPass,
    user: el.tabUser,
    pattern: el.tabPattern,
    raw: el.tabRaw
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
let profileImportRequest = 0;

function hasSecureRandom() {
    return Boolean(window.crypto && typeof window.crypto.getRandomValues === 'function');
}

function isLoopback() {
    const hostname = location.hostname;
    return ['localhost', 'localhost.', '[::1]'].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function canGenerateHere() {
    return hasSecureRandom() && (location.protocol === 'file:'
        || (location.protocol === 'http:' && isLoopback())
        || (location.protocol === 'https:' && window.isSecureContext));
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
    el.qrModal.classList.remove('qr-expanded');
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
    el.entropyText.textContent = '— bits';
    el.strengthText.textContent = '—';
    el.strengthText.className = '';
    el.crackText.textContent = 'Estimated offline crack time: —';
    el.poolInfo.textContent = '';
    el.entropyDetails.textContent = '';
    el.entropyBar.value = 0;
    el.entropyBar.className = 'entropy-weak';
}

function updateActionAvailability() {
    document.querySelectorAll('.controls input, .controls select, .controls button, .tabs button, #mode-select').forEach((control) => {
        if (control.id !== 'opt-paranoid' && control.id !== 'bulk-cancel-btn') control.disabled = Boolean(bulkJob);
    });
    const canGenerate = canGenerateHere();
    const hasResult = typeof currentResult === 'string' && currentResult.length > 0;
    const allowProfileFiles = canGenerate && !isParanoid() && !bulkJob;
    const allowFiles = hasResult && allowProfileFiles;

    el.generateBtn.disabled = !canGenerate || Boolean(bulkJob);
    el.copyBtn.disabled = !hasResult || !canGenerate;
    el.qrBtn.disabled = !hasResult || !canGenerate;
    el.downloadCurrent.disabled = !allowFiles;
    el.exportCsvBtn.disabled = !allowFiles;
    el.exportTxtBtn.disabled = !allowFiles;
    el.exportJsonBtn.disabled = !allowFiles;
    el.clearBtn.disabled = !hasResult && !bulkJob;
    el.paranoidOverlay.disabled = !hasResult;
    el.profileSave.disabled = isParanoid() || Boolean(bulkJob);
    el.profileDelete.disabled = isParanoid() || Boolean(bulkJob) || !el.profileSelect.value.startsWith('saved:');
    el.profileExport.disabled = !allowProfileFiles;
    el.profileImport.disabled = !allowProfileFiles;
    el.profileFile.disabled = !allowProfileFiles;
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
    el.targetMaxLength.removeAttribute('aria-invalid');
    el.passMaxWordLength.removeAttribute('aria-invalid');
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

function minimumField(field) {
    return document.getElementById(`password-min-${PASSWORD_MINIMUMS[field]}`);
}

function normalizeExclusions(value) {
    return [...new Set(value.replace(/[^\x21-\x7e]/g, ''))].join('');
}

function getPasswordOptions() {
    const options = {
        length: lengths.pwd,
        upper: document.getElementById('opt-upper').checked,
        lower: document.getElementById('opt-lower').checked,
        nums: document.getElementById('opt-nums').checked,
        syms: document.getElementById('opt-syms').checked,
        ambig: document.getElementById('opt-ambig').checked,
        symbols: normalizeSymbolPool(el.symInput.value),
        exclude: normalizeExclusions(el.passwordExclude.value)
    };
    for (const field of Object.keys(PASSWORD_MINIMUMS)) {
        const input = minimumField(field);
        if (input.value !== '') options[field] = input.valueAsNumber;
    }
    return options;
}

function updateAllowedCharacters() {
    let preview;
    let count;
    try {
        preview = getPasswordProfileCharsets(getPasswordOptions()).join('');
        count = `(${preview.length})`;
    } catch (error) {
        preview = error.message;
        count = '(unavailable)';
    }
    el.allowedCharacterCount.textContent = count;
    if (el.allowedCharacterPreview.textContent !== preview) {
        el.allowedCharacterPreview.textContent = preview;
    }
}

function getPassphraseOptions() {
    return {
        count: lengths.pass,
        separator: document.getElementById('opt-pass-sep').value,
        capitalize: document.getElementById('opt-pass-caps').checked,
        randomizeCaps: document.getElementById('opt-pass-caps-rand').checked,
        insertNumbers: document.getElementById('opt-pass-nums').checked,
        numberCount: readIntField('pass-num-count', 1, 10, 2),
        randomizePositions: document.getElementById('opt-pass-nums-rand').checked,
        maxWordLength: el.passMaxWordLength.value === '' ? null : el.passMaxWordLength.valueAsNumber
    };
}

function getUsernameOptions() {
    return {
        count: lengths.user,
        separator: document.getElementById('opt-user-sep').value,
        appendNumbers: document.getElementById('opt-user-nums').checked,
        numberCount: readIntField('user-num-count', 1, 9, 3),
        lowercase: document.getElementById('opt-user-lower').checked
    };
}

function getRawSecretOptions() {
    return { byteLength: Number(el.rawByteLength.value), encoding: el.rawEncoding.value };
}

function collectGenerationProfile() {
    let options;
    switch (currentMode) {
    case 'pwd': options = getPasswordOptions(); break;
    case 'pass': options = getPassphraseOptions(); break;
    case 'user': options = getUsernameOptions(); break;
    case 'raw': options = getRawSecretOptions(); break;
    default: options = { template: el.patternInput.value }; break;
    }
    if (el.strictLength.checked) {
        if (el.targetMaxLength.value === '') throw new Error('Enter a target maximum length before enforcing it.');
        options.maxLength = el.targetMaxLength.valueAsNumber;
    }
    return { version: 1, mode: PROFILE_MODES[currentMode], options };
}

function updatePassphraseRange(prepared) {
    if (currentMode !== 'pass') return;
    if (!prepared) {
        el.passLengthRange.textContent = 'Possible length is unavailable with these settings.';
        return;
    }
    const { minLength, maxLength } = prepared;
    const range = minLength === maxLength ? String(minLength) : `${minLength}–${maxLength}`;
    el.passLengthRange.textContent = `Possible length: ${range} characters.`;
}

function generationErrorInput(message) {
    if (/target maximum|maxLength/i.test(message) || (el.strictLength.checked && /pattern output is too long/i.test(message))) return el.targetMaxLength;
    if (currentMode === 'pattern') return el.patternInput;
    if (currentMode === 'pass' && /word length|maxWordLength|no words/i.test(message)) return el.passMaxWordLength;
    if (currentMode === 'pwd') {
        if (/length/i.test(message)) return el.lengthNum;
        if (/printable ASCII symbol/i.test(message)) return el.symInput;
    }
    return null;
}

function generateValue(prepared) {
    wipeMemory();
    activeSecretBuffer = prepared.generate();
    return new TextDecoder().decode(activeSecretBuffer);
}

function generate() {
    cancelBulkExport();
    if (currentMode === 'pwd') updateAllowedCharacters();
    if (!canGenerateHere()) return null;
    try {
        const prepared = prepareGenerationProfile(collectGenerationProfile(), WORDS);
        updatePassphraseRange(prepared);
        const value = generateValue(prepared);
        setResult(value);
        if (prepared.entropy !== null) calculateEntropyAndStrength(prepared);
        return value;
    } catch (error) {
        updatePassphraseRange(null);
        const message = error.message || 'Generation failed.';
        setGenerationError(message, generationErrorInput(message));
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

function downloadLocalFile(data, filename, type) {
    const url = URL.createObjectURL(new Blob([data], { type: `${type};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    try {
        link.click();
    } finally {
        link.remove();
        // Give browsers time to consume the download before releasing the Blob.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

function downloadCurrentCredential() {
    if (!currentResult || isParanoid() || !canGenerateHere() || bulkJob) return;
    try {
        downloadLocalFile(currentResult, 'homelab-vault-credential.txt', 'text/plain');
        showToast('Downloaded the current credential as plaintext. Store the file securely.');
    } catch (error) {
        showToast('Download failed. Try copying the current credential instead.');
    }
}

async function bulkExport(format, csvAcknowledged = false) {
    if (isParanoid() || !canGenerateHere() || bulkJob || !currentResult) return;
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
        const prepared = prepareGenerationProfile(collectGenerationProfile(), WORDS);
        // Yield between short batches so cancellation and privacy events can run.
        while (results.length < count) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (job.cancelled || isParanoid() || job.revision !== generationRevision) return;
            const started = performance.now();
            do {
                results.push(generateValue(prepared));
            } while (results.length < count && results.length % 25 !== 0 && performance.now() - started < 8);
            el.bulkProgress.value = results.length;
            el.bulkProgressText.textContent = `${results.length} / ${count}`;
        }
        if (job.cancelled || isParanoid() || job.revision !== generationRevision) return;
        const output = format === 'csv'
            ? `\uFEFFCredential\r\n${results.map((result) => `"${result.replace(/"/g, '""')}"`).join('\r\n')}`
            : format === 'json' ? JSON.stringify(results, null, 2) : results.join('\n');
        const mime = { csv: 'text/csv', json: 'application/json', txt: 'text/plain' }[format];
        downloadLocalFile(output, `homelab_vault_${job.mode}_x${count}_${Date.now()}.${format}`, mime);
        setResult(results[results.length - 1]);
        if (prepared.entropy !== null) calculateEntropyAndStrength(prepared);
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

function calculateEntropyAndStrength(prepared) {
    const { entropy, entropyDetails: details, maxLength, profile: { options } } = prepared;
    if (currentMode === 'pass') {
        el.poolInfo.textContent = `${options.count.toLocaleString()} words from a ${details.wordListSize.toLocaleString()}-word list`;
        el.entropyDetails.textContent = [
            `Words: ${details.wordBits.toFixed(2)} bits.`,
            `Random capitalization: ${details.capitalizationBits.toFixed(2)} bits.`,
            `Random separators: ${details.separatorBits.toFixed(2)} bits.`,
            `Random digits: ${details.digitBits.toFixed(2)} bits.`,
            options.maxLength !== null ? 'Only word combinations that fit the target length are eligible.' : ''
        ].filter(Boolean).join(' ');
    } else if (currentMode === 'raw') {
        const { byteLength, encoding } = options;
        const label = { hex: 'Hex', base64: 'Base64', base64url: 'Base64url' }[encoding];
        el.poolInfo.textContent = `${byteLength} random bytes · ${label} encoding`;
        el.entropyDetails.textContent = `${byteLength} random bytes × 8 bits per byte.`;
    } else if (currentMode === 'pattern') {
        el.poolInfo.textContent = `Pattern output: ${maxLength.toLocaleString()} characters`;
        el.entropyDetails.textContent = 'Random character choices contribute entropy. Fixed literals contribute 0 bits.';
    } else {
        const poolSize = getPasswordProfileCharsets(options).reduce((sum, set) => sum + set.length, 0);
        el.poolInfo.textContent = `Character pool: ${poolSize.toLocaleString()} unique symbols`;
        el.entropyDetails.textContent = 'Entropy counts the possible passwords that satisfy the selected character requirements.';
    }

    const averageSeconds = Math.pow(2, entropy - 1) / GUESSES_PER_SECOND;
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

    el.entropyText.textContent = `${Math.round(entropy)} bits`;
    el.strengthText.textContent = strength;
    el.strengthText.className = `strength-${classSuffix}`;
    el.crackText.textContent = `Estimated average offline crack time at 100 billion guesses per second: ${formatCrackTime(averageSeconds)}`;
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

function updatePrivacySummary() {
    document.getElementById('clear-setting-summary').textContent = `Clear after ${getClearDelay() / 1000}s`;
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
    el.modeSelect.value = currentMode;
    for (const mode of MODES) {
        const active = currentMode === mode;
        const tab = tabByMode[mode];
        const panel = panels[mode];
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panel.hidden = !active;
    }
    for (const [mode, id] of Object.entries({ pwd: 'pwd-advanced', pass: 'pass-advanced', user: 'user-advanced', pattern: 'pattern-help', raw: 'raw-help' })) {
        document.getElementById(id).hidden = currentMode !== mode;
    }

    const usesLength = ['pwd', 'pass', 'user'].includes(currentMode);
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
    updatePrivacySummary();
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

function collectSettings(includeNamedTemplate = false) {
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
        passwordExclude: normalizeExclusions(el.passwordExclude.value),
        passwordMinimums: Object.fromEntries(Object.keys(PASSWORD_MINIMUMS).map((field) => [field, minimumField(field).value])),
        passCaps: document.getElementById('opt-pass-caps').checked,
        passCapsRand: document.getElementById('opt-pass-caps-rand').checked,
        passNums: document.getElementById('opt-pass-nums').checked,
        passNumsRand: document.getElementById('opt-pass-nums-rand').checked,
        passNumCount: document.getElementById('pass-num-count').value,
        passSep: document.getElementById('opt-pass-sep').value,
        passMaxWordLength: el.passMaxWordLength.value,
        userNums: document.getElementById('opt-user-nums').checked,
        userLower: document.getElementById('opt-user-lower').checked,
        targetMaxLength: el.targetMaxLength.value,
        strictLength: el.strictLength.checked,
        userNumCount: document.getElementById('user-num-count').value,
        userSep: document.getElementById('opt-user-sep').value,
        rawByteLength: Number(el.rawByteLength.value),
        rawEncoding: el.rawEncoding.value,
        ...(includeNamedTemplate && currentMode === 'pattern' ? { patternStr: el.patternInput.value } : {})
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

        if (Object.hasOwn(saved, 'patternStr')) {
            // Existing named presets are separate and retain deliberately saved templates.
            delete saved.patternStr;
            try {
                localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(saved));
            } catch (error) {
                // Readable preferences still apply if the browser blocks this write.
            }
        }
        applySettings(saved);
    } catch (error) {
        applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        applySymbolPreset();
    }
}

function applySettings(saved, restorePattern = false) {
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
        el.strictLength.checked = saved.strictLength === true;
        el.targetMaxLength.value = saved.targetMaxLength ? readStoredNumber(saved.targetMaxLength, 1, 1000, '') : '';

        el.passwordExclude.value = typeof saved.passwordExclude === 'string' ? normalizeExclusions(saved.passwordExclude) : '';
        for (const field of Object.keys(PASSWORD_MINIMUMS)) {
            minimumField(field).value = readStoredNumber(saved.passwordMinimums?.[field], 0, 128, '');
        }
        if (saved.passNumCount !== undefined) document.getElementById('pass-num-count').value = readStoredNumber(saved.passNumCount, 1, 10, 2);
        if (saved.userNumCount !== undefined) document.getElementById('user-num-count').value = readStoredNumber(saved.userNumCount, 1, 9, 3);
        if (['-', '_', '.', ' ', 'random'].includes(saved.passSep)) document.getElementById('opt-pass-sep').value = saved.passSep;
        el.passMaxWordLength.value = readStoredNumber(saved.passMaxWordLength, 1, 512, '');
        if (['', '-', '_', '.'].includes(saved.userSep)) document.getElementById('opt-user-sep').value = saved.userSep;
        if (restorePattern && typeof saved.patternStr === 'string') el.patternInput.value = saved.patternStr.slice(0, 512);
        el.rawByteLength.value = [32, 64].includes(saved.rawByteLength) ? String(saved.rawByteLength) : '32';
        el.rawEncoding.value = ['hex', 'base64', 'base64url'].includes(saved.rawEncoding) ? saved.rawEncoding : 'hex';

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
    const remoteHttp = location.protocol === 'http:' && !isLoopback();
    document.getElementById('delivery-warning').classList.toggle('hidden', !remoteHttp);
    document.getElementById('connection-info').textContent = location.protocol === 'file:' ? 'Connection: local file'
        : remoteHttp ? 'Connection: unencrypted HTTP'
        : location.protocol === 'https:' ? 'Connection: HTTPS (verify browser trust)' : 'Connection: loopback HTTP';
    const build = globalThis.VAULT_BUILD || { version: 'unknown', commit: 'source' };
    document.getElementById('build-info').textContent = `Version ${build.version} · ${build.commit === 'source' ? 'source checkout' : `commit ${build.commit.slice(0, 12)}`}`;
    updateActionAvailability();
    return canGenerateHere();
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

function exportPortableProfile() {
    if (isParanoid() || !canGenerateHere() || bulkJob) return;
    try {
        const recipe = collectGenerationProfile();
        if (recipe.mode === 'pattern') delete recipe.options.template;
        const { profile } = prepareGenerationProfile(recipe, WORDS);
        const data = profile.mode === 'pattern' ? recipe : { ...profile, options: { ...profile.options } };
        if (profile.mode === 'password') {
            for (const field of Object.keys(PASSWORD_MINIMUMS)) {
                if (!Object.hasOwn(recipe.options, field)) delete data.options[field];
            }
        }
        downloadLocalFile(`${JSON.stringify(data, null, 2)}\n`, 'homelab-vault-profile.json', 'application/json');
        showToast('Downloaded the generation profile.');
    } catch (error) {
        showToast(`Could not export this profile. ${error.message}`);
    }
}

function applyPortableProfile(profile, suppliedOptions) {
    const { mode, options } = profile;
    const settings = collectSettings();
    settings.mode = MODES.find((name) => PROFILE_MODES[name] === mode);
    settings.strictLength = options.maxLength != null;
    settings.targetMaxLength = options.maxLength ?? '';

    switch (mode) {
    case 'password':
        settings.lengths.pwd = options.length;
        for (const key of ['upper', 'lower', 'nums', 'syms', 'ambig']) settings[key] = options[key];
        settings.symPool = options.symbols;
        settings.symbolPreset = options.symbols === DEFAULT_SYMS ? 'default' : options.symbols === CONFIG_FRIENDLY_SYMS ? 'friendly' : 'custom';
        settings.passwordExclude = options.exclude;
        settings.passwordMinimums = Object.fromEntries(Object.keys(PASSWORD_MINIMUMS)
            .filter((field) => Object.hasOwn(suppliedOptions, field))
            .map((field) => [field, options[field]]));
        break;
    case 'passphrase':
        settings.lengths.pass = options.count;
        settings.passSep = options.separator;
        settings.passCaps = options.capitalize;
        settings.passCapsRand = options.randomizeCaps;
        settings.passNums = options.insertNumbers;
        settings.passNumCount = options.numberCount;
        settings.passNumsRand = options.randomizePositions;
        settings.passMaxWordLength = options.maxWordLength;
        break;
    case 'username':
        settings.lengths.user = options.count;
        settings.userSep = options.separator;
        settings.userNums = options.appendNumbers;
        settings.userNumCount = options.numberCount;
        settings.userLower = options.lowercase;
        break;
    case 'raw':
        settings.rawByteLength = options.byteLength;
        settings.rawEncoding = options.encoding;
        break;
    case 'pattern':
        settings.patternStr = options.template;
        break;
    }
    applySettings(settings, true);
    updateUI();
    saveSettings();
}

async function importPortableProfile() {
    const file = el.profileFile.files[0];
    el.profileFile.value = '';
    if (!file || isParanoid() || !canGenerateHere() || bulkJob) return;
    const request = ++profileImportRequest;
    if (file.size > MAX_PROFILE_BYTES) {
        showToast('Choose a generation profile under 16 KiB.');
        return;
    }
    const mayApply = () => request === profileImportRequest && !isParanoid() && canGenerateHere() && !bulkJob;
    try {
        const data = await file.text();
        if (!mayApply()) return;
        const supplied = JSON.parse(data);
        const { profile } = prepareGenerationProfile(supplied, WORDS);
        applyPortableProfile(profile, supplied.options);
        showToast('Generation profile loaded.');
    } catch (error) {
        if (mayApply()) showToast('Could not read a valid generation profile from this file.');
    }
}

function applyProfile(value) {
    const base = {
        mode: 'pwd', lengths: { pwd: 24, pass: 6, user: 2 },
        upper: true, lower: true, nums: true, syms: true, ambig: false,
        symbolPreset: 'default', passCaps: true, passCapsRand: false,
        passNums: false, passNumsRand: true, passNumCount: 2, passSep: '-',
        userNums: true, userNumCount: 3, userSep: '', userLower: false,
        rawByteLength: 32, rawEncoding: 'hex',
        targetMaxLength: '', patternStr: DEFAULT_PATTERN
    };
    const presets = {
        balanced: {}, alphanumeric: { syms: false }, friendly: { symbolPreset: 'friendly' },
        passphrase: { mode: 'pass' }, pin: { lengths: { pwd: 6, pass: 6, user: 2 }, upper: false, lower: false, syms: false },
        'raw-hex': { mode: 'raw' },
        'raw-base64': { mode: 'raw', rawEncoding: 'base64' }
    };
    const profile = value.startsWith('saved:') ? savedProfiles[Number(value.slice(6))] : null;
    if (!profile && !Object.hasOwn(presets, value)) return;
    applySettings(profile ? profile.settings : { ...base, ...presets[value] }, true);
    updateUI();
    saveSettings();
    el.profileSelect.value = value;
    el.profileName.value = profile ? profile.name : '';
    updateActionAvailability();
}

function applyParanoidMode(active, updateAddress = true) {
    profileImportRequest++;
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
el.downloadCurrent.addEventListener('click', downloadCurrentCredential);

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
el.modeSelect.addEventListener('change', () => activateMode(el.modeSelect.value));

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

for (const id of ['opt-pass-sep', 'opt-user-sep', 'raw-byte-length', 'raw-encoding']) {
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

el.passwordExclude.addEventListener('input', () => {
    const normalized = normalizeExclusions(el.passwordExclude.value);
    if (el.passwordExclude.value !== normalized) el.passwordExclude.value = normalized;
    generate();
    saveSettings();
});
for (const input of [...Object.keys(PASSWORD_MINIMUMS).map(minimumField), el.passMaxWordLength]) {
    input.addEventListener('input', () => {
        generate();
        saveSettings();
    });
}

bindBoundedNumber(document.getElementById('pass-num-count'), 1, 10, 2);
bindBoundedNumber(document.getElementById('user-num-count'), 1, 9, 3);

el.clearTime.addEventListener('change', () => {
    el.customClearTime.classList.toggle('hidden', el.clearTime.value !== 'custom');
    updatePrivacySummary();
    saveSettings();
});
el.customClearTime.addEventListener('change', () => {
    el.customClearTime.value = readIntField('custom-clear-time', 1, 86400, 60);
    updatePrivacySummary();
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
        const qr = new QRCode(el.qrContainer, {
            text: currentResult,
            width: 210,
            height: 210,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
        const canvas = el.qrContainer.querySelector('canvas');
        if (canvas) {
            // The pinned renderer draws fractional modules at a fixed size.
            // Redraw its encoded matrix at integer pixels, retaining at least
            // four pixels per module for dense credentials before CSS scaling.
            const matrix = qr._oQRCode;
            const modules = matrix.getModuleCount();
            const scale = Math.max(4, Math.floor(210 / modules));
            canvas.width = canvas.height = modules * scale;
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#000000';
            for (let row = 0; row < modules; row++) {
                for (let column = 0; column < modules; column++) {
                    if (matrix.isDark(row, column)) context.fillRect(column * scale, row * scale, scale, scale);
                }
            }
            el.qrModal.classList.toggle('qr-expanded', canvas.width > 210);
        }
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
    if (el.strictLength.checked) generate();
    else updateCompatibility();
    saveSettings();
});
el.strictLength.addEventListener('change', () => {
    generate();
    saveSettings();
});
el.profileSelect.addEventListener('change', () => applyProfile(el.profileSelect.value));
el.profileExport.addEventListener('click', exportPortableProfile);
el.profileImport.addEventListener('click', () => el.profileFile.click());
el.profileFile.addEventListener('change', importPortableProfile);
el.profileSave.addEventListener('click', () => {
    if (isParanoid()) return;
    const name = el.profileName.value.trim().slice(0, 40);
    if (!name) { showToast('Enter a preset name.'); el.profileName.focus(); return; }
    let index = savedProfiles.findIndex((p) => p.name === name);
    if (index === -1) {
        if (savedProfiles.length >= 20) { showToast('Delete a preset before adding another (maximum 20).'); return; }
        index = savedProfiles.length;
    }
    savedProfiles[index] = { name, settings: collectSettings(true) };
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
