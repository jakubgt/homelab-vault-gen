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

Supported releases: report issues against the latest stable release. The v2.2.1 source includes the hardened updater protocol 2; v2.2.0 and earlier need the one-time installer migration documented in the README. Updates are distributed as versioned releases with offline archives and SHA-256 manifests. Checksums establish file consistency; they are not an independent signature or a substitute for authenticated delivery.

## Release and update trust

For version tags and `latest`, the updater requires a published stable immutable GitHub release. Before checking out or executing downloaded code, it verifies the exact commit is on the first-parent history of the protected `main` branch. Full-commit selection is an explicit release-metadata exception for reviewed protocol 2 revisions; it does not bypass main-history verification. API errors, a changed main tip, and invalid metadata stop the update.

CI tests and builds artifacts with read-only repository permissions. Only the owner publishes releases manually. Repository settings must restrict version-tag creation to the administrator role, prohibit tag updates/deletions without bypass, and enable immutable future releases. The checked-in configuration helper verifies those external controls; source files alone do not configure GitHub. Existing v2.2.0 release assets are not made immutable retroactively. See [the release guide](docs/RELEASING.md).

These controls reduce the impact of compromised non-administrator write access. They cannot prevent an account owner or attacker controlling that account from changing GitHub policy, approving malicious code, or publishing a new release. Secure the owner account and its recovery email with strong authentication, and review authorized apps, tokens, SSH/deploy keys, and collaborators. The application also cannot protect an updater already modified by an attacker with root access.

Paranoid Mode conceals generated plaintext in the output and accessibility tree, clears on focus loss/page departure, and removes this app's saved preferences and presets. Its launch flag lives in the URL fragment. JavaScript strings, clipboard history, downloaded files, and browser-internal copies cannot be proven erased. Normal-mode settings and named presets include pattern literals; do not use existing secrets as patterns.

CSV exports retain exact raw fields and require Text-column import in spreadsheet programs. The CSV acknowledgement does not sanitize formulas or prevent an importer from converting data. TXT and JSON avoid spreadsheet cell interpretation when used as their native formats.

Raw secrets contain 32 or 64 independently random bytes; Hex, Base64, and Base64URL are encodings of those bytes, not extra entropy or algorithm-specific key generation. The CLI prints plaintext to standard output without storing preferences. Terminals, pipes, redirected files, and downstream programs can retain output; JavaScript and stream copies cannot be proven erased.

Standalone web app installation uses a manifest with no service worker or application cache. It does not add offline availability to hosted deployments or alter the memory/clipboard guarantees. Container publication remains a separate owner-only local operation after an immutable tested release; registry tag mutability and publication privileges remain trusted. Pin the reported image index digest for exact deployment content.

Compromised browsers, malicious extensions, screen capture, keylogging, clipboard managers, and an untrusted server or network delivering modified application code are outside the application's control, but documentation errors that misrepresent those risks are in scope.
