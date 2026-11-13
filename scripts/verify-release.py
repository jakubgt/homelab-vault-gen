#!/usr/bin/env python3
"""Verify local release checksums and archive contents without extracting or executing them.

Checksums establish consistency, not authenticity. Obtain the verifier, checksum
file, and release artifacts through a trusted channel. This command cannot detect
an attacker who replaced the artifacts and their checksums together.
"""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import zipfile
import zlib


PROJECT = "homelab-vault-gen"
ARCHIVE_MANIFEST = "RELEASE-MANIFEST.json"
VERSION_PATTERN = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_DIRECTORY_BYTES = 1024 * 1024
MAX_CHECKSUM_BYTES = 4096
MAX_FILES = 256
MAX_PATH_BYTES = 240
CHUNK_BYTES = 64 * 1024


class VerificationError(ValueError):
    """The selected local release did not satisfy the verification contract."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def _is_link(metadata):
    # Junctions and other Windows reparse points must not redirect a checked path.
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _directory(value, label):
    try:
        candidate = Path(value).expanduser()
        metadata = candidate.lstat()
        require(not _is_link(metadata) and stat.S_ISDIR(metadata.st_mode),
                f"{label} must be a real directory, not a symlink or reparse point.")
        return candidate.resolve(strict=True)
    except (OSError, TypeError, RuntimeError) as error:
        raise VerificationError(f"Cannot open {label} as a local directory.") from error


def _safe_path(name):
    require(isinstance(name, str) and 0 < len(name) <= MAX_PATH_BYTES
            and re.fullmatch(r"[A-Za-z0-9._/-]+", name) is not None,
            "The manifest or ZIP contains an unsafe path.")
    parts = name.split("/")
    require(all(part not in {"", ".", ".."} and not part.endswith(".") for part in parts),
            "The manifest or ZIP contains an unsafe path.")
    for part in parts:
        stem = part.split(".", 1)[0].upper()
        require(stem not in {"CON", "PRN", "AUX", "NUL"}
                and re.fullmatch(r"(?:COM|LPT)[1-9]", stem) is None,
                "The manifest or ZIP contains a reserved device path.")
    return parts


def _regular_path(root, name):
    parts = _safe_path(name)
    current = root
    for index, part in enumerate(parts):
        current = current / part
        metadata = current.lstat()
        require(not _is_link(metadata), f"Refusing a symlink or reparse point in {name}.")
        require(stat.S_ISREG(metadata.st_mode) if index == len(parts) - 1 else stat.S_ISDIR(metadata.st_mode),
                f"Expected a regular file with real parent directories: {name}.")
    return current, metadata


def _signature(metadata):
    identity = (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
    # Windows Python versions can report creation time from lstat and change
    # time from fstat as st_ctime. Those two values are not comparable there.
    return identity if os.name == "nt" else identity + (metadata.st_ctime_ns,)


@contextmanager
def _open_regular(root, name, limit):
    target, before = _regular_path(root, name)
    require(before.st_size <= limit, f"File exceeds the verification size limit: {name}.")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(target, flags)
    try:
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            opened = os.fstat(stream.fileno())
            require(stat.S_ISREG(opened.st_mode) and _signature(opened) == _signature(before),
                    f"File changed while it was being opened: {name}.")
            yield stream
            _, after = _regular_path(root, name)
            require(_signature(before) == _signature(os.fstat(stream.fileno())) == _signature(after),
                    f"File changed during verification: {name}.")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_regular(root, name, limit):
    with _open_regular(root, name, limit) as stream:
        content = stream.read(limit + 1)
        require(len(content) <= limit, f"File exceeds the verification size limit: {name}.")
        return content


def _hash_stream(stream, limit, expected_size=None):
    digest = hashlib.sha256()
    length = 0
    while True:
        chunk = stream.read(min(CHUNK_BYTES, limit - length + 1))
        if not chunk:
            break
        length += len(chunk)
        require(length <= limit, "Decompressed or local content exceeds its verification size limit.")
        digest.update(chunk)
    if expected_size is not None:
        require(length == expected_size, "A file's actual size does not match its manifest size.")
    return digest.hexdigest(), length


def _checksums(content):
    try:
        text = content.decode("ascii").replace("\r\n", "\n")
    except UnicodeError as error:
        raise VerificationError("SHA256SUMS must contain plain ASCII checksum lines.") from error
    require("\r" not in text, "SHA256SUMS has invalid line endings.")
    lines = text[:-1].split("\n") if text.endswith("\n") else text.split("\n")
    require(len(lines) == 2, "SHA256SUMS must contain exactly the ZIP and external-manifest checksums.")
    checksums = {}
    versions = set()
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  (homelab-vault-gen-v(" + VERSION_PATTERN + r")\.(zip|manifest\.json))", line)
        require(match is not None, "SHA256SUMS contains an invalid, unsafe, or unsupported filename or digest.")
        digest, name, version, _ = match.groups()
        require(name not in checksums, "SHA256SUMS contains a duplicate filename.")
        checksums[name] = digest
        versions.add(version)
    require(len(versions) == 1, "SHA256SUMS must describe exactly one release version.")
    version = versions.pop()
    stem = f"{PROJECT}-v{version}"
    require(set(checksums) == {f"{stem}.zip", f"{stem}.manifest.json"},
            "SHA256SUMS must contain one ZIP and its matching external manifest.")
    return version, checksums


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "The manifest contains duplicate JSON object keys.")
        result[key] = value
    return result


def _manifest(content, selected_version, selected_commit):
    try:
        value = json.loads(content.decode("utf-8"), object_pairs_hook=_unique_object)
    except VerificationError:
        raise
    except (UnicodeError, ValueError, RecursionError) as error:
        raise VerificationError("The external manifest is not valid bounded UTF-8 JSON.") from error
    require(isinstance(value, dict) and set(value) == {"schema", "project", "version", "commit", "files"},
            "The manifest does not have the supported schema-1 structure.")
    require(type(value["schema"]) is int and value["schema"] == 1 and value["project"] == PROJECT,
            "The manifest schema or project does not match this verifier.")
    require(value["version"] == selected_version, "The manifest version does not match the selected release.")
    commit = value["commit"]
    require(isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit) is not None,
            "The manifest commit must be a full lowercase 40-character Git SHA.")
    require(selected_commit is None or commit == selected_commit,
            "The manifest commit does not match the requested commit.")
    files = value["files"]
    require(isinstance(files, list) and 1 <= len(files) < MAX_FILES,
            "The manifest file count is outside the supported limit.")
    seen = set()
    normalized = set()
    total = len(content)
    for entry in files:
        require(isinstance(entry, dict) and set(entry) == {"path", "sha256", "size", "mode"},
                "A manifest file record has an invalid structure.")
        name = entry["path"]
        _safe_path(name)
        require(name.casefold() != ARCHIVE_MANIFEST.casefold() and name.casefold() not in normalized,
                "The manifest contains a duplicate, case-colliding, or reserved manifest path.")
        seen.add(name)
        normalized.add(name.casefold())
        require(isinstance(entry["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) is not None,
                "A manifest file has an invalid SHA-256 digest.")
        require(type(entry["size"]) is int and 0 <= entry["size"] <= MAX_FILE_BYTES,
                "A manifest file size is outside the supported limit.")
        require(isinstance(entry["mode"], str) and entry["mode"] in {"0644", "0755"},
                "A manifest file has an unsupported permission mode.")
        total += entry["size"]
        require(total <= MAX_TOTAL_BYTES, "The release exceeds the total uncompressed size limit.")
    normalized.add(ARCHIVE_MANIFEST.casefold())
    for name in seen:
        parts = name.casefold().split("/")
        require(not any("/".join(parts[:index]) in normalized for index in range(1, len(parts))),
                "Manifest file paths conflict with parent-directory paths.")
    return value


def _preflight_zip(stream, size):
    # Current release ZIPs have no comment or ZIP64 records. Bound the central
    # directory before ZipFile creates one Python object for every record.
    require(size >= 22, "The release ZIP is truncated.")
    stream.seek(size - 22)
    record = stream.read(22)
    signature, disk, directory_disk, disk_count, count, directory_size, offset, comment = struct.unpack("<4s4H2LH", record)
    require(signature == b"PK\x05\x06" and comment == 0 and disk == directory_disk == 0
            and disk_count == count and count != 0xffff,
            "Unsupported ZIP footer: expected a single-disk release without ZIP64 or comments.")
    require(1 <= count <= MAX_FILES and directory_size <= MAX_DIRECTORY_BYTES,
            "The ZIP central directory exceeds its file-count or size limit.")
    require(offset + directory_size == size - 22,
            "The ZIP central directory has an invalid offset or trailing data.")
    stream.seek(offset)
    directory = stream.read(directory_size)
    position = parsed = 0
    while position < len(directory):
        require(position + 46 <= len(directory) and directory[position:position + 4] == b"PK\x01\x02",
                "The ZIP central directory has an invalid file record.")
        name_length, extra_length, comment_length = struct.unpack_from("<3H", directory, position + 28)
        position += 46 + name_length + extra_length + comment_length
        parsed += 1
        require(position <= len(directory) and parsed <= MAX_FILES,
                "The ZIP central directory has invalid lengths or exceeds the file-count limit.")
    require(position == len(directory) and parsed == count,
            "The ZIP central directory file count does not match its footer.")
    stream.seek(0)


def _verify_zip(stream, manifest, external_bytes):
    records = {entry["path"]: entry for entry in manifest["files"]}
    expected = set(records) | {ARCHIVE_MANIFEST}
    with zipfile.ZipFile(stream, "r") as archive:
        infos = archive.infolist()
        require(len(infos) == len(expected), "The ZIP has missing, extra, or duplicate file entries.")
        names = set()
        for info in infos:
            name = info.filename
            _safe_path(name)
            require(name == info.orig_filename and name not in names and name in expected,
                    "The ZIP has an unsafe, duplicate, or unexpected file entry.")
            names.add(name)
            require(not info.is_dir() and not info.flag_bits & 1
                    and info.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                    "The ZIP contains a directory, encrypted file, or unsupported compression method.")
            mode = info.external_attr >> 16
            expected_mode = int(records[name]["mode"], 8) if name in records else 0o644
            require(stat.S_ISREG(mode) and mode == stat.S_IFREG | expected_mode
                    and not info.external_attr & 0x10,
                    "The ZIP contains a symlink, special file, or mismatched permission mode.")
            expected_size = records[name]["size"] if name in records else len(external_bytes)
            require(info.file_size == expected_size and info.compress_size <= MAX_ARCHIVE_BYTES,
                    "A ZIP entry size does not match the manifest or exceeds a limit.")
        require(names == expected, "The ZIP file list does not match its manifest.")
        for name, entry in records.items():
            with archive.open(name, "r") as source:
                digest, _ = _hash_stream(source, MAX_FILE_BYTES, entry["size"])
            require(digest == entry["sha256"], f"ZIP content checksum mismatch: {name}.")
        with archive.open(ARCHIVE_MANIFEST, "r") as source:
            embedded = source.read(MAX_MANIFEST_BYTES + 1)
        require(embedded == external_bytes, "The embedded and external manifests are not byte-for-byte identical.")


def _verify_extracted(root, manifest, external_bytes):
    for entry in manifest["files"]:
        with _open_regular(root, entry["path"], MAX_FILE_BYTES) as source:
            digest, _ = _hash_stream(source, MAX_FILE_BYTES, entry["size"])
        require(digest == entry["sha256"], f"Extracted file checksum mismatch: {entry['path']}.")
    embedded = _read_regular(root, ARCHIVE_MANIFEST, MAX_MANIFEST_BYTES)
    require(embedded == external_bytes, "The extracted manifest differs from the verified external manifest.")


def verify_release(directory, version=None, commit=None, extracted=None):
    """Return verified metadata, or raise VerificationError; never modify files.

    ``extracted`` optionally checks every manifest-listed file and the embedded
    manifest in an already extracted directory. Additional user files are ignored;
    file permissions are verified in the ZIP, not on the extraction filesystem.
    """
    require(version is None or isinstance(version, str) and re.fullmatch(VERSION_PATTERN, version) is not None,
            "The requested version must use X.Y.Z without a v prefix.")
    require(commit is None or isinstance(commit, str) and re.fullmatch(r"[0-9a-fA-F]{40}", commit) is not None,
            "The requested commit must be a full 40-character Git SHA.")
    commit = commit.lower() if commit is not None else None
    try:
        root = _directory(directory, "download directory")
        selected, checksums = _checksums(_read_regular(root, "SHA256SUMS", MAX_CHECKSUM_BYTES))
        require(version is None or version == selected, "SHA256SUMS does not match the requested version.")
        stem = f"{PROJECT}-v{selected}"
        archive_name, manifest_name = stem + ".zip", stem + ".manifest.json"
        external_bytes = _read_regular(root, manifest_name, MAX_MANIFEST_BYTES)
        require(hashlib.sha256(external_bytes).hexdigest() == checksums[manifest_name],
                "External manifest checksum does not match SHA256SUMS.")
        manifest = _manifest(external_bytes, selected, commit)
        with _open_regular(root, archive_name, MAX_ARCHIVE_BYTES) as source:
            digest, size = _hash_stream(source, MAX_ARCHIVE_BYTES)
            require(digest == checksums[archive_name], "Release ZIP checksum does not match SHA256SUMS.")
            _preflight_zip(source, size)
            _verify_zip(source, manifest, external_bytes)
        if extracted is not None:
            _verify_extracted(_directory(extracted, "extracted directory"), manifest, external_bytes)
        return {"project": PROJECT, "version": manifest["version"], "commit": manifest["commit"],
                "verified_files": len(manifest["files"]), "archive": archive_name,
                "manifest": manifest_name, "extracted": extracted is not None}
    except VerificationError:
        raise
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError,
            NotImplementedError, struct.error, zlib.error, OverflowError, ValueError) as error:
        raise VerificationError("A release file is missing, unreadable, changed, or has invalid ZIP data.") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path, help="Directory containing SHA256SUMS, the ZIP, and its external manifest")
    parser.add_argument("--version", help="Expected stable X.Y.Z version")
    parser.add_argument("--commit", help="Expected full 40-character Git commit SHA")
    parser.add_argument("--extracted", type=Path, help="Also verify listed files in an already extracted directory; extra files are ignored")
    args = parser.parse_args(argv)
    try:
        result = verify_release(args.directory, args.version, args.commit, args.extracted)
    except VerificationError as error:
        print(f"Release verification failed: {error}", file=sys.stderr)
        return 1
    suffix = " and extracted files" if result["extracted"] else ""
    print(f"Verified {PROJECT} v{result['version']} at {result['commit']}: checksums, manifests, {result['verified_files']} archived files{suffix}.")
    print("This checks consistency, not authenticity. Trust the source of the verifier and downloaded checksums.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
