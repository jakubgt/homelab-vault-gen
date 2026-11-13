#!/usr/bin/env python3
"""Verify real release fixtures and adversarial artifacts without executing them."""

import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/verify-release.py"
sys.dont_write_bytecode = True


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load_module("release_builder_for_verifier_tests", ROOT / "scripts/build-release.py")
verifier = load_module("release_verifier_under_test", SCRIPT)
VERSION = "2.3.0"
COMMIT = "a" * 40
STEM = f"homelab-vault-gen-v{VERSION}"
ARCHIVE = f"{STEM}.zip"
MANIFEST = f"{STEM}.manifest.json"


def digest(content):
    return hashlib.sha256(content).hexdigest()


class VerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="vault-verifier-fixture-")
        cls.addClassCleanup(cls.fixture.cleanup)
        workspace = Path(cls.fixture.name)
        source = workspace / "source"
        source.mkdir()
        # Snapshot the real packaged files; no generated artifact code is run.
        for name in builder.RELEASE_FILES:
            destination = source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        (source / "package.json").write_text(json.dumps({"version": VERSION}), encoding="utf-8")
        (source / "version.js").write_text(
            f"'use strict';\nglobalThis.VAULT_BUILD = Object.freeze({{ version: '{VERSION}', commit: 'source' }});\n",
            encoding="utf-8",
        )
        installer = (source / "install-caddy-lxc.sh").read_text(encoding="utf-8")
        installer, count = re.subn(r"(?m)^RELEASE_VERSION=['\"][^'\"]+['\"]$", f'RELEASE_VERSION="{VERSION}"', installer)
        if count != 1:
            raise AssertionError("The real installer fixture has no unique release version")
        (source / "install-caddy-lxc.sh").write_text(installer, encoding="utf-8")
        output = workspace / "release"
        artifacts = builder.build_release(source, VERSION, COMMIT, output)
        cls.original = {path.name: path.read_bytes() for path in artifacts}
        cls.manifest = json.loads(cls.original[MANIFEST])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vault-verifier-test-")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.directory = self.workspace / "downloads"
        self.directory.mkdir()
        self.reset_artifacts()

    def reset_artifacts(self):
        for path in self.directory.iterdir():
            if path.is_file() or path.is_symlink():
                path.unlink()
        for name, content in self.original.items():
            (self.directory / name).write_bytes(content)

    def sums(self):
        # Adversarial inner changes remain correctly checksummed externally.
        (self.directory / "SHA256SUMS").write_text("".join(
            f"{digest((self.directory / name).read_bytes())}  {name}\n"
            for name in sorted([ARCHIVE, MANIFEST])
        ), encoding="ascii")

    def entries(self):
        with zipfile.ZipFile(self.directory / ARCHIVE) as archive:
            return [(copy.copy(info), archive.read(info)) for info in archive.infolist()]

    def write_entries(self, entries):
        buffer = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(buffer, "w") as archive:
                for info, content in entries:
                    archive.writestr(info, content)
        (self.directory / ARCHIVE).write_bytes(buffer.getvalue())
        self.sums()

    def change_manifest(self, change):
        manifest = json.loads((self.directory / MANIFEST).read_bytes())
        change(manifest)
        self.write_manifest_bytes(builder.json_bytes(manifest))

    def write_manifest_bytes(self, content):
        (self.directory / MANIFEST).write_bytes(content)
        self.write_entries([(info, content if info.filename == "RELEASE-MANIFEST.json" else data)
                            for info, data in self.entries()])

    def assert_rejected(self, **options):
        with self.assertRaises(verifier.VerificationError):
            verifier.verify_release(self.directory, **options)

    def extracted(self):
        destination = self.workspace / "extracted"
        destination.mkdir()
        # Only the known-good fixture is materialized; never extract test ZIPs.
        with zipfile.ZipFile(io.BytesIO(self.original[ARCHIVE])) as archive:
            for info in archive.infolist():
                target = destination / info.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
        return destination

    def symlink_or_skip(self, source, target, directory=False):
        try:
            source.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"This environment cannot create test symlinks: {error}")

    def test_real_builder_artifacts_pass_with_pinned_identity(self):
        result = verifier.verify_release(self.directory, version=VERSION, commit=COMMIT)
        self.assertEqual(result["project"], "homelab-vault-gen")
        self.assertEqual(result["version"], VERSION)
        self.assertEqual(result["commit"], COMMIT)
        self.assertEqual(result["verified_files"], len(self.manifest["files"]))
        self.assertEqual(result["archive"], ARCHIVE)
        self.assertEqual(result["manifest"], MANIFEST)
        self.assertFalse(result["extracted"])
        self.assertEqual({path.name: path.read_bytes() for path in self.directory.iterdir()}, self.original,
                         "Verification must not rewrite or extract downloaded artifacts")

    def test_identity_can_be_inferred_and_unrelated_downloads_are_ignored(self):
        (self.directory / "unrelated-notes.txt").write_text("Not a release artifact", encoding="utf-8")
        result = verifier.verify_release(self.directory)
        self.assertEqual((result["version"], result["commit"]), (VERSION, COMMIT))

    def test_expected_version_and_commit_must_match(self):
        for options in [{"version": "9.9.9"}, {"commit": "b" * 40},
                        {"version": "v2.3.0"}, {"commit": "short"}]:
            with self.subTest(options=options):
                self.assert_rejected(**options)

    def test_outer_checksum_detects_changed_zip_and_manifest(self):
        for name in [ARCHIVE, MANIFEST]:
            with self.subTest(name=name):
                self.reset_artifacts()
                path = self.directory / name
                path.write_bytes(path.read_bytes() + b"changed")
                self.assert_rejected()

    def test_missing_required_downloads_are_rejected(self):
        for name in [ARCHIVE, MANIFEST, "SHA256SUMS"]:
            with self.subTest(name=name):
                self.reset_artifacts()
                (self.directory / name).unlink()
                self.assert_rejected()

    def test_checksums_reject_wrong_hash_duplicate_missing_extra_and_malformed_lines(self):
        valid = self.original["SHA256SUMS"].decode("ascii")
        lines = valid.splitlines(keepends=True)
        variants = [
            "0" * 64 + valid[64:],
            lines[0] + lines[0],
            lines[0],
            valid + "f" * 64 + "  extra.zip\n",
            valid.replace("  ", " ", 1),
            valid.replace(valid[:64], "z" * 64, 1),
            "\ufeff" + valid,
            "\n" + valid,
        ]
        for content in variants:
            with self.subTest(checksums=content[:80]):
                (self.directory / "SHA256SUMS").write_text(content, encoding="utf-8")
                self.assert_rejected()

    def test_checksum_paths_cannot_escape_the_download_directory(self):
        for unsafe in ["../" + ARCHIVE, "/" + ARCHIVE, "C:/" + ARCHIVE,
                       "folder/" + ARCHIVE, "folder\\" + ARCHIVE]:
            with self.subTest(path=unsafe):
                content = self.original["SHA256SUMS"].decode("ascii").replace(ARCHIVE, unsafe)
                (self.directory / "SHA256SUMS").write_text(content, encoding="ascii")
                self.assert_rejected()

    def test_artifact_symlinks_are_rejected(self):
        archive = self.directory / ARCHIVE
        target = self.workspace / "actual.zip"
        archive.replace(target)
        self.symlink_or_skip(archive, target)
        self.assert_rejected()

    def test_embedded_manifest_must_equal_the_external_manifest(self):
        self.write_entries([(info, data + b" " if info.filename == "RELEASE-MANIFEST.json" else data)
                            for info, data in self.entries()])
        self.assert_rejected()

    def test_hash_and_size_check_each_archived_file_after_outer_checksums_match(self):
        self.write_entries([(info, b"tampered bytes" if info.filename == "index.html" else data)
                            for info, data in self.entries()])
        self.assert_rejected()
        for field, value in [("size", 1), ("sha256", "0" * 64)]:
            with self.subTest(field=field):
                self.reset_artifacts()
                self.change_manifest(lambda manifest: manifest["files"][0].__setitem__(field, value))
                self.assert_rejected()

    def test_missing_and_unlisted_archive_entries_are_rejected(self):
        entries = self.entries()
        self.write_entries([(info, data) for info, data in entries if info.filename != "index.html"])
        self.assert_rejected()
        self.reset_artifacts()
        info = copy.copy(entries[0][0])
        info.filename = "unexpected.txt"
        self.write_entries(entries + [(info, b"unlisted")])
        self.assert_rejected()

    def test_duplicate_zip_entries_are_rejected_even_when_identical(self):
        entries = self.entries()
        self.write_entries(entries + [entries[0]])
        self.assert_rejected()

    def test_archive_traversal_absolute_and_backslash_names_are_rejected(self):
        for unsafe in ["../escape.txt", "/absolute.txt", "C:/absolute.txt", "nested\\escape.txt", "./index.html"]:
            with self.subTest(path=unsafe):
                self.reset_artifacts()
                entries = self.entries()
                info = copy.copy(entries[0][0])
                info.filename = unsafe
                self.write_entries(entries + [(info, b"unsafe")])
                self.assert_rejected()
                self.assertFalse((self.workspace / "escape.txt").exists())

    def test_zip_symlink_directory_and_wrong_mode_are_rejected(self):
        for mode, suffix in [(stat.S_IFLNK | 0o777, "link"), (stat.S_IFDIR | 0o755, "directory/"),
                             (stat.S_IFREG | 0o777, "index.html")]:
            with self.subTest(mode=oct(mode)):
                self.reset_artifacts()
                entries = self.entries()
                info = copy.copy(next(item for item, _ in entries if item.filename == "index.html"))
                info.external_attr = mode << 16
                info.filename = suffix
                modified = [(info, b"target" if suffix == "link" else data) if original.filename == "index.html"
                            else (original, data) for original, data in entries]
                self.write_entries(modified)
                self.assert_rejected()

    def test_encrypted_zip_flag_is_rejected_before_a_password_is_requested(self):
        data = bytearray((self.directory / ARCHIVE).read_bytes())
        local = data.index(b"PK\x03\x04")
        central = data.index(b"PK\x01\x02")
        struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 1)
        struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | 1)
        (self.directory / ARCHIVE).write_bytes(data)
        self.sums()
        self.assert_rejected()

    def test_invalid_utf8_zip_name_is_a_controlled_verification_failure(self):
        data = bytearray(self.original[ARCHIVE])
        local = data.index(b"PK\x03\x04")
        central = data.index(b"PK\x01\x02")
        struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 0x800)
        struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | 0x800)
        data[local + 30] = data[central + 46] = 0xff
        (self.directory / ARCHIVE).write_bytes(data)
        self.sums()
        self.assert_rejected()

    def test_invalid_zip_and_json_are_controlled_verification_failures(self):
        (self.directory / ARCHIVE).write_bytes(b"not a ZIP file")
        self.sums()
        self.assert_rejected()
        self.reset_artifacts()
        (self.directory / MANIFEST).write_bytes(b"{not JSON")
        self.sums()
        self.assert_rejected()

    def test_manifest_schema_identity_and_file_types_are_validated(self):
        changes = [
            lambda manifest: manifest.__setitem__("schema", 2),
            lambda manifest: manifest.__setitem__("schema", True),
            lambda manifest: manifest.__setitem__("project", "other-project"),
            lambda manifest: manifest.__setitem__("version", "2.3.0/../bad"),
            lambda manifest: manifest.__setitem__("commit", "short"),
            lambda manifest: manifest.__setitem__("files", []),
            lambda manifest: manifest.__setitem__("files", "not a list"),
            lambda manifest: manifest["files"].append(copy.copy(manifest["files"][0])),
            lambda manifest: manifest["files"][0].__setitem__("size", -1),
            lambda manifest: manifest["files"][0].__setitem__("size", True),
            lambda manifest: manifest["files"][0].__setitem__("size", "10"),
            lambda manifest: manifest["files"][0].__setitem__("sha256", "invalid"),
            lambda manifest: manifest["files"][0].__setitem__("mode", "0777"),
            lambda manifest: manifest["files"][0].__setitem__("mode", []),
            lambda manifest: manifest["files"][0].__setitem__("mode", {}),
            lambda manifest: manifest["files"][0].pop("path"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(case=index):
                self.reset_artifacts()
                self.change_manifest(change)
                self.assert_rejected()

    def test_duplicate_json_keys_and_oversized_integers_fail_with_controlled_errors(self):
        baseline = self.original[MANIFEST]
        for content in [baseline.replace(b'"schema": 1', b'"schema": 1, "schema": 1', 1),
                        baseline.replace(b'"schema": 1', b'"schema": ' + b'9' * 5000, 1)]:
            with self.subTest(prefix=content[:80]):
                self.reset_artifacts()
                self.write_manifest_bytes(content)
                self.assert_rejected()

    def test_manifest_case_aliases_and_file_parent_conflicts_are_rejected(self):
        for name in ["release-manifest.json", self.manifest["files"][0]["path"].upper(), "assets"]:
            with self.subTest(path=name):
                self.reset_artifacts()
                def add_alias(manifest):
                    entry = copy.copy(manifest["files"][0])
                    entry["path"] = name
                    manifest["files"].append(entry)
                self.change_manifest(add_alias)
                self.assert_rejected()

    def test_unsafe_manifest_paths_are_rejected_with_consistent_outer_checksums(self):
        for unsafe in ["../file", "/file", "C:/file", "a\\file", "a/../file", "./file", "a//file",
                       "RELEASE-MANIFEST.json"]:
            with self.subTest(path=unsafe):
                self.reset_artifacts()
                self.change_manifest(lambda manifest: manifest["files"][0].__setitem__("path", unsafe))
                self.assert_rejected()

    def test_explicit_resource_bounds_fail_closed(self):
        total = sum(info.file_size for info, _ in self.entries())
        largest = max(info.file_size for info, _ in self.entries())
        limits = {"MAX_ARCHIVE_BYTES": len(self.original[ARCHIVE]) - 1,
                  "MAX_TOTAL_BYTES": total - 1,
                  "MAX_FILE_BYTES": largest - 1,
                  "MAX_FILES": len(self.entries()) - 1}
        for name, limit in limits.items():
            with self.subTest(limit=name), patch.object(verifier, name, limit):
                self.assert_rejected()

    def test_compressed_oversized_entry_is_rejected_after_outer_checksum_is_recomputed(self):
        entries = self.entries()
        largest = max(info.file_size for info, _ in entries)
        payload = b"0" * (largest + 1000)
        modified = []
        for info, data in entries:
            if info.filename == "index.html":
                info.compress_type = zipfile.ZIP_DEFLATED
                data = payload
            modified.append((info, data))
        self.write_entries(modified)
        def record_payload(manifest):
            entry = next(entry for entry in manifest["files"] if entry["path"] == "index.html")
            entry.update(size=len(payload), sha256=digest(payload))
        self.change_manifest(record_payload)
        # The compressed ZIP stays small while its decoded member exceeds this bound.
        with patch.object(verifier, "MAX_FILE_BYTES", largest):
            self.assert_rejected()

    def test_oversized_zip_footer_is_rejected_before_allocating_entry_objects(self):
        for field, value in [("count", verifier.MAX_FILES + 2),
                             ("directory_bytes", verifier.MAX_DIRECTORY_BYTES + 1)]:
            with self.subTest(field=field):
                self.reset_artifacts()
                content = bytearray(self.original[ARCHIVE])
                footer = len(content) - 22
                self.assertEqual(content[footer:footer + 4], b"PK\x05\x06")
                if field == "count":
                    struct.pack_into("<HH", content, footer + 8, value, value)
                else:
                    struct.pack_into("<L", content, footer + 12, value)
                (self.directory / ARCHIVE).write_bytes(content)
                self.sums()
                with patch.object(verifier.zipfile, "ZipFile", side_effect=AssertionError("Unbounded directory parsing")):
                    self.assert_rejected()

    def test_optional_extracted_files_match_and_unlisted_extras_are_ignored(self):
        extracted = self.extracted()
        (extracted / "my-local-notes.txt").write_text("Local extra", encoding="utf-8")
        result = verifier.verify_release(self.directory, extracted=extracted)
        self.assertTrue(result["extracted"])
        (extracted / "index.html").write_bytes(b"changed after extraction")
        self.assert_rejected(extracted=extracted)

    def test_missing_extracted_file_and_embedded_manifest_are_rejected(self):
        extracted = self.extracted()
        (extracted / "index.html").unlink()
        self.assert_rejected(extracted=extracted)
        (extracted / "index.html").write_bytes(next(data for info, data in self.entries() if info.filename == "index.html"))
        (extracted / "RELEASE-MANIFEST.json").write_bytes(b"{}")
        self.assert_rejected(extracted=extracted)

    def test_extracted_file_symlink_cannot_redirect_verification(self):
        extracted = self.extracted()
        source = extracted / "index.html"
        outside = self.workspace / "outside.html"
        source.replace(outside)
        self.symlink_or_skip(source, outside)
        self.assert_rejected(extracted=extracted)

    def test_extracted_parent_symlink_cannot_redirect_verification(self):
        extracted = self.extracted()
        source = extracted / "assets"
        outside = self.workspace / "outside-assets"
        source.rename(outside)
        self.symlink_or_skip(source, outside, directory=True)
        self.assert_rejected(extracted=extracted)

    def test_cli_reports_success_with_pinned_identity_and_extracted_files(self):
        extracted = self.extracted()
        result = subprocess.run([
            sys.executable, "-I", str(SCRIPT), "--directory", str(self.directory),
            "--version", VERSION, "--commit", COMMIT, "--extracted", str(extracted),
        ], capture_output=True, text=True, encoding="utf-8", timeout=30, cwd=self.workspace)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn(VERSION, result.stdout)
        self.assertIn(COMMIT, result.stdout)

    def test_cli_returns_nonzero_on_corruption_without_extracting_or_running_artifacts(self):
        (self.directory / ARCHIVE).write_bytes(self.original[ARCHIVE] + b"corrupt")
        result = subprocess.run([
            sys.executable, "-I", str(SCRIPT), "--directory", str(self.directory),
        ], capture_output=True, text=True, encoding="utf-8", timeout=30, cwd=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.strip())
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual({path.name for path in self.workspace.iterdir()}, {"downloads"})


if __name__ == "__main__":
    unittest.main()
