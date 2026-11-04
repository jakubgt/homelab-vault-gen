#!/usr/bin/env python3
"""Offline tests of the actual security helper; no GitHub calls or credentials."""

import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("repository_security", ROOT / "scripts/configure-repository-security.py")
security = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(security)
BASE = "repos/jakubgt/homelab-vault-gen"


class FakeGitHub:
    def __init__(self):
        self.calls = []
        self.user = {"login": "jakubgt", "type": "User"}
        self.repo = {
            "full_name": "jakubgt/homelab-vault-gen",
            "owner": {"login": "jakubgt", "type": "User"},
            "default_branch": "main", "archived": False, "permissions": {"admin": True},
        }
        self.branch = {"name": "main", "protected": True}
        self.immutable = False
        self.rules = {
            1: {"id": 1, "name": "ProtectMain", "target": "branch", "enforcement": "active",
                "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
                "bypass_actors": [], "rules": [{"type": "deletion"}],
                "source_type": "Repository", "source": security.REPOSITORY},
        }
        self.fail_endpoint = None
        self.drop_created_rule = False
        self.ignore_immutable_put = False

    @property
    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]

    def install_policy(self, policy):
        identifier = max(self.rules, default=0) + 1
        self.rules[identifier] = {
            **copy.deepcopy(policy), "id": identifier,
            "source_type": "Repository", "source": security.REPOSITORY,
        }
        return identifier

    def request(self, method, endpoint, payload=None, allowed_statuses=(200,)):
        self.calls.append((method, endpoint, copy.deepcopy(payload)))
        if endpoint == self.fail_endpoint:
            raise security.SecurityConfigurationError("Simulated inaccessible endpoint")
        if method == "GET":
            if endpoint == "user":
                return 200, copy.deepcopy(self.user)
            if endpoint == BASE:
                return 200, copy.deepcopy(self.repo)
            if endpoint == BASE + "/branches/main":
                return 200, copy.deepcopy(self.branch)
            if endpoint == BASE + "/immutable-releases":
                return (200, {"enabled": True, "enforced_by_owner": False}) if self.immutable else (404, {"message": "Not Found"})
            if endpoint.startswith(BASE + "/rulesets?"):
                page = int(endpoint.rsplit("page=", 1)[1])
                values = list(self.rules.values())[(page - 1) * 100:page * 100]
                return 200, [{"id": value["id"], "name": value["name"]} for value in values]
            if endpoint.startswith(BASE + "/rulesets/"):
                return 200, copy.deepcopy(self.rules[int(endpoint.rsplit("/", 1)[1])])
        if method == "PUT" and endpoint == BASE + "/immutable-releases":
            if not self.ignore_immutable_put:
                self.immutable = True
            return 204, None
        if method == "POST" and endpoint == BASE + "/rulesets":
            if self.drop_created_rule:
                return 201, {"id": 99}
            identifier = self.install_policy(payload)
            return 201, copy.deepcopy(self.rules[identifier])
        raise AssertionError(f"Unexpected API operation: {method} {endpoint}")


class RepositorySecurityTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeGitHub()
        self.policies = security.load_policies()

    def test_checked_in_payloads_have_exact_separate_enforcement_boundaries(self):
        creation, immutable = self.policies
        for policy in self.policies:
            self.assertEqual(policy["target"], "tag")
            self.assertEqual(policy["enforcement"], "active")
            self.assertEqual(policy["conditions"], {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}})
        self.assertEqual(creation["name"], "ReleaseTagCreationOwnerOnly")
        self.assertEqual(creation["rules"], [{"type": "creation"}])
        self.assertEqual(creation["bypass_actors"], [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}])
        self.assertEqual(immutable["name"], "ReleaseTagImmutability")
        self.assertEqual(immutable["bypass_actors"], [])
        self.assertEqual({rule["type"] for rule in immutable["rules"]}, {"update", "deletion"})
        self.assertFalse(immutable["rules"][0]["parameters"]["update_allows_fetch_and_merge"])

    def test_default_cli_is_read_only_and_reports_missing_configuration(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = security.main([], api=self.api)
        self.assertEqual(result, 2)
        self.assertEqual(self.api.writes, [])
        self.assertIn("Check only; no settings changed", output.getvalue())

    def test_apply_creates_only_missing_controls_then_verifies_them(self):
        original_main = copy.deepcopy(self.api.rules[1])
        state = security.configure(self.api, self.policies, apply=True)
        self.assertTrue(state["immutable_enabled"])
        self.assertEqual(state["missing"], [])
        self.assertEqual(len(self.api.writes), 3)
        self.assertEqual(self.api.writes[0], ("PUT", BASE + "/immutable-releases", None))
        self.assertEqual([call[2]["name"] for call in self.api.writes[1:]], ["ReleaseTagImmutability", "ReleaseTagCreationOwnerOnly"])
        self.assertEqual(self.api.rules[1], original_main)
        first_write = next(index for index, call in enumerate(self.api.calls) if call[0] != "GET")
        self.assertTrue(any("rulesets?" in call[1] for call in self.api.calls[:first_write]))
        self.assertEqual(self.api.calls[-1][0], "GET")

    def test_second_apply_is_idempotent_with_no_writes(self):
        security.configure(self.api, self.policies, apply=True)
        self.api.calls.clear()
        state = security.configure(self.api, self.policies, apply=True)
        self.assertTrue(state["immutable_enabled"])
        self.assertEqual(self.api.writes, [])

    def test_missing_one_policy_does_not_replace_existing_matching_policy(self):
        self.api.immutable = True
        identifier = self.api.install_policy(self.policies[0])
        original = copy.deepcopy(self.api.rules[identifier])
        security.configure(self.api, self.policies, apply=True)
        self.assertEqual(len(self.api.writes), 1)
        self.assertEqual(self.api.writes[0][2]["name"], "ReleaseTagImmutability")
        self.assertEqual(self.api.rules[identifier], original)

    def test_changed_same_name_rule_aborts_all_mutations_before_enabling_immutability(self):
        mutations = [
            lambda value: value.update(enforcement="disabled"),
            lambda value: value["bypass_actors"].append({"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}),
            lambda value: value["conditions"]["ref_name"]["exclude"].append("refs/tags/v2.*"),
            lambda value: value["rules"].pop(),
            lambda value: value["rules"][0]["parameters"].update(update_allows_fetch_and_merge=True),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                api = FakeGitHub()
                identifier = api.install_policy(self.policies[1])
                mutate(api.rules[identifier])
                with self.assertRaises(security.SecurityConfigurationError):
                    security.configure(api, self.policies, apply=True)
                self.assertEqual(api.writes, [])

    def test_identity_branch_and_permissions_preflight_fail_closed(self):
        mutations = [
            lambda api: api.user.update(login="another-user"),
            lambda api: api.user.update(type="Bot"),
            lambda api: api.repo.update(full_name="jakubgt/another-repo"),
            lambda api: api.repo["owner"].update(login="another-owner"),
            lambda api: api.repo["owner"].update(type="Organization"),
            lambda api: api.repo.update(default_branch="other"),
            lambda api: api.repo.update(archived=True),
            lambda api: api.repo["permissions"].update(admin=False),
            lambda api: api.branch.update(protected=False),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                api = FakeGitHub()
                mutate(api)
                with self.assertRaises(security.SecurityConfigurationError):
                    security.configure(api, self.policies, apply=True)
                self.assertEqual(api.writes, [])

    def test_inaccessible_preflight_state_never_causes_partial_configuration(self):
        self.api.install_policy(self.policies[0])
        self.api.fail_endpoint = BASE + "/rulesets/2"
        with self.assertRaises(security.SecurityConfigurationError):
            security.configure(self.api, self.policies, apply=True)
        self.assertEqual(self.api.writes, [])

    def test_duplicate_names_and_redacted_bypass_details_are_not_assumed_safe(self):
        self.api.install_policy(self.policies[0])
        self.api.install_policy(self.policies[0])
        with self.assertRaises(security.SecurityConfigurationError):
            security.configure(self.api, self.policies, apply=True)
        self.assertEqual(self.api.writes, [])
        del self.api.rules[3]
        del self.api.rules[2]["bypass_actors"]
        with self.assertRaises(security.SecurityConfigurationError):
            security.configure(self.api, self.policies, apply=True)
        self.assertEqual(self.api.writes, [])

    def test_ruleset_pagination_finds_matching_policy_after_first_page(self):
        for index in range(2, 101):
            self.api.rules[index] = {"id": index, "name": f"Unrelated {index}"}
        for policy in self.policies:
            self.api.install_policy(policy)
        self.api.immutable = True
        state = security.configure(self.api, self.policies)
        self.assertEqual(state["missing"], [])
        self.assertTrue(any(call[1].endswith("page=2") for call in self.api.calls))
        self.assertEqual(self.api.writes, [])

    def test_verification_detects_missing_rule_and_does_not_undo_enabled_protection(self):
        self.api.drop_created_rule = True
        with self.assertRaisesRegex(security.SecurityConfigurationError, "Post-apply verification"):
            security.configure(self.api, self.policies, apply=True)
        self.assertTrue(self.api.immutable)
        self.assertFalse(any(call[0] in ("DELETE", "PATCH") for call in self.api.calls))

    def test_verification_detects_immutable_setting_that_did_not_take_effect(self):
        self.api.ignore_immutable_put = True
        with self.assertRaisesRegex(security.SecurityConfigurationError, "Post-apply verification"):
            security.configure(self.api, self.policies, apply=True)

    def test_pure_validator_accepts_order_and_default_parameter_variations_only(self):
        actual = copy.deepcopy(self.policies[1])
        actual["rules"].reverse()
        actual["rules"][1].pop("parameters")
        actual["id"] = 123
        original = copy.deepcopy(actual)
        self.assertTrue(security.ruleset_matches(actual, self.policies[1]))
        self.assertEqual(actual, original)
        actual["conditions"]["ref_name"]["exclude"] = ["refs/tags/v1.*"]
        self.assertFalse(security.ruleset_matches(actual, self.policies[1]))
        self.assertFalse(security.ruleset_matches({}, self.policies[1]))

    def test_changed_local_payload_is_rejected_before_api_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for filename, policy in zip(security.POLICY_FILES, self.policies):
                (directory / filename).write_text(json.dumps(policy), encoding="utf-8")
            changed = copy.deepcopy(self.policies[0])
            changed["bypass_actors"].append({"actor_id": 999, "actor_type": "Integration", "bypass_mode": "always"})
            (directory / security.POLICY_FILES[0]).write_text(json.dumps(changed), encoding="utf-8")
            with self.assertRaises(security.SecurityConfigurationError):
                security.load_policies(directory)

    def test_gh_invocation_uses_fixed_host_stdin_no_shell_and_no_debug_credentials(self):
        response = subprocess.CompletedProcess([], 0, 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"id": 12}\n', '')
        with patch.object(security.subprocess, "run", return_value=response) as runner:
            status, body = security.GitHubAPI().request("POST", BASE + "/rulesets", self.policies[0], (201,))
        self.assertEqual((status, body), (201, {"id": 12}))
        args, kwargs = runner.call_args
        self.assertEqual(args[0][:6], ["gh", "api", "--hostname", "github.com", "--include", "--method"])
        self.assertIn("--input", args[0])
        self.assertEqual(json.loads(kwargs["input"]), self.policies[0])
        self.assertIs(kwargs["shell"], False)
        self.assertNotIn("GH_DEBUG", kwargs["env"])
        self.assertEqual(kwargs["env"]["GH_PROMPT_DISABLED"], "1")

    def test_gh_handles_disabled_immutability_and_no_content_put(self):
        responses = [
            subprocess.CompletedProcess([], 1, 'HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}', ''),
            subprocess.CompletedProcess([], 0, 'HTTP/2.0 204 No Content\n\n', ''),
        ]
        with patch.object(security.subprocess, "run", side_effect=responses):
            api = security.GitHubAPI()
            self.assertEqual(api.request("GET", BASE + "/immutable-releases", allowed_statuses=(200, 404))[0], 404)
            self.assertEqual(api.request("PUT", BASE + "/immutable-releases", allowed_statuses=(204,)), (204, None))

    def test_api_errors_never_echo_raw_output_or_credentials(self):
        marker = "credential-must-not-appear"
        for stdout, returncode in [("not-http " + marker, 1), ('HTTP/2.0 403 Forbidden\n\n' + marker, 1), ('HTTP/2.0 200 OK\n\n' + marker, 0)]:
            with self.subTest(stdout=stdout):
                response = subprocess.CompletedProcess([], returncode, stdout, marker)
                with patch.object(security.subprocess, "run", return_value=response):
                    with self.assertRaises(security.SecurityConfigurationError) as caught:
                        security.GitHubAPI().request("GET", BASE)
                self.assertNotIn(marker, str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
