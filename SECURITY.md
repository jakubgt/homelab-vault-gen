# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting flow for this repository when it is available. If it is not available, open an issue asking the maintainer for a private contact method; do not include exploit details or generated credentials in a public issue.

Helpful reports include:

- affected version or commit;
- browser and deployment method;
- a minimal reproduction using non-sensitive sample values;
- expected impact and any suggested mitigation.

## Scope

This project is a static, client-side generator. Relevant reports include biased generation, incorrect entropy accounting, secret persistence, unsafe deployment defaults, CSP bypasses, or code paths that transmit generated values.

Supported releases: report issues against the latest stable release, currently v2.2.0. Updates are published as versioned releases with offline archives and SHA-256 manifests. Checksums establish file consistency; they are not an independent signature or a substitute for authenticated delivery.

Paranoid Mode conceals generated plaintext in the output and accessibility tree, clears on focus loss/page departure, and removes this app's saved preferences and presets. Its launch flag lives in the URL fragment. JavaScript strings, clipboard history, downloaded files, and browser-internal copies cannot be proven erased. Normal-mode settings and named presets include pattern literals; do not use existing secrets as patterns.

CSV exports retain exact raw fields and require Text-column import in spreadsheet programs. The CSV acknowledgement does not sanitize formulas or prevent an importer from converting data. TXT and JSON avoid spreadsheet cell interpretation when used as their native formats.

Compromised browsers, malicious extensions, screen capture, keylogging, clipboard managers, and an untrusted server or network delivering modified application code are outside the application's control, but documentation errors that misrepresent those risks are in scope.
