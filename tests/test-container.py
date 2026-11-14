#!/usr/bin/env python3
"""Exercise container publication controls without Docker, network, or writes."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("container_publisher", ROOT / "scripts/publish-container.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
COMMIT = "a" * 40
VERSION = "2.4.0"
BASE = "nginxinc/nginx-unprivileged@sha256:" + "b" * 64
DIGEST = "sha256:" + "c" * 64
INDEX = {"manifests": [{"platform": {"os": "linux", "architecture": arch}} for arch in ["amd64", "arm64"]]}


class FakeClient:
    def git_blob(self, name):
        return (ROOT / name).read_bytes()


class FakeDocker:
    def __init__(self):
        self.commands = []
        self.inspections = []
        self.existing = None
        self.published = False
        self.base = INDEX
        self.tag_manifest = INDEX

    def inspect(self, reference):
        self.inspections.append(reference)
        if reference == BASE:
            return self.base
        if self.published:
            return INDEX if "@sha256:" in reference else self.tag_manifest
        return self.existing

    def run(self, *args, timeout=60):
        self.commands.append(args)
        if args[:2] == ("buildx", "build"):
            context = Path(args[-1])
            self.dockerfile = Path(args[args.index("--file") + 1]).relative_to(context).as_posix()
            if not (context / self.dockerfile).is_file():
                raise AssertionError("Buildx must select a Dockerfile from the verified context")
            self.context_files = {str(path.relative_to(context)).replace("\\", "/") for path in context.rglob("*") if path.is_file()}
            metadata = Path(args[args.index("--metadata-file") + 1])
            metadata.write_text(json.dumps({"containerimage.digest": DIGEST}))
            self.published = "--push" in args
        return ""


class PublicationTests(unittest.TestCase):
    def invoke(self, docker=None, push=True, **overrides):
        docker = docker or FakeDocker()
        args = dict(root=ROOT, version=VERSION, commit=COMMIT, base_image=BASE,
                    push=push, client=FakeClient(), docker=docker, environ={})
        args.update(overrides)
        with patch.object(publisher, "verify_release") as verify, \
             patch.object(publisher.policy, "verify_tracked_file"):
            result = publisher.publish(**args)
            self.verifications = verify.call_count
        return result, docker

    def test_success_publishes_two_pinned_tags_without_latest(self):
        result, docker = self.invoke()
        build = docker.commands[-1]
        self.assertIn("linux/amd64,linux/arm64", build)
        self.assertIn("--push", build)
        self.assertIn(f"{publisher.IMAGE}:v{VERSION}", build)
        self.assertIn(f"{publisher.IMAGE}:sha-{COMMIT}", build)
        self.assertFalse(any(":latest" in argument for argument in build))
        self.assertEqual(docker.context_files, set(publisher.CONTEXT_FILES))
        self.assertEqual(docker.dockerfile, "deploy/Dockerfile")
        self.assertIn("public/index.html", docker.context_files)
        self.assertNotIn("index.html", docker.context_files)
        self.assertFalse(any(name.startswith(("tests/", "scripts/", "cli/")) for name in docker.context_files))
        self.assertEqual(self.verifications, 2)
        self.assertIn(f"{publisher.IMAGE}@{DIGEST}", result)

    def test_default_build_does_not_push_and_archive_is_outside_checkout(self):
        _, docker = self.invoke(push=False)
        build = docker.commands[-1]
        self.assertNotIn("--push", build)
        output = build[build.index("--output") + 1]
        self.assertEqual(Path(output.split("dest=", 1)[1]).parent, ROOT.parent)

    def test_existing_tag_is_never_replaced(self):
        docker = FakeDocker()
        docker.existing = INDEX
        with self.assertRaisesRegex(publisher.policy.PolicyError, "already exists"):
            self.invoke(docker)
        self.assertEqual(docker.commands, [])

    def test_unpinned_base_wrong_version_and_ci_context_are_refused(self):
        for overrides in [{"base_image": "nginxinc/nginx-unprivileged:latest"},
                          {"version": "2.3.0;echo"}, {"commit": "short"},
                          {"environ": {"GITHUB_ACTIONS": "true"}}]:
            docker = FakeDocker()
            with self.assertRaises(publisher.policy.PolicyError):
                self.invoke(docker, **overrides)
            self.assertEqual(docker.commands, [])

    def test_base_must_include_both_platforms(self):
        docker = FakeDocker()
        docker.base = {"manifests": INDEX["manifests"][:1]}
        with self.assertRaisesRegex(publisher.policy.PolicyError, "both"):
            self.invoke(docker)
        self.assertEqual(docker.commands, [])

    def test_failed_release_policy_stops_before_registry_actions(self):
        docker = FakeDocker()
        with patch.object(publisher, "verify_release", side_effect=publisher.policy.PolicyError("policy failure")):
            with self.assertRaisesRegex(publisher.policy.PolicyError, "policy failure"):
                publisher.publish(ROOT, VERSION, COMMIT, BASE, True, FakeClient(), docker, {})
        self.assertEqual(docker.inspections, [])
        self.assertEqual(docker.commands, [])

    def test_different_tag_after_push_is_detected(self):
        docker = FakeDocker()
        docker.tag_manifest = {"manifests": []}
        with self.assertRaisesRegex(publisher.policy.PolicyError, "does not match"):
            self.invoke(docker)

    def test_registry_auth_errors_are_not_absence(self):
        reference = f"{publisher.IMAGE}:v{VERSION}"
        for message in ["401 Unauthorized", "403 Forbidden", "connection refused", "not found", "ERROR: another/image:v1: not found"]:
            with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", message)):
                with self.assertRaises(publisher.policy.PolicyError):
                    publisher.Docker(ROOT).inspect(reference)
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", f"ERROR: {reference}: not found\n")):
            self.assertIsNone(publisher.Docker(ROOT).inspect(reference))

    def test_modified_policy_is_not_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            marker = root / "executed"
            (root / "scripts/publish-release.py").write_text(f"open({str(marker)!r}, 'w').write('unsafe')\n")
            with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"# reviewed bytes\n", b"")):
                with self.assertRaisesRegex(RuntimeError, "differs"):
                    publisher.load_policy(root)
            self.assertFalse(marker.exists())

    def test_release_gate_reuses_all_existing_policy_checks(self):
        expected = {"archive": b"fixture"}
        class ReleaseClient:
            def api(self, method, endpoint):
                if endpoint == "user":
                    return {"login": "jakubgt"}
                return {"tag_name": f"v{VERSION}", "draft": False, "prerelease": False, "immutable": True}
        with patch.object(publisher.policy, "verify_checkout") as checkout, \
             patch.object(publisher.policy, "verify_main_and_immutability") as main, \
             patch.object(publisher.policy, "verify_tag_rules") as rules, \
             patch.object(publisher.policy, "verify_ci") as ci, \
             patch.object(publisher.policy, "verify_tag") as tag, \
             patch.object(publisher.policy, "expected_artifacts", return_value=expected), \
             patch.object(publisher.policy, "verify_assets") as assets:
            client = ReleaseClient()
            publisher.verify_release(client, ROOT, VERSION, COMMIT)
            checkout.assert_called_once_with(client, COMMIT)
            main.assert_called_once_with(client, COMMIT)
            rules.assert_called_once_with(client, ROOT)
            ci.assert_called_once_with(client, COMMIT)
            tag.assert_called_once_with(client, f"v{VERSION}", COMMIT)
            self.assertEqual(assets.call_args.args[1], expected)
            self.assertTrue(assets.call_args.kwargs["complete"])

    def test_wrong_owner_is_rejected_by_release_gate(self):
        class WrongOwner:
            def api(self, *args):
                return {"login": "someone-else"}
        with patch.object(publisher.policy, "verify_checkout"), \
             patch.object(publisher.policy, "verify_main_and_immutability") as remote:
            with self.assertRaisesRegex(publisher.policy.PolicyError, "jakubgt"):
                publisher.verify_release(WrongOwner(), ROOT, VERSION, COMMIT)
            remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
