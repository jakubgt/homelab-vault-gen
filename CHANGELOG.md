# v2.2.0 — Privacy fixes and everyday usability

This release fixes concealed credential exposure, focus-loss cleanup, and a clipboard completion race, and adds presets, immediate clearing, exact-value JSON export, and versioned deployment tooling.

## Privacy and correctness

- Concealed credentials are removed from the displayed output and accessibility tree. Reveal and Hide explicitly control when plaintext appears.
- Paranoid Mode clears on window blur, hidden tabs, and page departure. A `#paranoid` launch address activates it before generation and survives reload without saving a storage preference.
- Clipboard success handlers track generation and request identities, so stale completions cannot cancel a newer credential's clearing timer or trigger a stale fallback copy.
- Clear now removes the displayed result and QR immediately. The post-copy countdown uses an absolute deadline and catches up after a suspended/background tab resumes.
- CSV export requires explicit acknowledgement of Text-column import to avoid formula interpretation and numeric conversion. TXT and new JSON export preserve exact values without modifying credentials.
- Password core APIs enforce their supported bounds to prevent entropy overflow and class-mask errors outside the UI's supported range.

## Usability

- Added built-in strong-password, alphanumeric, config-friendly, readable-passphrase, and numeric-PIN presets, plus up to 20 named local presets.
- Added actual output length, an advisory target length limit, a password allowed-character preview, and lowercase usernames. Credentials are never silently truncated or filtered.
- Bulk exports yield between batches, show progress, and can be cancelled. Generation settings stay fixed while a batch runs.
- Enlarged QR white margins to cover at least four modules, including in dark mode.
- Added About/status with version, source/deployed commit, connection type, and license links, plus a visible remote-HTTP warning.
- Fixed preset state sharing and numeric-field normalization that could leave output inconsistent with selected options.

## Deployment and maintenance

- The LXC installer and update command deploy installer and assets from one resolved release commit, verify installer consistency, lock concurrent operations, and preserve rollback and the existing Caddy CA.
- Added status and check-update commands. Default updates select stable release tags; explicit tags and full commit SHAs are supported.
- Dependabot now uses the Docker Compose ecosystem for the overridable image default and tracks the new npm development dependencies. The healthcheck uses IPv4 loopback.
- Deployed assets include build metadata and license/third-party notices. Integrity-checked text files use LF line endings.
- Releases include an offline ZIP, SHA256SUMS, and a per-file manifest. The archive records its source commit and excludes development dependencies.

## Tests

- Extracted passphrase and username generation into the shared core with deterministic option, boundary, and entropy tests.
- Added browser regressions for Chromium, Firefox, and WebKit, including clipboard races, storage failures, privacy lifecycle, exports, QR decoding, and presets.
- Added installer rollback/ref-resolution tests, a real Docker startup/header smoke test in CI, and deterministic release packaging tests.
- GitHub release publication is gated on the complete CI suite.

## Upgrade notes

- `version.js`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` must accompany the existing runtime assets. The new release archive, Compose example, and LXC installer include them.
- Existing normal-mode preferences remain supported. Enabling Paranoid Mode removes this app's saved settings, theme, and named presets; unrelated origin storage is preserved.
- Saved presets include settings and pattern literals. Do not enter existing secrets in patterns. Generated results are not saved as preferences.
- To migrate an older LXC updater, run the v2.2.0 installer from the updated README once. Subsequent updates use stable version tags instead of moving `main`.
- The target length limit is advisory. CSV remains unmodified plaintext requiring Text-column import; use TXT/JSON when exact-value interchange is needed.

[Full changes since v2.1.0](https://github.com/jakubgt/homelab-vault-gen/compare/v2.1.0...v2.2.0)
