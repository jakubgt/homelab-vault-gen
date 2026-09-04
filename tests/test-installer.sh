#!/bin/sh
# Runs production rollback/ref-resolution functions against temporary fixtures.
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
    git() {
        case "$*" in
            'ls-remote --tags --refs '*)
                printf '%s\n' \
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/v2.9.0' \
                    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v2.10.0' \
                    'cccccccccccccccccccccccccccccccccccccccc refs/tags/v3.0.0-rc1'
                ;;
            'ls-remote --exit-code '*'refs/tags/v2.10.0 refs/tags/v2.10.0^{}')
                printf '%s\n' \
                    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v2.10.0' \
                    'dddddddddddddddddddddddddddddddddddddddd refs/tags/v2.10.0^{}'
                ;;
            *) return 1 ;;
        esac
    }
    resolve_revision latest
    [ "$RESOLVED_REF" = v2.10.0 ] || fail 'stable version ordering'
    [ "$RESOLVED_COMMIT" = dddddddddddddddddddddddddddddddddddddddd ] || fail 'annotated tag peeling'
    git() { fail 'a full commit must not be resolved through a mutable ref'; }
    resolve_revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    [ "$RESOLVED_COMMIT" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ] || fail 'full commit preservation'
    for bad_ref in main v2.2.0-rc1 '--upload-pack=other' abc123; do
        if (resolve_revision "$bad_ref") 2>/dev/null; then fail "invalid ref accepted: $bad_ref"; fi
    done
)
pass 'release resolution selects stable tags, peels annotated tags and rejects mutable branches'

(
    # shellcheck disable=SC1090
    . "$functions_file"
    id() { printf '0\n'; }
    BOOTSTRAP_OBSERVATION="${test_root}/bootstrap-commit"
    export BOOTSTRAP_OBSERVATION
    fetch_revision() {
        mkdir -p "$1"
        cat >"${1}/install-caddy-lxc.sh" <<'PINNED'
#!/bin/sh
PINNED_INSTALLER_PROTOCOL=1
printf '%s\n' "$VAULT_REF" >"$BOOTSTRAP_OBSERVATION"
PINNED
    }
    bootstrap_update aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    [ "$(cat "$BOOTSTRAP_OBSERVATION")" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ] \
        || fail 'bootstrap must forward the exact resolved commit'
    rm -f -- "$BOOTSTRAP_OBSERVATION"
    fetch_revision() {
        mkdir -p "$1"
        printf 'printf "legacy ran" >"$BOOTSTRAP_OBSERVATION"\n' >"${1}/install-caddy-lxc.sh"
    }
    if bootstrap_update aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2>/dev/null; then
        fail 'legacy unpinned installer was accepted'
    fi
    [ ! -e "$BOOTSTRAP_OBSERVATION" ] || fail 'legacy installer must never execute'
)
pass 'updater forwards one exact commit and refuses legacy installers that could fetch main'

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
