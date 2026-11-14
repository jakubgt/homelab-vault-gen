#!/bin/sh
# Runs production source, rollback, and ref-resolution checks against fixtures.
# Never runs installer main, apt, a real service manager, or any network request.
set -eu

test_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "${test_script_dir}/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/homelab-vault-shell-test.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT
trap 'exit 130' HUP INT TERM
functions_file="${test_root}/installer-functions.sh"
awk '/^# BEGIN INSTALLER MAIN / { exit } { print }' "${repo_dir}/install-caddy-lxc.sh" >"$functions_file"
grep -q '^acquire_install_lock()' "$functions_file"

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

# Exercise the production source allowlist without running installer main.
# Repository paths changed; deployed paths and rollback metadata stay flat.
required_files_file="${test_root}/required-source-files.sh"
sed -n '/^for required_file in \\/,/^done$/p' "${repo_dir}/install-caddy-lxc.sh" >"$required_files_file"
[ -s "$required_files_file" ] || fail 'production source allowlist was not found'
organized_source="${test_root}/organized-source"
mkdir -p "${organized_source}/deploy"
cp -R "${repo_dir}/public" "${organized_source}/public"
cp "${repo_dir}/deploy/Caddyfile" "${organized_source}/deploy/Caddyfile"
cp "${repo_dir}/install-caddy-lxc.sh" "${organized_source}/install-caddy-lxc.sh"
(
    # shellcheck disable=SC1090
    . "$functions_file"
    SOURCE_DIR=$organized_source
    # shellcheck disable=SC1090
    . "$required_files_file"
) || fail 'organized public/deploy source was rejected'
mv "${organized_source}/public/core.js" "${organized_source}/core.js"
if (
    # shellcheck disable=SC1090
    . "$functions_file"
    SOURCE_DIR=$organized_source
    # shellcheck disable=SC1090
    . "$required_files_file"
) >/dev/null 2>&1; then
    fail 'a legacy root runtime file substituted for missing public/core.js'
fi
pass 'installer accepts organized source and rejects missing public runtime assets'

setup_fixture() {
    # This prefix includes constants and functions, but no production actions.
    # shellcheck disable=SC1090
    . "$functions_file"
    SITE_PARENT=$case_dir
    WEB_ROOT="${case_dir}/site"
    CADDY_CONFIG="${case_dir}/Caddyfile"
    CADDY_HOME="${case_dir}/caddy-home"
    CONFIG_BACKUP="${case_dir}/Caddyfile.previous"
    SITE_STAGE="${case_dir}/.homelab-vault.new.fixture"
    mkdir -p "$WEB_ROOT" "$SITE_STAGE" "$CADDY_HOME"
    printf 'old site\n' >"${WEB_ROOT}/index.html"
    printf 'old metadata\n' >"${WEB_ROOT}/${DEPLOYMENT_FILE}"
    printf 'new site\n' >"${SITE_STAGE}/index.html"
    printf 'new metadata\n' >"${SITE_STAGE}/${DEPLOYMENT_FILE}"
    printf 'Managed by Homelab Vault.\n' >"${SITE_STAGE}/${WEB_MARKER}"
    printf 'old config\n' >"$CADDY_CONFIG"
    cp "$CADDY_CONFIG" "$CONFIG_BACKUP"
    printf 'private CA fixture\n' >"${CADDY_HOME}/root.key"
    HAD_WEB_ROOT=1
    HAD_CONFIG=1
    CADDY_WAS_ACTIVE=1
    CADDY_WAS_ENABLED=1
    service_log="${case_dir}/services.log"
    # Preserve real copy/move behavior; only root ownership and service calls
    # are replaced, making the harness runnable by an unprivileged CI user.
    install() {
        install_mode=0644
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -o|-g) shift 2 ;;
                -m) install_mode=$2; shift 2 ;;
                *) break ;;
            esac
        done
        command cp -- "$1" "$2"
        command chmod "$install_mode" "$2"
    }
    systemctl() { printf '%s\n' "$*" >>"$service_log"; }
}

# A failed health check after both swaps must restore files, metadata, config,
# and the prior active/enabled service state without replacing the existing CA.
case_dir="${test_root}/failed-health"
set +e
(
    set -e
    setup_fixture
    trap cleanup EXIT
    activate_site
    CONFIG_MUTATION_BEGUN=1
    printf 'new config\n' >"$CADDY_CONFIG"
    exit 23
)
result=$?
set -e
[ "$result" -eq 23 ] || fail 'failed health check exit status'
[ "$(cat "${case_dir}/site/index.html")" = 'old site' ] || fail 'site rollback'
[ "$(cat "${case_dir}/site/.homelab-vault-deployment")" = 'old metadata' ] || fail 'metadata rollback'
[ "$(cat "${case_dir}/Caddyfile")" = 'old config' ] || fail 'config rollback'
[ "$(cat "${case_dir}/caddy-home/root.key")" = 'private CA fixture' ] || fail 'CA preservation'
grep -qx 'restart caddy' "${case_dir}/services.log" || fail 'active service restoration'
grep -qx 'enable caddy' "${case_dir}/services.log" || fail 'enabled service restoration'
pass 'failed health check restores site, metadata, configuration, service state and CA'

# Inject a filesystem failure between old-site backup and staged-site activation.
case_dir="${test_root}/failed-swap"
set +e
(
    set -e
    setup_fixture
    trap cleanup EXIT
    mv() {
        if [ "$2" = "$SITE_STAGE" ]; then return 1; fi
        command mv "$@"
    }
    activate_site
)
result=$?
set -e
[ "$result" -ne 0 ] || fail 'injected swap failure exit status'
[ "$(cat "${case_dir}/site/index.html")" = 'old site' ] || fail 'interrupted swap rollback'
pass 'interrupted directory swap preserves the previous deployment'

# A fresh deployment with no prior service should be removed after failure.
case_dir="${test_root}/failed-first-install"
set +e
(
    set -e
    setup_fixture
    rmdir "$WEB_ROOT" 2>/dev/null || rm -rf -- "$WEB_ROOT"
    rm -f -- "$CADDY_CONFIG" "$CONFIG_BACKUP"
    HAD_WEB_ROOT=0
    HAD_CONFIG=0
    CADDY_WAS_ACTIVE=0
    CADDY_WAS_ENABLED=0
    trap cleanup EXIT
    activate_site
    CONFIG_MUTATION_BEGUN=1
    printf 'new config\n' >"$CADDY_CONFIG"
    exit 24
)
result=$?
set -e
[ "$result" -eq 24 ] || fail 'failed first-install exit status'
[ ! -e "${case_dir}/site" ] || fail 'new site removed'
[ ! -e "${case_dir}/Caddyfile" ] || fail 'new config removed'
grep -qx 'stop caddy' "${case_dir}/services.log" || fail 'inactive service restoration'
grep -qx 'disable caddy' "${case_dir}/services.log" || fail 'disabled service restoration'
pass 'failed first install removes its site and restores an inactive service'

case_dir="${test_root}/successful-update"
(
    setup_fixture
    trap cleanup EXIT
    activate_site
    DEPLOYMENT_HEALTHY=1
)
[ "$(cat "${case_dir}/site/index.html")" = 'new site' ] || fail 'successful site activation'
[ "$(find "$case_dir" -name '.homelab-vault.previous.*' | wc -l | tr -d ' ')" -eq 0 ] || fail 'successful backup cleanup'
pass 'successful update retains the new site and removes its old backup'

# A previous failed-site directory with a reused PID must not be deleted.
case_dir="${test_root}/recovery-collision"
(
    setup_fixture
    activate_site
    collision="${case_dir}/.homelab-vault.failed.$$"
    mkdir "$collision"
    printf 'keep recovery\n' >"${collision}/evidence"
    if restore_previous_site; then fail 'collision must require manual recovery'; fi
    [ "$(cat "${collision}/evidence")" = 'keep recovery' ] || fail 'existing recovery preserved'
    [ -f "${SITE_BACKUP}/index.html" ] || fail 'original backup preserved'
    if safe_remove_tree "${case_dir}/unrelated"; then fail 'cleanup boundary'; fi
    if safe_remove_tree "${case_dir}/.homelab-vault.new.foo/../unrelated"; then fail 'cleanup traversal'; fi
)
pass 'rollback collisions retain recovery files and cleanup rejects unrelated paths'

(
    # shellcheck disable=SC1090
    . "$functions_file"
    # A local repository models reviewed first-parent commits, a merged side
    # commit, an older installer, and a malicious higher orphan tag. Git and
    # Python parsing are real; only HTTP metadata and the root check are mocked.
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    fixture_repo="${test_root}/source-repository"
    git -c init.defaultBranch=main init --quiet "$fixture_repo"
    git -C "$fixture_repo" config user.name 'Installer test'
    git -C "$fixture_repo" config user.email 'installer-test@example.invalid'
    git -C "$fixture_repo" config commit.gpgsign false
    git -C "$fixture_repo" config tag.gpgsign false
    git -C "$fixture_repo" config core.hooksPath /dev/null
    cat >"${fixture_repo}/install-caddy-lxc.sh" <<'OLD'
#!/bin/sh
PINNED_INSTALLER_PROTOCOL=1
printf 'legacy ran' >"$BOOTSTRAP_OBSERVATION"
OLD
    git -C "$fixture_repo" add install-caddy-lxc.sh
    git -C "$fixture_repo" commit --quiet -m 'Legacy reviewed installer'
    legacy_commit=$(git -C "$fixture_repo" rev-parse HEAD)
    cat >"${fixture_repo}/install-caddy-lxc.sh" <<'APPROVED'
#!/bin/sh
PINNED_INSTALLER_PROTOCOL=2
printf '%s\n' "$VAULT_REF" >"$BOOTSTRAP_OBSERVATION"
APPROVED
    git -C "$fixture_repo" add install-caddy-lxc.sh
    git -C "$fixture_repo" commit --quiet -m 'Approved protected-main installer'
    rollback_commit=$(git -C "$fixture_repo" rev-parse HEAD)
    git -C "$fixture_repo" checkout --quiet -b side
    printf 'side branch\n' >"${fixture_repo}/side.txt"
    git -C "$fixture_repo" add side.txt
    git -C "$fixture_repo" commit --quiet -m 'Commit reachable only through a second parent'
    side_commit=$(git -C "$fixture_repo" rev-parse HEAD)
    git -C "$fixture_repo" checkout --quiet main
    git -C "$fixture_repo" merge --quiet --no-ff side -m 'Reviewed merge on main'
    main_commit=$(git -C "$fixture_repo" rev-parse HEAD)
    git -C "$fixture_repo" tag -a v2.2.1 -m 'Immutable release fixture'
    git -C "$fixture_repo" checkout --quiet --orphan malicious
    cat >"${fixture_repo}/install-caddy-lxc.sh" <<'MALICIOUS'
#!/bin/sh
PINNED_INSTALLER_PROTOCOL=2
printf 'malicious ran' >"$BOOTSTRAP_OBSERVATION"
MALICIOUS
    git -C "$fixture_repo" add install-caddy-lxc.sh
    git -C "$fixture_repo" commit --quiet -m 'Unreviewed orphan with a compatible marker'
    orphan_commit=$(git -C "$fixture_repo" rev-parse HEAD)
    git -C "$fixture_repo" tag v999.0.0
    git -C "$fixture_repo" checkout --quiet main
    REPO_URL=$fixture_repo
    id() { printf '0\n'; }
    BOOTSTRAP_OBSERVATION="${test_root}/bootstrap-commit"
    export BOOTSTRAP_OBSERVATION

    approved_release='{"tag_name":"v2.2.1","draft":false,"prerelease":false,"immutable":true,"published_at":"2026-11-03T12:00:00Z"}'
    release_json=$approved_release
    protected_main=$(printf '{"name":"main","protected":true,"commit":{"sha":"%s"}}' "$main_commit")
    main_json=$protected_main
    release_api_result=0
    main_api_result=0
    github_metadata() {
        case "$1" in
            releases/latest|releases/tags/v2.2.1)
                [ "$release_api_result" -eq 0 ] || return "$release_api_result"
                printf '%s\n' "$release_json"
                ;;
            branches/main)
                [ "$main_api_result" -eq 0 ] || return "$main_api_result"
                printf '%s\n' "$main_json"
                ;;
            *) return 22 ;;
        esac
    }

    mkdir "${test_root}/python-poison"
    printf 'raise RuntimeError("untrusted local JSON module imported")\n' >"${test_root}/python-poison/json.py"
    (
        cd "${test_root}/python-poison"
        PYTHONPATH=$PWD
        export PYTHONPATH
        printf '%s' "$approved_release" | validate_metadata release latest
    ) >"${test_root}/isolated-metadata-result"
    [ "$(cat "${test_root}/isolated-metadata-result")" = v2.2.1 ] || fail 'metadata parser imported ambient Python code'
    pass 'metadata parser ignores untrusted working-directory and PYTHONPATH modules'

    resolve_revision latest
    [ "$RESOLVED_REF" = v2.2.1 ] || fail 'unpublished higher orphan tag selected'
    [ "$RESOLVED_COMMIT" = "$main_commit" ] || fail 'published annotated tag peeling'
    resolve_revision v2.2.1
    [ "$RESOLVED_COMMIT" = "$main_commit" ] || fail 'explicit immutable release'
    bootstrap_update latest
    [ "$(cat "$BOOTSTRAP_OBSERVATION")" = "$main_commit" ] || fail 'approved release must pass one verified SHA'
    bootstrap_update "$rollback_commit"
    [ "$(cat "$BOOTSTRAP_OBSERVATION")" = "$rollback_commit" ] || fail 'reviewed explicit SHA rollback'
    pass 'published immutable release ignores a malicious higher tag and executes the verified on-main SHA'
    pass 'explicit reviewed first-parent SHA supports protocol-2 rollback'

    rm -f -- "$BOOTSTRAP_OBSERVATION"
    for rejected_commit in "$orphan_commit" "$side_commit" "$legacy_commit"; do
        if bootstrap_update "$rejected_commit" >/dev/null 2>&1; then fail 'unsafe rollback was accepted'; fi
        [ ! -e "$BOOTSTRAP_OBSERVATION" ] || fail 'untrusted or legacy installer executed'
    done
    if (fetch_revision "${test_root}/orphan-checkout" "$orphan_commit") >/dev/null 2>&1; then
        fail 'off-main checkout was accepted'
    fi
    [ ! -e "${test_root}/orphan-checkout/install-caddy-lxc.sh" ] || fail 'untrusted files checked out before ancestry validation'
    pass 'off-main, second-parent-only and legacy commits cannot execute; off-main checkout is refused'

    for bad_ref in main v2.2.1-rc1 v02.2.1 '--upload-pack=other' abc123 v999.0.0; do
        if (resolve_revision "$bad_ref") >/dev/null 2>&1; then fail "invalid/unpublished ref accepted: $bad_ref"; fi
    done
    for bad_metadata in \
        '{"tag_name":"v2.2.1","draft":true,"prerelease":false,"immutable":true,"published_at":"2026-11-03T12:00:00Z"}' \
        '{"tag_name":"v2.2.1","draft":false,"prerelease":true,"immutable":true,"published_at":"2026-11-03T12:00:00Z"}' \
        '{"tag_name":"v2.2.1","draft":false,"prerelease":false,"immutable":false,"published_at":"2026-11-03T12:00:00Z"}' \
        '{"tag_name":"v2.2.1","draft":false,"prerelease":false,"immutable":"true","published_at":"2026-11-03T12:00:00Z"}' \
        '{"tag_name":"v2.2.1","draft":false,"prerelease":false,"published_at":"2026-11-03T12:00:00Z"}' \
        '{"tag_name":"v2.2.1","draft":false,"prerelease":false,"immutable":true,"published_at":null}' \
        '{"tag_name":"v2.2.1-rc1","draft":false,"prerelease":false,"immutable":true,"published_at":"2026-11-03T12:00:00Z"}' \
        '{"tag_name":"v2.2.2","draft":false,"prerelease":false,"immutable":true,"published_at":"2026-11-03T12:00:00Z"}' \
        '{"message":"API rate limit exceeded"}' '[]' 'not JSON'
    do
        release_json=$bad_metadata
        if bootstrap_update v2.2.1 >/dev/null 2>&1; then fail 'untrusted release metadata accepted'; fi
        [ ! -e "$BOOTSTRAP_OBSERVATION" ] || fail 'installer ran after invalid release metadata'
    done
    release_json=$approved_release
    release_api_result=22
    if bootstrap_update latest >/dev/null 2>&1; then fail 'release API failure accepted'; fi
    release_api_result=0
    pass 'drafts, prereleases, mutable releases, malformed metadata and API failures fail closed'

    # Even a syntactically valid immutable-release response cannot authorize an
    # off-main commit. Resolve its fake tag, then let the real ancestry check fail.
    release_json='{"tag_name":"v999.0.0","draft":false,"prerelease":false,"immutable":true,"published_at":"2026-11-03T12:00:00Z"}'
    if bootstrap_update latest >/dev/null 2>&1; then fail 'immutable off-main release accepted'; fi
    [ ! -e "$BOOTSTRAP_OBSERVATION" ] || fail 'off-main release executed'
    release_json=$approved_release
    pass 'immutable release metadata never bypasses protected-main ancestry'

    for bad_main in \
        '{"name":"main","protected":false,"commit":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' \
        '{"name":"main","protected":"true","commit":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' \
        '{"name":"main","protected":true,"commit":{"sha":"short"}}' \
        '[]' 'not JSON'
    do
        main_json=$bad_main
        if bootstrap_update "$main_commit" >/dev/null 2>&1; then fail 'invalid protected-main metadata accepted'; fi
    done
    main_json=$(printf '{"name":"main","protected":true,"commit":{"sha":"%s"}}' "$rollback_commit")
    if bootstrap_update "$main_commit" >/dev/null 2>&1; then fail 'main metadata/fetch race accepted'; fi
    main_json=$protected_main
    main_api_result=22
    if bootstrap_update "$main_commit" >/dev/null 2>&1; then fail 'main API failure accepted'; fi
    main_api_result=0
    REPO_URL="${test_root}/nonexistent-remote"
    if bootstrap_update "$main_commit" >/dev/null 2>&1; then fail 'failed history fetch accepted'; fi
    [ ! -e "$BOOTSTRAP_OBSERVATION" ] || fail 'installer ran after a failed trust check'
    pass 'missing protection, malformed main metadata, branch races and history-fetch errors fail closed'
)

if command -v flock >/dev/null 2>&1; then
    (
        # shellcheck disable=SC1090
        . "$functions_file"
        LOCK_FILE="${test_root}/installer.lock"
        acquire_install_lock
        if (exec 9>&-; acquire_install_lock) 2>/dev/null; then fail 'second installer acquired lock'; fi
        flock -u 9
        exec 9>&-
        acquire_install_lock
    )
    pass 'installation lock excludes concurrent writers and releases cleanly'
else
    printf 'SKIP flock is unavailable on this host; the Linux CI job must exercise the lock test\n'
fi

printf 'Installer shell harness passed.\n'
