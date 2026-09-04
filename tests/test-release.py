#!/usr/bin/env python3
"""Isolated release packaging tests; no network, third-party packages, or Git needed."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts" / "build-release.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("build_release", SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

VERSION = "2.2.0"
COMMIT = "0123456789abcdef" * 2 + "01234567"
EXPECTED_FILES = {
    "Caddyfile", "CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md",
    "THIRD_PARTY_NOTICES.md", "app.js", "assets/vault-icon.png", "core.js",
    "docker-compose.yml", "index.html", "install-caddy-lxc.sh", "nginx.conf",
    "qrcode.min.js", "styles.css", "version.js", "words.js", "RELEASE-MANIFEST.json",
}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.root = self.workspace / "source"
        self.root.mkdir()
        self.output = self.workspace / "dist"
        # Use a complete fixture, not the live checkout, so failed-validation
        # cases cannot alter source files while another task is editing them.
        for name in EXPECTED_FILES - {"RELEASE-MANIFEST.json"}:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"fixture line one\r\nfixture line two\r\n")
        (self.root / "assets/vault-icon.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00binary\xff")
        (self.root / "package.json").write_text(json.dumps({"version": VERSION}), encoding="utf-8")
        (self.root / "version.js").write_text(
            f"'use strict';\nglobalThis.VAULT_BUILD = Object.freeze({{ version: '{VERSION}', commit: 'source' }});\n",
            encoding="utf-8",
        )
        (self.root / "install-caddy-lxc.sh").write_bytes(f'#!/bin/sh\r\nRELEASE_VERSION="{VERSION}"\r\n'.encode())
        for ignored in ["node_modules/private.txt", ".git/config", "tests/private.txt", "secret.env"]:
            target = self.root / ignored
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("Do not package", encoding="utf-8")

    def build(self, version=VERSION, commit=COMMIT, output=None):
        return release.build_release(self.root, version, commit, output or self.output)

    def artifact_bytes(self, output):
        return {path.name: path.read_bytes() for path in output.iterdir()}

    def test_exact_assets_metadata_hashes_and_roundtrip(self):
        paths = self.build(commit=COMMIT.upper())
        self.assertEqual({path.name for path in paths}, {
            "homelab-vault-gen-v2.2.0.zip", "homelab-vault-gen-v2.2.0.manifest.json", "SHA256SUMS",
        })
        archive_path = self.output / "homelab-vault-gen-v2.2.0.zip"
        external_manifest = (self.output / "homelab-vault-gen-v2.2.0.manifest.json").read_bytes()
        manifest = json.loads(external_manifest)
        self.assertEqual(manifest["version"], VERSION)
        self.assertEqual(manifest["commit"], COMMIT)
        self.assertEqual({entry["path"] for entry in manifest["files"]}, EXPECTED_FILES - {"RELEASE-MANIFEST.json"})

        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.namelist(), sorted(EXPECTED_FILES))
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read("RELEASE-MANIFEST.json"), external_manifest)
            self.assertIn(f"commit: '{COMMIT}'", archive.read("version.js").decode())
            self.assertNotIn("commit: 'source'", archive.read("version.js").decode())
            for entry in manifest["files"]:
                content = archive.read(entry["path"])
                self.assertEqual(hashlib.sha256(content).hexdigest(), entry["sha256"])
                self.assertEqual(len(content), entry["size"])
                info = archive.getinfo(entry["path"])
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                expected_mode = 0o755 if entry["path"] == "install-caddy-lxc.sh" else 0o644
                self.assertEqual(stat.S_IMODE(info.external_attr >> 16), expected_mode)
                self.assertEqual(entry["mode"], f"{expected_mode:04o}")
                if entry["path"] != "assets/vault-icon.png":
                    self.assertNotIn(b"\r", content)
            self.assertEqual(archive.read("assets/vault-icon.png"), (self.root / "assets/vault-icon.png").read_bytes())
            extracted = self.workspace / "extracted"
            archive.extractall(extracted)
            for entry in manifest["files"]:
                self.assertEqual((extracted / entry["path"]).read_bytes(), archive.read(entry["path"]))

        for line in (self.output / "SHA256SUMS").read_text().splitlines():
            expected_hash, name = line.split("  ", 1)
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), expected_hash)
        self.assertIn("commit: 'source'", (self.root / "version.js").read_text())

    def test_determinism_across_rebuilds_timestamps_modes_and_line_endings(self):
        self.build()
        original = self.artifact_bytes(self.output)
        self.build()
        self.assertEqual(self.artifact_bytes(self.output), original)
        for name in EXPECTED_FILES - {"RELEASE-MANIFEST.json", "assets/vault-icon.png"}:
            source = self.root / name
            source.write_bytes(source.read_bytes().replace(b"\r\n", b"\n"))
            source.chmod(0o600)
        second = self.workspace / "second"
        self.build(output=second)
        self.assertEqual(self.artifact_bytes(second), original)

    def test_invalid_version_and_commit_fail_before_writes(self):
        for version in ["v2.2.0", "../2.2.0", "2.2", "02.2.0", "2.2.1", "2.2.0\n"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.build(version=version)
            self.assertFalse(self.output.exists())
        for commit in ["", "abc1234", "a" * 39, "a" * 41, "g" * 40, COMMIT + "\n"]:
            with self.subTest(commit=commit), self.assertRaises(ValueError):
                self.build(commit=commit)
            self.assertFalse(self.output.exists())

    def test_all_three_version_sources_must_match(self):
        for name in ["package.json", "version.js", "install-caddy-lxc.sh"]:
            source = self.root / name
            original = source.read_bytes()
            source.write_bytes(original.replace(b"2.2.0", b"2.1.0"))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "does not match"):
                self.build()
            self.assertFalse(self.output.exists())
            source.write_bytes(original)

    def test_missing_asset_fails_before_writes(self):
        (self.root / "assets/vault-icon.png").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or unsafe"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_unsafe_output_does_not_modify_unrelated_files(self):
        sentinel = self.workspace / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        self.output.mkdir()
        (self.output / "SHA256SUMS").mkdir()
        with self.assertRaisesRegex(ValueError, "unsafe output"):
            self.build()
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual({entry.name for entry in self.output.iterdir()}, {"SHA256SUMS"})
        with self.assertRaisesRegex(ValueError, "directory"):
            self.build(output=sentinel)

    def test_symlink_output_is_rejected(self):
        sentinel = self.workspace / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        self.output.mkdir()
        try:
            (self.output / "SHA256SUMS").symlink_to(sentinel)
        except (OSError, NotImplementedError):
            self.skipTest("Creating symlinks is unavailable on this host")
        with self.assertRaisesRegex(ValueError, "unsafe output"):
            self.build()
        self.assertEqual(sentinel.read_text(), "keep")

    def test_cli_works_from_another_directory_and_reports_validation_failures(self):
        fixture_script = self.root / "scripts/build-release.py"
        fixture_script.parent.mkdir()
        shutil.copyfile(SCRIPT, fixture_script)
        command = [sys.executable, str(fixture_script), "--version", VERSION, "--commit", COMMIT, "--output", "artifacts"]
        result = subprocess.run(command, cwd=self.workspace, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.workspace / "artifacts/homelab-vault-gen-v2.2.0.zip").is_file())
        command[command.index(COMMIT)] = "short"
        result = subprocess.run(command, cwd=self.workspace, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("full 40-character", result.stderr)


if __name__ == "__main__":
    unittest.main()
