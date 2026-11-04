#!/usr/bin/env python3
"""Check repository release protections; --apply explicitly enables missing ones.

Uses the existing gh login for github.com; never creates or prints credentials.
Exit status: 0 verified, 2 missing protections in check mode, 1 unsafe/API failure.
An interrupted apply can leave some protections enabled. Re-run --check, review
the result, then --apply; this helper never rolls protections back.

REST schema: https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
Immutable releases: https://docs.github.com/en/rest/repos/repos#enable-immutable-releases
Admin role 5 is corroborated by GitHub's Safe Settings implementation:
https://github.com/github-community-projects/safe-settings/blob/e19444e0d69de050ba55d0262b71fcd8a98edfef/lib/plugins/rulesets.js
GitHub's REST schema lists RepositoryRole, but omits the numeric built-in mapping.
The admin bypass applies only to creation; update/deletion have no bypass actors.
This personal repository's owner publishes manually. Additional repository admins
would also qualify for the creation bypass; account administration remains trusted.
"""

import argparse
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys


OWNER = "jakubgt"
REPOSITORY = "jakubgt/homelab-vault-gen"
REPO_ENDPOINT = f"repos/{REPOSITORY}"
API_VERSION = "2026-03-10"
POLICY_DIRECTORY = Path(__file__).resolve().parents[1] / ".github" / "security"
POLICY_FILES = ("release-tag-creation.json", "release-tag-immutability.json")
POLICY_FIELDS = ("name", "target", "enforcement", "bypass_actors", "conditions", "rules")


class SecurityConfigurationError(Exception):
    """A failure that must stop configuration without weakening existing state."""


class GitHubAPI:
    def request(self, method, endpoint, payload=None, allowed_statuses=(200,)):
        command = [
            "gh", "api", "--hostname", "github.com", "--include",
            "--method", method, "-H", "Accept: application/vnd.github+json",
            "-H", f"X-GitHub-Api-Version: {API_VERSION}", endpoint,
        ]
        if payload is not None:
            command.extend(["--input", "-"])
        environment = os.environ.copy()
        environment.pop("GH_DEBUG", None)
        environment["GH_PROMPT_DISABLED"] = "1"
        try:
            result = subprocess.run(
                command,
                input=json.dumps(payload) if payload is not None else None,
                text=True, encoding="utf-8", capture_output=True, shell=False,
                timeout=60, env=environment,
            )
        except FileNotFoundError:
            raise SecurityConfigurationError("GitHub CLI (gh) was not found; use an existing authenticated installation.") from None
        except (OSError, subprocess.TimeoutExpired):
            raise SecurityConfigurationError(f"GitHub CLI could not complete {method} {endpoint}.") from None

        # Do not echo raw stdout/stderr: debug output may include credentials.
        response = result.stdout.replace("\r\n", "\n")
        header, separator, body = response.partition("\n\n")
        status_match = re.match(r"HTTP/\S+\s+(\d{3})(?:\s|$)", header)
        if not status_match or not separator:
            raise SecurityConfigurationError(f"GitHub CLI returned no valid HTTP response for {method} {endpoint}.")
        status = int(status_match.group(1))
        if status not in allowed_statuses or (result.returncode and status < 400):
            raise SecurityConfigurationError(f"GitHub API {method} {endpoint} failed (HTTP {status}). Check the existing login and repository administration permissions.")
        if status == 204 or not body.strip():
            data = None
        else:
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                raise SecurityConfigurationError(f"GitHub returned invalid JSON for {method} {endpoint}.") from None
        return status, data


def canonical_policy(policy):
    """Compare complete control fields, ignoring only server response metadata."""
    if not isinstance(policy, dict) or any(field not in policy for field in POLICY_FIELDS):
        raise SecurityConfigurationError("Ruleset details are incomplete; administration access is required to inspect bypass actors.")
    result = {field: copy.deepcopy(policy[field]) for field in POLICY_FIELDS}
    if not isinstance(result["bypass_actors"], list) or not isinstance(result["rules"], list):
        raise SecurityConfigurationError("Ruleset actor or rule data is malformed.")
    conditions = result["conditions"]
    if not isinstance(conditions, dict) or not isinstance(conditions.get("ref_name"), dict):
        raise SecurityConfigurationError("Ruleset ref conditions are malformed.")
    for field in ("include", "exclude"):
        values = conditions["ref_name"].get(field)
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise SecurityConfigurationError("Ruleset ref patterns are malformed.")
        conditions["ref_name"][field] = sorted(values)
    for rule in result["rules"]:
        if not isinstance(rule, dict):
            raise SecurityConfigurationError("Ruleset rule data is malformed.")
        # GitHub may omit the default false parameter when returning tag rules.
        if rule.get("type") == "update" and rule.get("parameters") in (None, {}):
            rule["parameters"] = {"update_allows_fetch_and_merge": False}
    for field in ("bypass_actors", "rules"):
        result[field].sort(key=lambda item: json.dumps(item, sort_keys=True))
    return result


def load_policies(directory=POLICY_DIRECTORY):
    """Reject edited payloads that broaden the exact reviewed control contract."""
    common = {
        "target": "tag", "enforcement": "active",
        "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
    }
    expected = [
        {**common, "name": "ReleaseTagCreationOwnerOnly",
         "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
         "rules": [{"type": "creation"}]},
        {**common, "name": "ReleaseTagImmutability", "bypass_actors": [],
         "rules": [{"type": "update", "parameters": {"update_allows_fetch_and_merge": False}}, {"type": "deletion"}]},
    ]
    loaded = []
    for filename, required in zip(POLICY_FILES, expected):
        try:
            policy = json.loads((Path(directory) / filename).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise SecurityConfigurationError(f"Cannot read policy {filename}.") from None
        if not isinstance(policy, dict) or set(policy) != set(POLICY_FIELDS) or canonical_policy(policy) != canonical_policy(required):
            raise SecurityConfigurationError(f"Policy {filename} differs from the reviewed release protection contract.")
        loaded.append(policy)
    return loaded


def ruleset_matches(actual, expected):
    """Pure fail-closed validator for callers such as the manual publisher."""
    try:
        return canonical_policy(actual) == canonical_policy(expected)
    except SecurityConfigurationError:
        return False


def get_object(api, endpoint):
    _, value = api.request("GET", endpoint)
    if not isinstance(value, dict):
        raise SecurityConfigurationError(f"GitHub returned malformed metadata for {endpoint}.")
    return value


def inspect_configuration(api, policies):
    """Read every prerequisite and desired ruleset before any mutation is allowed."""
    user = get_object(api, "user")
    if user.get("login") != OWNER or user.get("type") != "User":
        raise SecurityConfigurationError(f"The existing gh login must be the personal repository owner {OWNER}.")
    repo = get_object(api, REPO_ENDPOINT)
    owner = repo.get("owner")
    if (repo.get("full_name") != REPOSITORY or not isinstance(owner, dict)
            or owner.get("login") != OWNER or owner.get("type") != "User"):
        raise SecurityConfigurationError("Repository identity or personal ownership does not match the approved target.")
    if repo.get("default_branch") != "main" or repo.get("archived") is not False:
        raise SecurityConfigurationError("The repository must be active with main as its default branch.")
    if not isinstance(repo.get("permissions"), dict) or repo["permissions"].get("admin") is not True:
        raise SecurityConfigurationError("The existing gh login must have repository administration access.")
    branch = get_object(api, f"{REPO_ENDPOINT}/branches/main")
    if branch.get("name") != "main" or branch.get("protected") is not True:
        raise SecurityConfigurationError("main must already be protected; this helper never changes branch protection.")

    immutable_status, immutable = api.request(
        "GET", f"{REPO_ENDPOINT}/immutable-releases", allowed_statuses=(200, 404)
    )
    if immutable_status == 404:
        immutable_enabled = False
    elif not isinstance(immutable, dict) or type(immutable.get("enabled")) is not bool:
        raise SecurityConfigurationError("GitHub returned malformed immutable-release status.")
    else:
        immutable_enabled = immutable["enabled"]

    summaries = []
    for page in range(1, 101):
        _, batch = api.request("GET", f"{REPO_ENDPOINT}/rulesets?includes_parents=false&per_page=100&page={page}")
        if not isinstance(batch, list) or any(not isinstance(item, dict) for item in batch):
            raise SecurityConfigurationError("GitHub returned a malformed ruleset list.")
        summaries.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise SecurityConfigurationError("Ruleset pagination exceeded its safety limit.")

    missing = []
    verified = []
    for desired in policies:
        matches = [item for item in summaries if item.get("name") == desired["name"]]
        if len(matches) > 1:
            raise SecurityConfigurationError(f"Duplicate rulesets named {desired['name']} require manual review.")
        if not matches:
            missing.append(desired)
            continue
        identifier = matches[0].get("id")
        if type(identifier) is not int or identifier < 1:
            raise SecurityConfigurationError("GitHub returned an invalid ruleset ID.")
        actual = get_object(api, f"{REPO_ENDPOINT}/rulesets/{identifier}")
        if actual.get("source_type") != "Repository" or actual.get("source") != REPOSITORY:
            raise SecurityConfigurationError(f"Ruleset {desired['name']} has an unexpected source.")
        if not ruleset_matches(actual, desired):
            raise SecurityConfigurationError(f"Existing ruleset {desired['name']} differs from the desired policy; review it manually. No existing rulesets will be overwritten.")
        verified.append(desired["name"])
    return {"immutable_enabled": immutable_enabled, "missing": missing, "verified": verified}


def configure(api, policies, apply=False):
    state = inspect_configuration(api, policies)
    if not apply:
        return state
    try:
        if not state["immutable_enabled"]:
            api.request("PUT", f"{REPO_ENDPOINT}/immutable-releases", allowed_statuses=(204,))
        # Prevent tag movement/deletion before restricting creation.
        for policy in reversed(state["missing"]):
            api.request("POST", f"{REPO_ENDPOINT}/rulesets", payload=policy, allowed_statuses=(201,))
        verified = inspect_configuration(api, policies)
        if not verified["immutable_enabled"] or verified["missing"]:
            raise SecurityConfigurationError("Post-apply verification did not confirm every requested protection.")
        return verified
    except SecurityConfigurationError as error:
        raise SecurityConfigurationError(f"{error} Apply stopped; some protections may already be enabled. Re-run --check before continuing.") from None


def main(argv=None, api=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Read-only status check (the default).")
    mode.add_argument("--apply", action="store_true", help="Enable immutable releases and create missing exact tag rulesets.")
    args = parser.parse_args(argv)
    try:
        state = configure(api or GitHubAPI(), load_policies(), apply=args.apply)
    except SecurityConfigurationError as error:
        print(f"Security configuration failed: {error}", file=sys.stderr)
        return 1
    print(f"Repository: {REPOSITORY}")
    print(f"Immutable releases: {'enabled' if state['immutable_enabled'] else 'NOT ENABLED'}")
    for name in state["verified"]:
        print(f"Ruleset verified: {name}")
    for policy in state["missing"]:
        print(f"Ruleset missing: {policy['name']}")
    if not state["immutable_enabled"] or state["missing"]:
        print("Check only; no settings changed. Review the payloads, then run with --apply using the owner's existing gh login.")
        return 2
    print("All requested release protections verified. Existing branch protections and unrelated settings were preserved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
