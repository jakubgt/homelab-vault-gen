#!/usr/bin/env python3
"""Publish verified immutable releases locally, using the owner's GitHub CLI login."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


REPOSITORY = "jakubgt/homelab-vault-gen"
ROOT = Path(__file__).resolve().parents[1]
API_VERSION = "2026-03-10"
VERSION_PATTERN = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


class PolicyError(RuntimeError):
    pass


class GitHubError(PolicyError):
    def __init__(self, status, operation):
        self.status = status
        super().__init__(f"GitHub {operation} failed (HTTP {status or 'unknown'}); no absence was assumed.")


class Client:
    def __init__(self, root):
        self.root = Path(root)

    def git(self, *args):
        result = subprocess.run(["git", *args], cwd=self.root, capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise PolicyError(f"Git verification failed: {' '.join(args[:2])}")
        return result.stdout.strip()

    def git_blob(self, relative_path):
        result = subprocess.run(["git", "--no-replace-objects", "show", f"HEAD:{relative_path}"],
                                cwd=self.root, capture_output=True, timeout=30)
        if result.returncode:
            raise PolicyError(f"The trusted commit is missing {relative_path}.")
        return result.stdout

    def api(self, method, endpoint, payload=None):
        command = ["gh", "api", "--hostname", "github.com", "--include", "--method", method,
                   "-H", "Accept: application/vnd.github+json", "-H", f"X-GitHub-Api-Version: {API_VERSION}", endpoint]
        if payload is not None:
            command.extend(["--input", "-"])
        environment = os.environ.copy()
        environment.pop("GH_DEBUG", None)
        environment["GH_HOST"] = "github.com"
        environment["GH_PROMPT_DISABLED"] = "1"
        result = subprocess.run(command, cwd=self.root, input=json.dumps(payload) if payload is not None else None,
                                capture_output=True, text=True, encoding="utf-8", timeout=60, env=environment)
        response_text = result.stdout.replace("\r\n", "\n")
        headers = list(re.finditer(r"(?m)^HTTP/\S+\s+(\d{3})[^\n]*\n", response_text))
        status = int(headers[-1].group(1)) if headers else None
        if result.returncode or status is None or not 200 <= status < 300:
            raise GitHubError(status, f"{method} {endpoint}")
        response = response_text[headers[-1].end():].split("\n\n", 1)
        if len(response) != 2:
            raise PolicyError("GitHub returned an unreadable response; refusing publication.")
        return json.loads(response[1]) if response[1].strip() else None

    def upload(self, tag, paths):
        environment = os.environ.copy()
        environment.pop("GH_DEBUG", None)
        environment["GH_HOST"] = "github.com"
        environment["GH_PROMPT_DISABLED"] = "1"
        result = subprocess.run(["gh", "release", "upload", tag, *map(str, paths), "--repo", REPOSITORY],
                                cwd=self.root, capture_output=True, text=True, timeout=180, env=environment)
        if result.returncode:
            raise PolicyError("Asset upload failed. Existing assets were not overwritten; inspect the draft before retrying.")


def require(condition, message):
    if not condition:
        raise PolicyError(message)


def verify_tracked_file(client, root, relative_path, binary=False):
    path = root / relative_path
    require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root),
            f"Unsafe or missing source file: {relative_path}")
    actual = path.read_bytes()
    expected = client.git_blob(relative_path)
    if not binary:
        actual = actual.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        expected = expected.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    require(actual == expected, f"Source file {relative_path} differs from the trusted commit, even if git status hides it.")


def verify_checkout(client, commit):
    require(client.git("branch", "--show-current") == "main", "Check out main before publishing.")
    require(client.git("rev-parse", "HEAD") == commit, "The checkout does not match the requested full commit SHA.")
    require(not client.git("status", "--porcelain", "--untracked-files=all"), "The checkout must be clean, including untracked source files.")
    origin = client.git("remote", "get-url", "origin")
    allowed = {f"https://github.com/{REPOSITORY}", f"https://github.com/{REPOSITORY}.git",
               f"git@github.com:{REPOSITORY}.git", f"ssh://git@github.com/{REPOSITORY}.git"}
    require(origin in allowed, "origin must point directly to the intended GitHub repository.")


def verify_main_and_immutability(client, commit):
    repository = client.api("GET", f"repos/{REPOSITORY}")
    require(repository.get("full_name") == REPOSITORY and repository.get("default_branch") == "main",
            "The repository identity or default branch does not match the release policy.")
    require(repository.get("permissions", {}).get("admin") is True, "Repository administrator access is required.")
    branch = client.api("GET", f"repos/{REPOSITORY}/branches/main")
    require(branch.get("protected") is True, "main must be protected before publishing.")
    require(branch.get("commit", {}).get("sha") == commit, "main has moved; review and build its current commit before publishing.")
    # Administration:read is required. Disabled, unauthorized, and unreadable
    # responses must all fail before a draft can become public.
    immutable = client.api("GET", f"repos/{REPOSITORY}/immutable-releases")
    require(isinstance(immutable, dict) and immutable.get("enabled") is True,
            "Enable immutable releases in repository settings before publishing.")


def list_pages(client, endpoint, collection=None):
    results = []
    for page in range(1, 101):
        separator = "&" if "?" in endpoint else "?"
        response = client.api("GET", f"{endpoint}{separator}per_page=100&page={page}")
        values = response.get(collection) if collection else response
        require(isinstance(values, list), "GitHub returned an unreadable collection.")
        results.extend(values)
        if len(values) < 100:
            return results
    raise PolicyError("The GitHub collection exceeded the verification limit.")


def verify_ci(client, commit):
    runs = list_pages(client, f"repos/{REPOSITORY}/actions/runs?head_sha={commit}", "workflow_runs")
    matching = [run for run in runs if run.get("head_sha") == commit and run.get("head_branch") == "main"
                and run.get("path") == ".github/workflows/tests.yml"
                and run.get("event") in {"push", "workflow_dispatch"}]
    require(bool(matching), "No main-branch tests workflow exists for this commit.")
    latest = max(matching, key=lambda run: (run.get("created_at", ""), run.get("id", 0)))
    require(latest.get("status") == "completed" and latest.get("conclusion") == "success",
            "The latest main-branch tests workflow for this commit must finish successfully.")
    jobs = list_pages(client, f"repos/{REPOSITORY}/actions/runs/{latest['id']}/jobs?filter=latest", "jobs")
    require(bool(jobs) and all(job.get("conclusion") == "success" for job in jobs)
            and any(job.get("name") == "test" for job in jobs),
            "Every CI job and the aggregate test gate must pass before publication.")


def verify_tag_rules(client, root):
    sys.dont_write_bytecode = True
    verify_tracked_file(client, root, "scripts/configure-repository-security.py")
    spec = importlib.util.spec_from_file_location("vault_security_policy", root / "scripts/configure-repository-security.py")
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    for filename in policy.POLICY_FILES:
        verify_tracked_file(client, root, f".github/security/{filename}")
    rulesets = list_pages(client, f"repos/{REPOSITORY}/rulesets?includes_parents=true")
    try:
        expected_rulesets = policy.load_policies()
    except policy.SecurityConfigurationError as error:
        raise PolicyError(f"The checked-in release policy is invalid: {error}") from None
    for expected in expected_rulesets:
        matches = [rule for rule in rulesets if rule.get("name") == expected["name"]]
        require(len(matches) == 1, f"Exactly one {expected['name']} ruleset must be configured.")
        actual = client.api("GET", f"repos/{REPOSITORY}/rulesets/{matches[0]['id']}")
        require(actual.get("source_type") == "Repository" and actual.get("source") == REPOSITORY
                and "bypass_actors" in actual and policy.ruleset_matches(actual, expected),
                f"Ruleset {expected['name']} does not match the reviewed release policy.")


def expected_artifacts(root, version, commit):
    # Load the builder only after checkout and remote policy checks. This is a
    # local owner command; no write token executes repository code in CI.
    sys.dont_write_bytecode = True
    client = Client(root)
    verify_tracked_file(client, root, "scripts/build-release.py")
    spec = importlib.util.spec_from_file_location("vault_release_builder", root / "scripts/build-release.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    for name in (*builder.RELEASE_FILES, "package.json"):
        verify_tracked_file(client, root, name, binary=name in builder.BINARY_FILES)
    with tempfile.TemporaryDirectory(prefix="vault-release-verify-") as temporary:
        paths = builder.build_release(root, version, commit, Path(temporary) / "artifacts")
        return {path.name: path.read_bytes() for path in paths}


def verify_artifacts(root, version, commit, artifacts, build=expected_artifacts):
    expected = build(root, version, commit)
    artifacts = Path(artifacts).resolve()
    require(artifacts.is_dir(), "Build or download the verified main-commit artifacts first.")
    require({entry.name for entry in artifacts.iterdir()} == set(expected), "The artifact directory must contain exactly the three release files.")
    for name, content in expected.items():
        path = artifacts / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == len(content)
                and path.read_bytes() == content, f"Artifact {name} does not reproduce the clean main checkout.")
    return expected


def tag_commit(client, tag):
    try:
        value = client.api("GET", f"repos/{REPOSITORY}/git/ref/tags/{tag}")["object"]
    except GitHubError as error:
        if error.status == 404:
            return None
        raise
    for _ in range(8):
        require(isinstance(value, dict) and isinstance(value.get("sha"), str)
                and re.fullmatch(r"[0-9a-f]{40}", value["sha"]) is not None,
                "The release tag response is malformed; absence cannot be assumed.")
        if value.get("type") == "commit":
            return value.get("sha")
        require(value.get("type") == "tag", "Release tag does not resolve to a commit.")
        value = client.api("GET", f"repos/{REPOSITORY}/git/tags/{value['sha']}")["object"]
    raise PolicyError("Release tag nesting exceeds the verification limit.")


def verify_tag(client, tag, commit, allow_absent=False):
    actual = tag_commit(client, tag)
    require(actual == commit or (allow_absent and actual is None), f"Tag {tag} must resolve to the exact verified commit.")
    return actual


def verify_assets(release, expected, complete):
    seen = set()
    for asset in release.get("assets", []):
        name = asset.get("name")
        require(name in expected and name not in seen, "Unexpected or duplicate remote assets; nothing was overwritten.")
        content = expected[name]
        require(asset.get("state") == "uploaded" and asset.get("size") == len(content)
                and asset.get("digest") == "sha256:" + hashlib.sha256(content).hexdigest(),
                f"Remote asset {name} does not match the locally verified artifact.")
        seen.add(name)
    if complete:
        require(seen == set(expected), "The release asset set is incomplete.")
    return seen


def publish(root, version, commit, artifacts, client=None, build=expected_artifacts, environ=None):
    environ = os.environ if environ is None else environ
    require(environ.get("GITHUB_ACTIONS", "").lower() != "true", "Publication is an owner-only local command, not a CI job.")
    require(re.fullmatch(VERSION_PATTERN, version) is not None, "Use a stable X.Y.Z version without a v prefix.")
    require(re.fullmatch(r"[0-9a-fA-F]{40}", commit) is not None, "A full 40-character commit SHA is required.")
    commit = commit.lower()
    root = Path(root).resolve()
    client = client or Client(root)
    verify_checkout(client, commit)
    user = client.api("GET", "user")
    require(user.get("login") == REPOSITORY.split("/")[0], "Authenticate gh as the repository owner before publishing.")
    verify_main_and_immutability(client, commit)
    verify_tag_rules(client, root)
    verify_ci(client, commit)
    expected = verify_artifacts(root, version, commit, artifacts, build)
    tag = f"v{version}"
    actual_tag = verify_tag(client, tag, commit, allow_absent=True)
    releases = [entry for entry in list_pages(client, f"repos/{REPOSITORY}/releases") if entry.get("tag_name") == tag]
    require(len(releases) <= 1, "Multiple releases claim this tag; resolve them manually.")
    release = releases[0] if releases else None
    if release and not release.get("draft"):
        require(release.get("immutable") is True, "This release is already published and mutable; leaving it unchanged.")
        require(actual_tag == commit, "The published release tag must exist at the verified commit.")
        verify_assets(release, expected, complete=True)
        return f"Verified existing immutable release {tag}; nothing changed."
    if release:
        require(release.get("draft") is True and release.get("target_commitish") == commit
                and release.get("author", {}).get("login") == user["login"],
                "Only an owner-created draft targeting this exact SHA may be resumed.")
        verify_assets(release, expected, complete=False)

    # Everything above is read-only. Repeat live checks before the first mutation
    # and immediately before turning the draft into a public release.
    verify_checkout(client, commit)
    verify_main_and_immutability(client, commit)
    verify_tag_rules(client, root)
    actual_tag = verify_tag(client, tag, commit, allow_absent=True)
    if actual_tag is None:
        client.api("POST", f"repos/{REPOSITORY}/git/refs", {"ref": f"refs/tags/{tag}", "sha": commit})
    verify_tag(client, tag, commit)
    if release is None:
        with zipfile.ZipFile(Path(artifacts) / f"homelab-vault-gen-{tag}.zip") as archive:
            notes = archive.read("docs/CHANGELOG.md").decode("utf-8")
        release = client.api("POST", f"repos/{REPOSITORY}/releases", {
            "tag_name": tag, "target_commitish": commit, "name": f"Homelab Vault {tag}",
            "body": notes, "draft": True, "prerelease": False,
        })
    release_id = release["id"]
    current = client.api("GET", f"repos/{REPOSITORY}/releases/{release_id}")
    require(current.get("draft") is True and current.get("tag_name") == tag and current.get("target_commitish") == commit,
            "The draft changed while preparing publication; inspect it before retrying.")
    uploaded = verify_assets(current, expected, complete=False)
    missing = sorted(set(expected) - uploaded)
    verify_tag(client, tag, commit)
    if missing:
        client.upload(tag, [Path(artifacts) / name for name in missing])
    current = client.api("GET", f"repos/{REPOSITORY}/releases/{release_id}")
    require(current.get("draft") is True and current.get("tag_name") == tag and current.get("target_commitish") == commit,
            "The draft changed during upload; refusing publication.")
    verify_assets(current, expected, complete=True)
    verify_checkout(client, commit)
    verify_main_and_immutability(client, commit)
    verify_tag_rules(client, root)
    verify_ci(client, commit)
    verify_tag(client, tag, commit)
    result = client.api("PATCH", f"repos/{REPOSITORY}/releases/{release_id}", {"draft": False, "make_latest": "true"})
    require(result.get("draft") is False and result.get("immutable") is True,
            "Publication did not return an immutable release. Inspect GitHub immediately; do not replace its assets.")
    verify_tag(client, tag, commit)
    verify_assets(result, expected, complete=True)
    return f"Published and verified immutable release: https://github.com/{REPOSITORY}/releases/tag/{tag}"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True, help="Full SHA of the current protected main commit")
    parser.add_argument("--artifacts", required=True, type=Path, help="Directory containing the three verified release files")
    args = parser.parse_args(argv)
    try:
        print(publish(ROOT, args.version, args.commit, args.artifacts))
    except (PolicyError, OSError, ValueError, KeyError, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        print(f"Release publication stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
