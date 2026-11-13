# v2.3.0 — Raw secrets and deployment conveniences

## Added

- Raw secret mode generates 32 or 64 cryptographically random bytes as lowercase Hex, padded Base64, or unpadded Base64URL. Encoding changes the representation, not the 256- or 512-bit entropy. It works with presets, Paranoid Mode, local QR transfer, and exact-value exports.
- A dependency-free Node.js CLI reuses the browser's generation core for passwords, passphrases, usernames, patterns, and raw secrets.
- A minimal runtime-only Docker image, an image-based Compose example, and guarded owner-driven multi-platform GHCR publication tooling. Regular validation remains read-only.
- A web app manifest and 192/512-pixel icons support standalone installation on compatible HTTPS/loopback browsers. No service worker or persistent application cache is introduced; use the verified local ZIP for air-gapped use.
- Updated the application, favicon, and README with the new icon, and linked the author's GitHub profile and repository in About & status.

## Verification and documentation

- Check the parsed NGINX and Caddy CSP directives for consistency, with explicit blocked connections and same-origin manifests.
- Cover raw encodings, CLI behavior, manifest assets, longer QR payloads, and deployment file exposure.
- Add README navigation, release badge, dashboard configuration, and context-specific Docker Compose escaping guidance.
- Include the new runtime assets and CLI in deterministic release archives and LXC installations.

The owner release process and updater protocol 2 remain in place. A source update does not publish a GitHub release or a registry image automatically.

---

# v2.2.1 — Release and updater trust

This security maintenance release makes publication an explicit owner action and prevents the updater from executing installers selected through unreviewed or mutable tags.

## Security and deployment

- Default and version-tag updates require published stable immutable GitHub releases. Bare tags, drafts, prereleases, mutable releases, malformed metadata, and API failures stop the update.
- The updater verifies that main is protected and that the exact candidate commit is in its first-parent history before checkout or execution. A moving main tip causes a retry failure; installer and assets stay pinned to one verified commit.
- Installer protocol 2 prevents the hardened updater from executing older installers that restore raw-tag selection. Explicit full-SHA selection remains available only for reviewed main-history protocol 2 revisions.
- GitHub Actions now tests and prepares artifacts with read-only repository permissions. Tag events cannot initiate publication. The owner publishes manually through a command that verifies repository identity, current protected main, successful CI, tag policies, immutable releases, and deterministic artifacts.
- Added two GitHub tag-ruleset configurations: administrator-only version-tag creation, and no-bypass version-tag update/deletion restrictions. A separate owner-only helper checks remote settings by default and applies missing protections only with `--apply`. It preserves existing branch rules and refuses to overwrite conflicting policies.
- Updated the Docker default from NGINX 1.30.4-alpine to 1.31.7-alpine. `VAULT_IMAGE` overrides remain supported.

## Documentation and verification

- Added the app screenshot, with disposable demo output, to the repository, README, and offline archive.
- Added the owner release guide, explicit trust boundaries, and migration instructions.
- Added regression coverage for malicious orphan tags, off-main/side-parent commits, protected-main/API failures, mutable-release rejection, old-protocol rejection, manual publication, and remote security-configuration guards.

## Upgrade notes

- **Existing v2.2.0 installations require one direct download/run of the v2.2.1 installer from the README.** The old maintenance command rejects protocol 2, so it cannot perform that one-time migration. The installer retains the current Caddy CA.
- GitHub tag protections and release immutability are external settings; merging these files alone does not enable them. Follow `docs/RELEASING.md` and verify the settings before publishing v2.2.1.
- Immutability applies to newly published releases, not retroactively to v2.2.0 assets. Existing version tags are covered once the tag rules are enabled.
- Future releases are published manually by the owner. CI no longer has release-write authority.

[Full changes since v2.2.0](https://github.com/jakubgt/homelab-vault-gen/compare/v2.2.0...v2.2.1)

---

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
