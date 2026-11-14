# Prebuilt container images

`deploy/Dockerfile` packages only the browser runtime from `public/` and the production NGINX configuration from `deploy/nginx.conf`. The build context allowlist excludes source management files, installers, tests, CLI tools, and unrelated images. NGINX runs as UID 101 on port 8080. The image is designed for a read-only filesystem with a writable `/tmp` tmpfs, all Linux capabilities dropped, and `no-new-privileges`.

The root `docker-compose.yml` continues to support a source checkout: it mounts only `public/` as the web root and reads `deploy/nginx.conf` separately. Root configuration, installer, and test files remain outside the served directory. To build the packaged image from the repository root for testing:

```bash
docker build -f deploy/Dockerfile -t homelab-vault-local .
VAULT_IMAGE=homelab-vault-local docker compose -f deploy/docker-compose.image.yml up -d
```

Open `http://127.0.0.1:8080`. Use trusted HTTPS through a reverse proxy for access from another device. `VAULT_BIND_ADDRESS` and `VAULT_PORT` work as in the source Compose file. The image Compose file does not require source bind mounts.

## Deploy a published image

Images are a separate, manual owner publication step after the matching immutable GitHub release. Adding this Dockerfile does not publish an image. Once the owner has published a version, copy `deploy/docker-compose.image.yml` to a deployment directory and set `VAULT_IMAGE` to the reported reference. Run these commands from that directory:

```bash
export VAULT_IMAGE=ghcr.io/jakubgt/homelab-vault-gen:v2.4.0
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

For a reproducible deployment, use `ghcr.io/jakubgt/homelab-vault-gen@sha256:INDEX_DIGEST` with the actual image-index digest reported by publication. The image index includes Linux AMD64 and ARM64 variants. Version and `sha-FULL_COMMIT` tags are written once by the owner command. Registry administrators can still change tags; only the digest pins exact content. No floating `latest` tag is published, so publishing an older reviewed version cannot move an implicit upgrade channel backward.

The owner must make the GHCR package public once in its package settings for anonymous pulls. Until then, deployment requires an existing authorized registry login. No registry credential belongs in Compose, source control, or application assets.

## Owner publication

Use a reviewed, clean checkout of current protected `main`, GitHub CLI authenticated as `jakubgt`, and Docker Buildx with a builder capable of Linux AMD64 and ARM64. Docker must already be authenticated to GHCR with package write permission. This helper does not create tokens or change registry permissions.

1. Follow [the release guide](RELEASING.md) to publish the tested immutable GitHub release first.
2. Review the official base image's multi-platform index and select its SHA-256 digest. The local Dockerfile has a versioned development default; actual publication requires a digest pin.
3. Run the helper without `--push` to build a local OCI archive beside the source checkout, keeping the checkout clean. Use the full reviewed main commit and actual base digest:

```bash
python3 -I scripts/publish-container.py --version 2.4.0 \
  --commit FULL_40_CHARACTER_COMMIT_SHA \
  --base-image nginxinc/nginx-unprivileged@sha256:REVIEWED_64_CHARACTER_DIGEST
```

4. Review the build and run that same command with `--push` when ready to publish. Remove or move the local `.oci.tar` archive before another local build; the helper never overwrites one.

The helper verifies the owner identity, repository origin, clean checkout, current protected main commit, successful complete CI, release tag rules, published immutable release, and matching release-asset digests. It builds an explicit context from that commit, checks both platform variants in the pinned base, and refuses existing publication tags. Registry authentication/transport errors fail closed. It emits Buildx provenance and SBOM attestations and reports the resulting digest.

This does not guarantee byte-identical rebuilt images: build tooling and attestations can vary. Registry tags also have no compare-and-swap operation; do not run concurrent publishing commands or manually push the same tags. A failed push can leave a tag partially published. Inspect it and retain the first published digest instead of deleting or replacing tags to force a retry. CI validates image build and runtime with read-only repository permissions; it never publishes to GHCR.
