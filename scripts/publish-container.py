#!/usr/bin/env python3
"""Build and optionally publish a reviewed multi-platform image as the owner."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
IMAGE = "ghcr.io/jakubgt/homelab-vault-gen"
CONTEXT_FILES = (
    "Dockerfile", ".dockerignore", "nginx.conf", "index.html", "styles.css",
    "core.js", "app.js", "words.js", "qrcode.min.js", "version.js", "LICENSE",
    "THIRD_PARTY_NOTICES.md", "manifest.webmanifest", "assets/vault-icon.png",
    "assets/icon-192.png", "assets/icon-512.png",
)
BASE_PATTERN = r"nginxinc/nginx-unprivileged@sha256:[0-9a-f]{64}"

def load_policy(root=ROOT):
    """Verify the helper against HEAD before any of its Python code executes."""
    root = Path(root).resolve()
    source = root / "scripts/publish-release.py"
    if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):
        raise RuntimeError("Missing or unsafe local release-policy helper.")
    result = subprocess.run(["git", "--no-replace-objects", "show", "HEAD:scripts/publish-release.py"],
                            cwd=root, capture_output=True, timeout=30)
    normalize = lambda content: content.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if result.returncode or normalize(source.read_bytes()) != normalize(result.stdout):
        raise RuntimeError("Release-policy helper differs from the reviewed commit; refusing to execute it.")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("vault_release_policy", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Share existing owner/main/CI/release checks only after verifying the helper.
# This entry script is a locally reviewed owner command; CI has no write token.
policy = load_policy()


class Docker:
    def __init__(self, root):
        self.root = Path(root)

    def run(self, *args, timeout=60):
        environment = os.environ.copy()
        environment.pop("DOCKER_CLI_HINTS", None)
        result = subprocess.run(["docker", *args], cwd=self.root, capture_output=True,
                                text=True, encoding="utf-8", timeout=timeout, env=environment)
        if result.returncode:
            raise policy.PolicyError("Docker failed; inspect the local builder and registry login. No registry error was treated as an absent tag.")
        return result.stdout

    def inspect(self, reference):
        result = subprocess.run(["docker", "buildx", "imagetools", "inspect", "--raw", reference],
                                cwd=self.root, capture_output=True, text=True,
                                encoding="utf-8", timeout=60)
        if result.returncode:
            # Buildx distinguishes a missing manifest from transport/auth failures.
            # Do not interpret a generic nonzero status, 401, 403, or timeout as absence.
            message = result.stderr.strip()
            missing = re.fullmatch(r"(?:ERROR:\s*)?" + re.escape(reference) + r": (?:not found|manifest unknown)", message)
            if missing:
                return None
            raise policy.PolicyError("Registry inspection failed; tag absence could not be established. Authenticate Docker to GHCR and retry.")
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise policy.PolicyError("Registry inspection returned invalid manifest JSON.") from None
        policy.require(isinstance(value, dict), "Registry returned an invalid manifest.")
        return value


def verify_release(client, root, version, commit):
    policy.verify_checkout(client, commit)
    policy.require(client.api("GET", "user").get("login") == "jakubgt",
                   "Authenticate GitHub CLI as jakubgt before publishing.")
    policy.verify_main_and_immutability(client, commit)
    policy.verify_tag_rules(client, root)
    policy.verify_ci(client, commit)
    policy.verify_tag(client, f"v{version}", commit)
    release = client.api("GET", f"repos/{policy.REPOSITORY}/releases/tags/v{version}")
    policy.require(release.get("tag_name") == f"v{version}"
                   and release.get("draft") is False and release.get("prerelease") is False
                   and release.get("immutable") is True,
                   "Publish the matching stable immutable GitHub release first.")
    # Reproduce the source release and compare its remote asset digests, not just
    # a version label. This also verifies package/installer/version agreement.
    expected = policy.expected_artifacts(root, version, commit)
    policy.verify_assets(release, expected, complete=True)


def require_platforms(manifest):
    platforms = {f"{entry.get('platform', {}).get('os')}/{entry.get('platform', {}).get('architecture')}"
                 for entry in manifest.get("manifests", [])}
    policy.require({"linux/amd64", "linux/arm64"}.issubset(platforms),
                   "The image index must provide both linux/amd64 and linux/arm64.")


def build_context(client, destination):
    for name in CONTEXT_FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        # Read the verified commit rather than local ignored/skip-worktree files.
        # No .git, deployment scripts, tests, or caller files enter the context.
        target.write_bytes(client.git_blob(name))


def publish(root, version, commit, base_image, push=False, client=None, docker=None, environ=None):
    environ = os.environ if environ is None else environ
    policy.require(environ.get("GITHUB_ACTIONS", "").lower() != "true",
                   "Image publication is an owner-only local command, not a CI job.")
    policy.require(re.fullmatch(policy.VERSION_PATTERN, version) is not None,
                   "Use a stable X.Y.Z version without a v prefix.")
    policy.require(re.fullmatch(r"[0-9a-fA-F]{40}", commit) is not None,
                   "A full 40-character commit SHA is required.")
    policy.require(re.fullmatch(BASE_PATTERN, base_image) is not None,
                   "Pin the reviewed nginxinc/nginx-unprivileged multi-platform SHA-256 digest.")
    root = Path(root).resolve()
    commit = commit.lower()
    client = client or policy.Client(root)
    docker = docker or Docker(root)
    verify_release(client, root, version, commit)
    for source in ("scripts/publish-container.py", "scripts/publish-release.py", *CONTEXT_FILES):
        policy.verify_tracked_file(client, root, source, binary=source.endswith(".png"))
    tags = [f"{IMAGE}:v{version}", f"{IMAGE}:sha-{commit}"]
    for tag in tags:
        policy.require(docker.inspect(tag) is None,
                       "An image tag already exists. It was left unchanged; select a new reviewed release version.")
    base = docker.inspect(base_image)
    policy.require(base is not None, "The pinned base image does not exist.")
    require_platforms(base)
    docker.run("buildx", "version")
    with tempfile.TemporaryDirectory(prefix="vault-container-") as temporary:
        temporary = Path(temporary)
        context = temporary / "context"
        context.mkdir()
        build_context(client, context)
        metadata = temporary / "metadata.json"
        command = ["buildx", "build", "--platform", "linux/amd64,linux/arm64",
                   "--build-arg", f"BASE_IMAGE={base_image}",
                   "--build-arg", f"VAULT_VERSION={version}",
                   "--build-arg", f"VAULT_COMMIT={commit}",
                   "--provenance=mode=max", "--sbom=true", "--metadata-file", str(metadata)]
        for tag in tags:
            command.extend(["--tag", tag])
        # Default is a local OCI archive, so merely reviewing/running this command
        # cannot publish an image. --push is an explicit owner action.
        if push:
            verify_release(client, root, version, commit)
            for tag in tags:
                policy.require(docker.inspect(tag) is None, "A publication tag appeared; refusing to replace it.")
            command.append("--push")
        else:
            archive = root.parent / f"homelab-vault-gen-v{version}.oci.tar"
            policy.require(not archive.exists() and not archive.is_symlink(),
                           "The local OCI archive already exists; move it before building again.")
            command.extend(["--output", f"type=oci,dest={archive}"])
        command.append(str(context))
        docker.run(*command, timeout=3600)
        policy.require(metadata.is_file(), "Buildx did not return image metadata; inspect the builder before retrying.")
        details = json.loads(metadata.read_text(encoding="utf-8"))
        digest = details.get("containerimage.digest")
        policy.require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None,
                       "Buildx returned an invalid image digest; inspect the publication manually.")
    if push:
        published = docker.inspect(f"{IMAGE}@{digest}")
        policy.require(published is not None, "The published image digest could not be read back.")
        require_platforms(published)
        for tag in tags:
            manifest = docker.inspect(tag)
            policy.require(manifest == published, "A publication tag does not match the built digest; inspect GHCR before continuing.")
        return f"Published {', '.join(tags)}\nPin the image as {IMAGE}@{digest}. No latest tag was written."
    return f"Built local OCI archive {archive}\nImage index digest: {digest}. Nothing was published."


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--base-image", required=True,
                        help="Reviewed multi-platform nginxinc/nginx-unprivileged@sha256:... reference")
    parser.add_argument("--push", action="store_true", help="Publish version and full-commit tags to GHCR")
    args = parser.parse_args(argv)
    try:
        print(publish(ROOT, args.version, args.commit, args.base_image, args.push))
    except (policy.PolicyError, OSError, subprocess.TimeoutExpired, ValueError) as error:
        print(f"Container publication stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
