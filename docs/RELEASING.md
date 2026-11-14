# Owner release guide

Publication is a manual action by the owner of `jakubgt/homelab-vault-gen`. CI validates code and prepares artifacts with read-only repository permissions. It does not create tags or publish releases. There is no release bot key or personal access token stored in GitHub Actions.

## Configure GitHub once

The files in `.github/security/` describe the intended protections; they do not activate settings by being committed.

1. Open the repository's [General settings](https://github.com/jakubgt/homelab-vault-gen/settings). Under **Releases**, enable **release immutability**. GitHub applies this only to future releases; existing v2.2.0 assets remain mutable.
2. Open [Rulesets](https://github.com/jakubgt/homelab-vault-gen/settings/rules). Use **New ruleset → Import a ruleset** for each JSON file below, review the imported controls, and create the ruleset with enforcement set to **Active**.

| File | Required effect |
|---|---|
| [`release-tag-creation.json`](../.github/security/release-tag-creation.json) | `ReleaseTagCreationOwnerOnly`: matches `refs/tags/v*`, restricts creation, and has only **Repository administrators** in its always-allowed bypass list. |
| [`release-tag-immutability.json`](../.github/security/release-tag-immutability.json) | `ReleaseTagImmutability`: matches `refs/tags/v*`, restricts updates and deletions, and has **no bypass actors**. |

Check the bypass list after importing; do not assume an exported/imported file retained it. Keeping these as separate rules lets the owner create a new version tag without granting permission to replace or delete existing tags. Leave **Protect Main** active and unchanged. On this personal repository, the owner administers the repository; if ownership or administrative roles change, review this policy again.

Alternatively, with Python 3 and an existing owner login in [GitHub CLI](https://cli.github.com/), run these from a reviewed source checkout:

```bash
python -I scripts/configure-repository-security.py --check
python -I scripts/configure-repository-security.py --apply
python -I scripts/configure-repository-security.py --check
```

The default/`--check` command makes no changes. `--apply` enables immutable releases and creates missing exact rulesets, then reads the settings back. It never changes unrelated settings, deletes rules, or overwrites a conflicting existing rule. If it stops after partially applying protections, review its message and rerun the check. Authentication stays in your existing GitHub CLI credential store; do not put credentials in this repository or paste them into chat.

GitHub documents [release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes) and [ruleset import](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository#importing-a-ruleset).

## Prepare and review a release

1. Update `package.json`, the root/package versions in `package-lock.json`, `public/version.js`, and `RELEASE_VERSION` in the installer together. Add release notes to `docs/CHANGELOG.md` and update current release links in the README.
2. Open a pull request, review the diff, and wait for the required `test` check. Squash-merge it into protected `main`.
3. Wait for the **tests** workflow on the actual merged main commit to pass. The **release** workflow will separately validate and prepare a `release-assets-COMMIT` artifact when `public/version.js` changes. That artifact is not a published GitHub release.
4. Check out the exact current `main` commit with no local modifications. Confirm its full 40-character SHA and review it before publishing.

## Publish as the owner

With GitHub CLI authenticated as `jakubgt`, Python 3, and Git available, build from that clean checkout:

```bash
python -I scripts/build-release.py --version 2.4.0 --commit FULL_40_CHARACTER_COMMIT_SHA --output dist/v2.4.0
python -I scripts/verify-release.py --directory dist/v2.4.0 --version 2.4.0 --commit FULL_40_CHARACTER_COMMIT_SHA
python -I scripts/publish-release.py --version 2.4.0 --commit FULL_40_CHARACTER_COMMIT_SHA --artifacts dist/v2.4.0
```

Replace the placeholder with the reviewed commit's full SHA. Use a separate output directory for each version; the publisher requires exactly that release's three files. `-I` isolates Python from local module shadowing and `PYTHONPATH`. The publisher refuses a dirty checkout, the wrong owner/repository, an unprotected or different current main commit, missing successful CI, missing tag controls, disabled release immutability, mismatched artifacts, or a tag pointing elsewhere. It reproduces the artifacts locally before uploading. It creates a draft, uploads the exact files, and publishes only after rechecking policy and identity. Published releases and existing tag targets are never overwritten. A matching interrupted owner-created draft can be resumed without clobbering conflicting assets.

The archive preserves the organized source layout. Open `public/index.html` for local browser use or run `node cli/vault.cjs` from the extracted root. Runtime assets and their license copies live in `public/`; deployment examples live in `deploy/`, and the changelog lives in `docs/CHANGELOG.md`. Packaging checks that `public/LICENSE` matches the repository's `LICENSE` and stamps the reviewed commit into `public/version.js`. When checking an extracted copy, point `--extracted` at the archive root containing `public/` and `cli/`.

If you publish through GitHub's web interface instead, perform the same review explicitly: create the version tag at the exact tested main commit, create a draft release, attach the offline ZIP, matching manifest, and `SHA256SUMS`, verify all files, then publish with immutability enabled. The CLI guardrails do not apply to manual browser actions. Never publish a draft before its assets are complete, because immutable assets cannot be replaced afterward.

After publication, verify that the release is immutable and the tag resolves to the reviewed SHA. Download the three files and compare their SHA-256 values with the local build. Use the README migration instructions to update existing v2.2.0 LXC installations; their old maintenance command cannot execute protocol 2 directly.

The release workflow automatically runs the standalone verifier after building and before uploading its artifact. To check a fresh download, put the three published files in a separate directory and run the same verifier command against that directory, with the reviewed version and commit. It checks the archive in place without extracting or executing its contents. An optional `--extracted DIRECTORY` also checks listed installed files. Obtain the verifier from a trusted checkout or a previously verified release; it is not a signature and cannot establish authenticity if both an artifact and its checksum source were replaced together.

The separate **Verify published release** workflow runs after a release is published, or manually with an explicit stable version tag. It uses the verifier from a pinned protected-main revision, verifies immutable release metadata and the tag's exact commit, downloads only the expected three assets, and checks their contents. It never executes the downloaded archive, publishes artifacts, or changes repository settings. Inspect its result after publishing, alongside the local publisher's verification.

Container images have a separate owner-controlled publication step after the matching GitHub release. Follow [the container guide](CONTAINERS.md) for the digest-pinned AMD64/ARM64 build, read-only preflight checks, and explicit `--push` command. Publishing source or a GitHub release alone does not publish a registry image. CI continues to validate without package-write or release-write credentials.

## Trust boundaries

Tag rules and main protection reduce what a compromised non-administrator writer or CI token can change. The owner can still administer those settings, so secure the owner account and recovery email and review connected apps, tokens, keys, and collaborators. Immutability prevents replacing a published version; it does not prove a newly published version is benign. Review remains necessary.

An explicit full commit supplied to the updater skips release-record selection but still must be on protected main's first-parent history and support protocol 2. It is a deliberate reviewed-deployment/rollback mechanism, not a way to execute arbitrary branches or legacy installers.
