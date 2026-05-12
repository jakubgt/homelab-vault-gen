// ... existing DOM elements ...

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'show';
    setTimeout(() => { toast.className = ''; }, 3000);
}

function triggerCopyFeedback() {
    let delay = parseInt(el.clearTime?.value) || 60000;
    
    // Visual Flash
    el.resultContainer.classList.add('copy-flash');
    setTimeout(() => el.resultContainer.classList.remove('copy-flash'), 500);

    // Toast and Button Change
    showToast(`Copied! Clearing in ${delay/1000}s`);
    el.copyBtn.textContent = `Copied! (${delay/1000}s)`;
    
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
        navigator.clipboard.writeText("");
        el.copyBtn.textContent = "Copy";
        showToast("Clipboard cleared.");
    }, delay);
}

// Ensure generatePassphrase uses the new global WORDS array
function generatePassphrase() {
    const count = +el.length.value;
    let phrase = [];
    for (let i = 0; i < count; i++) {
        let word = WORDS[getSecureRandomInt(WORDS.length)]; // Uses the 7776 words
        // ... rest of caps/nums logic ...
        phrase.push(word);
    }
    el.result.textContent = phrase.join(document.getElementById('opt-pass-sep').value);
}
