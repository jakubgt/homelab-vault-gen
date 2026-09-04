#!/usr/bin/env python3
"""Build a reproducible, dependency-free offline release from this checkout."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import zipfile


PROJECT = "homelab-vault-gen"
SOURCE_ROOT = Path(__file__).resolve().parents[1]
RELEASE_FILES = (
    "Caddyfile",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "app.js",
    "assets/vault-icon.png",
    "core.js",
    "docker-compose.yml",
    "index.html",
    "install-caddy-lxc.sh",
    "nginx.conf",
    "qrcode.min.js",
    "styles.css",
    "version.js",
    "words.js",
)
BINARY_FILES = frozenset({"assets/vault-icon.png"})
ARCHIVE_MANIFEST = "RELEASE-MANIFEST.json"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def read_source(root, relative_path):
    source = root / relative_path
    if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):
        raise ValueError(f"Missing or unsafe release source: {relative_path}")
    content = source.read_bytes()
    if relative_path in BINARY_FILES:
        return content
    # Git checkouts on Windows may use CRLF. Release text always follows the
    # repository's LF policy; images retain their exact original bytes.
    return content.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def validate_metadata(root, version, commit):
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("version must use the form X.Y.Z, without a 'v' prefix")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
        raise ValueError("commit must be a full 40-character hexadecimal Git SHA")

    package = json.loads(read_source(root, "package.json"))
    if not isinstance(package, dict) or package.get("version") != version:
        raise ValueError("Requested version does not match package.json")

    version_source = read_source(root, "version.js").decode("utf-8")
    source_match = re.search(
        r"VAULT_BUILD\s*=\s*Object\.freeze\(\s*\{\s*version\s*:\s*(['\"])([^'\"]+)\1",
        version_source,
    )
    if not source_match or source_match.group(2) != version:
        raise ValueError("Requested version does not match source version.js")

    installer = read_source(root, "install-caddy-lxc.sh").decode("utf-8")
    installer_match = re.search(r"^RELEASE_VERSION=(['\"])([^'\"]+)\1\s*$", installer, re.MULTILINE)
    if not installer_match or installer_match.group(2) != version:
        raise ValueError("Requested version does not match installer RELEASE_VERSION")
    return commit.lower()


def file_mode(name):
    return 0o755 if name == "install-caddy-lxc.sh" else 0o644


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def archive_bytes(entries):
    buffer = io.BytesIO()
    # Stored entries avoid compression-library/version differences and keep the
    # archive deterministic across operating systems. The largest asset is PNG.
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in sorted(entries.items()):
            metadata = zipfile.ZipInfo(name, date_time=FIXED_TIMESTAMP)
            metadata.create_system = 3
            metadata.create_version = 20
            metadata.extract_version = 20
            metadata.compress_type = zipfile.ZIP_STORED
            metadata.external_attr = (stat.S_IFREG | file_mode(name)) << 16
            archive.writestr(metadata, content)
    return buffer.getvalue()


def write_artifacts(output, artifacts):
    output = Path(output).expanduser().resolve()
    if output.exists() and not output.is_dir():
        raise ValueError("output must name a directory")
    for name in artifacts:
        target = output / name
        if target.parent != output or target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError(f"Refusing to overwrite unsafe output: {target}")
    output.mkdir(parents=True, exist_ok=True)

    staged = []
    try:
        for name, content in sorted(artifacts.items()):
            with tempfile.NamedTemporaryFile(dir=output, prefix=".release-", delete=False) as temporary:
                staged.append((Path(temporary.name), output / name))
                temporary.write(content)
            os.chmod(temporary.name, 0o644)
        for temporary, target in staged:
            # Replacing a file atomically never follows a destination symlink.
            os.replace(temporary, target)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    return [output / name for name in sorted(artifacts)]


def build_release(root, version, commit, output):
    root = Path(root).resolve()
    commit = validate_metadata(root, version, commit)
    entries = {name: read_source(root, name) for name in RELEASE_FILES}
    entries["version.js"] = (
        "'use strict';\n"
        f"globalThis.VAULT_BUILD = Object.freeze({{ version: '{version}', commit: '{commit}' }});\n"
    ).encode("utf-8")

    manifest = json_bytes({
        "schema": 1,
        "project": PROJECT,
        "version": version,
        "commit": commit,
        "files": [
            {"path": name, "sha256": digest(content), "size": len(content), "mode": f"{file_mode(name):04o}"}
            for name, content in sorted(entries.items())
        ],
    })
    entries[ARCHIVE_MANIFEST] = manifest
    stem = f"{PROJECT}-v{version}"
    artifacts = {
        f"{stem}.zip": archive_bytes(entries),
        f"{stem}.manifest.json": manifest,
    }
    artifacts["SHA256SUMS"] = "".join(
        f"{digest(content)}  {name}\n" for name, content in sorted(artifacts.items())
    ).encode("ascii")
    return write_artifacts(output, artifacts)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Release version, for example 2.2.0")
    parser.add_argument("--commit", required=True, help="Full 40-character Git commit SHA")
    parser.add_argument("--output", required=True, type=Path, help="Directory for release artifacts")
    args = parser.parse_args(argv)
    try:
        outputs = build_release(SOURCE_ROOT, args.version, args.commit, args.output)
    except (OSError, ValueError, UnicodeError) as error:
        print(f"Release build failed: {error}", file=sys.stderr)
        return 1
    for output in outputs:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
