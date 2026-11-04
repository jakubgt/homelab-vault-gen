#!/usr/bin/env python3
"""Behavioral release-policy tests using an in-memory GitHub API; never publish."""

import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("publisher", ROOT / "scripts/publish-release.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
VERSION = "2.2.1"
COMMIT = "a" * 40
OTHER = "b" * 40
TAG = "v" + VERSION
PREFIX = "repos/" + publisher.REPOSITORY


def asset(name, content):
    return {"name": name, "size": len(content), "state": "uploaded",
            "digest": "sha256:" + hashlib.sha256(content).hexdigest()}


class FakeClient:
    def __init__(self, expected):
        self.expected = expected
        self.calls = []
        self.mutations = []
        self.branch = "main"
        self.local_sha = COMMIT
        self.dirty = ""
        self.origin = f"https://github.com/{publisher.REPOSITORY}.git"
        self.user = "jakubgt"
        self.protected = True
        self.main_sha = COMMIT
        self.immutable = True
        self.immutable_status = None
        self.tag_sha = None
        self.tag_status = None
        self.release = None
        self.after_upload = None
        self.rules = []
        for index, filename in enumerate(["release-tag-creation.json", "release-tag-immutability.json"], 1):
            policy = json.loads((ROOT / ".github/security" / filename).read_text())
            self.rules.append({**policy, "id": index, "source_type": "Repository", "source": publisher.REPOSITORY})
        self.runs = [{"id": 10, "head_sha": COMMIT, "head_branch": "main", "path": ".github/workflows/tests.yml",
                      "event": "push", "status": "completed", "conclusion": "success", "created_at": "2026-11-03T12:00:00Z"}]
        self.jobs = [{"name": "core (22)", "conclusion": "success"}, {"name": "test", "conclusion": "success"}]

    def git(self, *args):
        return {("branch", "--show-current"): self.branch, ("rev-parse", "HEAD"): self.local_sha,
                ("status", "--porcelain", "--untracked-files=all"): self.dirty,
                ("remote", "get-url", "origin"): self.origin}[args]

    def git_blob(self, relative_path):
        return (ROOT / relative_path).read_bytes()

    def api(self, method, endpoint, payload=None):
        self.calls.append((method, endpoint, payload))
        if method != "GET":
            self.mutations.append((method, endpoint, payload))
        if method == "GET":
            if endpoint == "user":
                return {"login": self.user}
            if endpoint == PREFIX:
                return {"full_name": publisher.REPOSITORY, "default_branch": "main", "permissions": {"admin": True}}
            if endpoint.endswith("/branches/main"):
                return {"protected": self.protected, "commit": {"sha": self.main_sha}}
            if endpoint.endswith("/immutable-releases"):
                if self.immutable_status:
                    raise publisher.GitHubError(self.immutable_status, "immutability")
                return {"enabled": self.immutable}
            if "/rulesets?" in endpoint:
                return copy.deepcopy(self.rules)
            if "/rulesets/" in endpoint:
                return copy.deepcopy(next(rule for rule in self.rules if str(rule["id"]) == endpoint.rsplit("/", 1)[1]))
            if "/actions/runs?" in endpoint:
                return {"workflow_runs": copy.deepcopy(self.runs)}
            if "/jobs?" in endpoint:
                return {"jobs": copy.deepcopy(self.jobs)}
            if "/git/ref/tags/" in endpoint:
                if self.tag_status or self.tag_sha is None:
                    raise publisher.GitHubError(self.tag_status or 404, "tag")
                return {"object": {"type": "commit", "sha": self.tag_sha}}
            if "/releases?" in endpoint:
                return [copy.deepcopy(self.release)] if self.release else []
            if "/releases/" in endpoint:
                return copy.deepcopy(self.release)
        if method == "POST" and endpoint.endswith("/git/refs"):
            self.tag_sha = payload["sha"]
            return {"object": {"sha": self.tag_sha, "type": "commit"}}
        if method == "POST" and endpoint.endswith("/releases"):
            self.release = {**payload, "id": 123, "author": {"login": self.user}, "assets": [], "immutable": False}
            return copy.deepcopy(self.release)
        if method == "PATCH" and endpoint.endswith("/releases/123"):
            self.release.update({"draft": False, "immutable": self.immutable})
            return copy.deepcopy(self.release)
        raise AssertionError(f"Unexpected API operation: {method} {endpoint}")

    def upload(self, tag, paths):
        self.mutations.append(("UPLOAD", tag, [path.name for path in paths]))
        self.release["assets"].extend(asset(path.name, path.read_bytes()) for path in paths)
        if self.after_upload:
            self.after_upload(self)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.artifacts = Path(self.temporary.name)
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, "w") as archive:
            archive.writestr("CHANGELOG.md", "Reviewed release notes\n")
        self.expected = {f"homelab-vault-gen-{TAG}.zip": zipped.getvalue(),
                         f"homelab-vault-gen-{TAG}.manifest.json": b'{"version":"2.2.1"}\n', "SHA256SUMS": b"verified sums\n"}
        for name, content in self.expected.items():
            (self.artifacts / name).write_bytes(content)
        self.client = FakeClient(self.expected)

    def publish(self, **kwargs):
        return publisher.publish(ROOT, VERSION, COMMIT, self.artifacts, client=self.client,
                                 build=lambda *_: self.expected, environ={}, **kwargs)

    def draft(self, **changes):
        return {"id": 123, "tag_name": TAG, "target_commitish": COMMIT, "draft": True, "immutable": False,
                "author": {"login": "jakubgt"}, "assets": [], **changes}

    def test_valid_release_is_drafted_uploaded_then_published_immutable(self):
        result = self.publish()
        self.assertIn("Published and verified immutable", result)
        self.assertEqual([call[0] for call in self.client.mutations], ["POST", "POST", "UPLOAD", "PATCH"])
        self.assertEqual(self.client.mutations[0][2], {"ref": f"refs/tags/{TAG}", "sha": COMMIT})
        self.assertTrue(self.client.mutations[1][2]["draft"])
        self.assertEqual(self.client.mutations[1][2]["target_commitish"], COMMIT)
        self.assertTrue(self.client.release["immutable"])
        self.assertEqual(len([call for call in self.client.calls if call[1].endswith("immutable-releases")]), 3)

    def test_invalid_trust_inputs_stop_before_any_mutation(self):
        for key, value in [("branch", "attacker-branch"), ("local_sha", OTHER), ("dirty", " M app.js"),
                           ("origin", "https://github.com/attacker/fork.git"), ("user", "collaborator"),
                           ("protected", False), ("main_sha", OTHER), ("immutable", False),
                           ("immutable_status", 403), ("immutable_status", 404), ("tag_sha", OTHER), ("tag_status", 403)]:
            with self.subTest(key=key, value=value):
                self.client = FakeClient(self.expected)
                setattr(self.client, key, value)
                with self.assertRaises(publisher.PolicyError):
                    self.publish()
                self.assertEqual(self.client.mutations, [])

    def test_missing_or_weakened_tag_protections_stop_before_mutation(self):
        for change in [lambda rules: rules.clear(), lambda rules: rules[0].update(enforcement="disabled"),
                       lambda rules: rules[1]["bypass_actors"].append({"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always"}),
                       lambda rules: rules[1].pop("bypass_actors"), lambda rules: rules[0].update(source="another/repo")]:
            self.client = FakeClient(self.expected)
            change(self.client.rules)
            with self.assertRaises(publisher.PolicyError):
                self.publish()
            self.assertEqual(self.client.mutations, [])

    def test_missing_failed_pending_or_unrelated_ci_is_rejected(self):
        for change in [lambda client: client.runs.clear(), lambda client: client.runs[0].update(conclusion="failure"),
                       lambda client: client.runs[0].update(status="in_progress"), lambda client: client.runs[0].update(head_sha=OTHER),
                       lambda client: client.runs[0].update(event="pull_request"), lambda client: client.runs[0].update(path=".github/workflows/pretend.yml"),
                       lambda client: client.jobs[0].update(conclusion="failure"), lambda client: client.jobs.pop()]:
            self.client = FakeClient(self.expected)
            change(self.client)
            with self.assertRaises(publisher.PolicyError):
                self.publish()
            self.assertEqual(self.client.mutations, [])

    def test_latest_failed_ci_wins_over_an_older_success(self):
        self.client.runs.append({**self.client.runs[0], "id": 11, "created_at": "2026-11-03T13:00:00Z", "conclusion": "failure"})
        with self.assertRaises(publisher.PolicyError):
            self.publish()
        self.assertEqual(self.client.mutations, [])

    def test_tampered_or_extra_artifacts_are_rejected_before_mutation(self):
        path = self.artifacts / "SHA256SUMS"
        path.write_bytes(b"tampered sums!\n")
        with self.assertRaises(publisher.PolicyError):
            self.publish()
        self.assertEqual(self.client.mutations, [])
        path.write_bytes(self.expected["SHA256SUMS"])
        (self.artifacts / "unexpected.exe").write_bytes(b"extra")
        with self.assertRaises(publisher.PolicyError):
            self.publish()
        self.assertEqual(self.client.mutations, [])

    def test_only_matching_owner_drafts_can_resume_without_clobber(self):
        self.client.tag_sha = COMMIT
        name, content = next(iter(self.expected.items()))
        self.client.release = self.draft(assets=[asset(name, content)])
        self.publish()
        self.assertEqual([call[0] for call in self.client.mutations], ["UPLOAD", "PATCH"])
        self.assertNotIn(name, self.client.mutations[0][2])
        for changes in [{"target_commitish": OTHER}, {"author": {"login": "other"}}, {"assets": [asset("unexpected", b"x")]}]:
            self.client = FakeClient(self.expected)
            self.client.release = self.draft(**changes)
            with self.assertRaises(publisher.PolicyError):
                self.publish()
            self.assertEqual(self.client.mutations, [])

    def test_published_release_is_never_modified(self):
        self.client.tag_sha = COMMIT
        self.client.release = self.draft(draft=False, immutable=True,
                                         assets=[asset(name, content) for name, content in self.expected.items()])
        self.assertIn("nothing changed", self.publish())
        self.assertEqual(self.client.mutations, [])
        self.client.release["immutable"] = False
        with self.assertRaisesRegex(publisher.PolicyError, "leaving it unchanged"):
            self.publish()
        self.assertEqual(self.client.mutations, [])

    def test_tag_or_main_race_and_disabled_immutability_prevent_publication(self):
        for change in [lambda client: setattr(client, "tag_sha", OTHER), lambda client: setattr(client, "main_sha", OTHER),
                       lambda client: setattr(client, "immutable", False),
                       lambda client: client.release["assets"][0].update(digest="sha256:" + "0" * 64)]:
            self.client = FakeClient(self.expected)
            self.client.after_upload = change
            with self.assertRaises(publisher.PolicyError):
                self.publish()
            self.assertNotIn("PATCH", [call[0] for call in self.client.mutations])
            self.assertTrue(self.client.release["draft"])

    def test_ci_execution_is_rejected_without_touching_github(self):
        with self.assertRaisesRegex(publisher.PolicyError, "not a CI job"):
            publisher.publish(ROOT, VERSION, COMMIT, self.artifacts, client=self.client, environ={"GITHUB_ACTIONS": "true"})
        self.assertEqual(self.client.calls, [])

    def test_modified_helper_cannot_execute_even_if_git_status_claims_clean(self):
        with patch.object(self.client, "git_blob", return_value=b"different tracked source"):
            with self.assertRaisesRegex(publisher.PolicyError, "differs from the trusted commit"):
                self.publish()
        self.assertEqual(self.client.mutations, [])

    def test_upload_forces_github_host_and_never_clobbers(self):
        response = subprocess.CompletedProcess([], 0, '', '')
        with patch.dict(publisher.os.environ, {"GH_HOST": "unexpected.example", "GH_DEBUG": "api"}), \
                patch.object(publisher.subprocess, "run", return_value=response) as run:
            publisher.Client(ROOT).upload(TAG, [self.artifacts / "SHA256SUMS"])
        command = run.call_args.args[0]
        self.assertNotIn("--clobber", command)
        self.assertEqual(run.call_args.kwargs["env"]["GH_HOST"], "github.com")
        self.assertNotIn("GH_DEBUG", run.call_args.kwargs["env"])

    def test_annotated_tags_are_peeled_and_malformed_refs_are_rejected(self):
        class Annotated:
            def api(self, method, endpoint):
                if "/git/ref/" in endpoint:
                    return {"object": {"type": "tag", "sha": OTHER}}
                return {"object": {"type": "commit", "sha": COMMIT}}
        self.assertEqual(publisher.tag_commit(Annotated(), TAG), COMMIT)
        for value in [{"type": "commit"}, {"type": "commit", "sha": "short"}, {"type": "tree", "sha": COMMIT}]:
            with self.subTest(value=value), patch.object(self.client, "api", return_value={"object": value}):
                with self.assertRaises(publisher.PolicyError):
                    publisher.tag_commit(self.client, TAG)

    def test_api_distinguishes_404_from_authorization_and_invalid_responses(self):
        client = publisher.Client(ROOT)
        for status in [403, 404, 500]:
            response = subprocess.CompletedProcess([], 1, f'HTTP/2.0 {status} Error\r\nContent-Type: application/json\r\n\r\n{{"message":"error"}}', '')
            with patch.object(publisher.subprocess, "run", return_value=response):
                with self.assertRaises(publisher.GitHubError) as caught:
                    client.api("GET", "repos/example/repo")
                self.assertEqual(caught.exception.status, status)
        response = subprocess.CompletedProcess([], 0, 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"enabled":true}', '')
        with patch.object(publisher.subprocess, "run", return_value=response):
            self.assertEqual(client.api("GET", "repos/example/repo"), {"enabled": True})

    def test_release_workflow_has_no_tag_trigger_or_publishing_authority(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertNotRegex(workflow, r"(?m)^\s*tags:\s*")
        self.assertNotRegex(workflow, r"(?m)^\s*contents:\s*write\s*$")
        self.assertNotIn("gh release", workflow)
        self.assertNotIn("publish-release.py", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertIn('test "$GITHUB_REF" = refs/heads/main', workflow)
        self.assertIn('test "$GITHUB_REF_PROTECTED" = true', workflow)
        self.assertIn("needs: [gate, validate]", workflow)
        self.assertIn("persist-credentials: false", workflow)


if __name__ == "__main__":
    unittest.main()
