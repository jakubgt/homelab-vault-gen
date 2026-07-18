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

Compromised browsers, malicious extensions, screen capture, keylogging, clipboard managers, and an untrusted server or network delivering modified application code are outside the application's control, but documentation errors that misrepresent those risks are in scope.
