#!/bin/sh

set -eu
umask 077

REPO_URL="https://github.com/jakubgt/homelab-vault-gen.git"
RELEASE_VERSION="2.2.0"
PINNED_INSTALLER_PROTOCOL=1
WEB_ROOT="/srv/homelab-vault"
SITE_PARENT="${WEB_ROOT%/*}"
WEB_MARKER=".homelab-vault-managed"
DEPLOYMENT_FILE=".homelab-vault-deployment"
LOCK_FILE="/run/homelab-vault/install.lock"
CADDY_CONFIG="/etc/caddy/Caddyfile"
CADDY_HOME="/var/lib/caddy"
CA_CERT="${CADDY_HOME}/.local/share/caddy/pki/authorities/local/root.crt"
PUBLIC_CA="${WEB_ROOT}/caddy-root.crt"
UPDATE_COMMAND="/usr/local/sbin/homelab-vault-update"
MANAGED_MARKER="# Managed by the Homelab Vault installer."

TEMP_DIR=""
CANDIDATE_CONFIG=""
CONFIG_BACKUP=""
CONFIG_MUTATION_BEGUN=0
DEPLOYMENT_HEALTHY=0
HAD_CONFIG=0
HAD_WEB_ROOT=0
CADDY_WAS_ACTIVE=0
CADDY_WAS_ENABLED=0
CADDY_PREINSTALLED=0
CADDY_PACKAGE_TOUCHED=0
SITE_STAGE=""
SITE_BACKUP=""
SITE_MUTATION_BEGUN=0
UPDATE_CANDIDATE=""
SOURCE_DIR=""

say() {
    printf '\n==> %s\n' "$1"
}

die() {
    printf '\nERROR: %s\n' "$1" >&2
    exit 1
}

safe_remove_tree() {
    target=$1
    case "$target" in
        */../*|*/..|*/./*)
            printf 'Refusing a non-canonical cleanup path: %s\n' "$target" >&2
            return 1
            ;;
    esac
    case "$target" in
        "$SITE_PARENT"/.homelab-vault.new.*|\
        "$SITE_PARENT"/.homelab-vault.failed.*|\
        "$SITE_PARENT"/.homelab-vault.previous.*)
            rm -rf -- "$target"
            ;;
        *)
            printf 'Refusing to remove unexpected path: %s\n' "$target" >&2
            return 1
            ;;
    esac
}

restore_previous_site() {
    set +e
    site_restore_failed=0
    failed_site=""
    moved_failed_site=0
    printf '\nInstallation failed after changing the site; restoring the previous files.\n' >&2

    if [ "$HAD_WEB_ROOT" -eq 1 ] && [ -d "$SITE_BACKUP" ]; then
        if [ -e "$WEB_ROOT" ] || [ -L "$WEB_ROOT" ]; then
            failed_site="${SITE_PARENT}/.homelab-vault.failed.$$"
            if [ -e "$failed_site" ] || [ -L "$failed_site" ]; then
                site_restore_failed=1
            elif ! mv -- "$WEB_ROOT" "$failed_site"; then
                site_restore_failed=1
            else
                moved_failed_site=1
            fi
        fi

        if [ "$site_restore_failed" -eq 0 ] && ! mv -- "$SITE_BACKUP" "$WEB_ROOT"; then
            site_restore_failed=1
        fi
    elif [ "$HAD_WEB_ROOT" -eq 1 ]; then
        [ -d "$WEB_ROOT" ] || site_restore_failed=1
    elif [ -d "$WEB_ROOT" ] && [ -f "${WEB_ROOT}/${WEB_MARKER}" ]; then
        failed_site="${SITE_PARENT}/.homelab-vault.failed.$$"
        if [ -e "$failed_site" ] || [ -L "$failed_site" ] || ! mv -- "$WEB_ROOT" "$failed_site"; then
            site_restore_failed=1
        else
            moved_failed_site=1
        fi
    fi

    if [ "$moved_failed_site" -eq 1 ] && [ -d "$failed_site" ]; then
        safe_remove_tree "$failed_site" || site_restore_failed=1
    fi

    if [ "$site_restore_failed" -ne 0 ]; then
        printf 'WARNING: Automatic site rollback failed. Recovery files were kept under %s.\n' "$SITE_PARENT" >&2
    fi

    return "$site_restore_failed"
}

restore_previous_caddy() {
    set +e
    caddy_restore_failed=0
    printf '\nRestoring the previous Caddy configuration and service state.\n' >&2

    if [ "$HAD_CONFIG" -eq 1 ] && [ -f "$CONFIG_BACKUP" ]; then
        rollback_config="${CADDY_CONFIG}.rollback.$$"
        if ! install -o root -g root -m 0644 "$CONFIG_BACKUP" "$rollback_config" \
            || ! mv -f -- "$rollback_config" "$CADDY_CONFIG"; then
            caddy_restore_failed=1
        fi
    elif [ "$HAD_CONFIG" -eq 1 ]; then
        caddy_restore_failed=1
    else
        rm -f -- "$CADDY_CONFIG" || caddy_restore_failed=1
    fi

    if systemctl cat caddy >/dev/null 2>&1; then
        if [ "$CADDY_WAS_ACTIVE" -eq 1 ]; then
            systemctl restart caddy >/dev/null 2>&1 || caddy_restore_failed=1
        else
            systemctl stop caddy >/dev/null 2>&1 || caddy_restore_failed=1
        fi

        if [ "$CADDY_WAS_ENABLED" -eq 1 ]; then
            systemctl enable caddy >/dev/null 2>&1 || caddy_restore_failed=1
        else
            systemctl disable caddy >/dev/null 2>&1 || caddy_restore_failed=1
        fi
    fi

    if [ "$caddy_restore_failed" -ne 0 ]; then
        printf 'WARNING: Automatic Caddy rollback failed. Inspect %s and the caddy service manually.\n' \
            "$CADDY_CONFIG" >&2
    fi

    return "$caddy_restore_failed"
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
    rollback_failed=0

    if [ "$status" -ne 0 ] && [ "$DEPLOYMENT_HEALTHY" -eq 0 ]; then
        if [ "$SITE_MUTATION_BEGUN" -eq 1 ]; then
            restore_previous_site || rollback_failed=1
        fi
        if [ "$CONFIG_MUTATION_BEGUN" -eq 1 ] || [ "$CADDY_PACKAGE_TOUCHED" -eq 1 ]; then
            restore_previous_caddy || rollback_failed=1
        fi
    fi

    if [ -n "$CANDIDATE_CONFIG" ] && [ -f "$CANDIDATE_CONFIG" ]; then
        rm -f -- "$CANDIDATE_CONFIG"
    fi

    if [ -n "$UPDATE_CANDIDATE" ] && [ -f "$UPDATE_CANDIDATE" ]; then
        rm -f -- "$UPDATE_CANDIDATE"
    fi

    if [ -n "$SITE_STAGE" ] && [ -d "$SITE_STAGE" ]; then
        safe_remove_tree "$SITE_STAGE" || rollback_failed=1
    fi

    if [ "$status" -eq 0 ] && [ -n "$SITE_BACKUP" ] && [ -d "$SITE_BACKUP" ]; then
        safe_remove_tree "$SITE_BACKUP" || rollback_failed=1
    fi

    if [ "$rollback_failed" -eq 0 ] && [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        case "$TEMP_DIR" in
            /tmp/homelab-vault-install.*) rm -rf -- "$TEMP_DIR" ;;
        esac
    fi

    if [ "$rollback_failed" -ne 0 ]; then
        printf 'Rollback needs manual attention. Temporary recovery data remains at: %s\n' \
            "$TEMP_DIR" >&2
        [ "$status" -ne 0 ] || status=1
    fi

    exit "$status"
}

# Resolve a release once, then use only its full commit for installer and assets.
resolve_revision() {
    requested_ref=$1
    if [ "$requested_ref" = latest ]; then
        remote_tags="$(git ls-remote --tags --refs "$REPO_URL")" \
            || die "Cannot read release tags from GitHub."
        requested_ref="$(printf '%s\n' "$remote_tags" \
            | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { sub(/^refs\/tags\//, "", $2); print $2 }' \
            | sort -V | tail -n 1)"
        [ -n "$requested_ref" ] || die "No stable release tags are available."
    fi
    if printf '%s\n' "$requested_ref" | grep -Eq '^[0-9a-f]{40}$'; then
        RESOLVED_COMMIT=$requested_ref
    elif printf '%s\n' "$requested_ref" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
        remote_refs="$(git ls-remote --exit-code "$REPO_URL" \
            "refs/tags/${requested_ref}" "refs/tags/${requested_ref}^{}")" \
            || die "Release ${requested_ref} was not found. Use a published tag or full commit SHA."
        RESOLVED_COMMIT="$(printf '%s\n' "$remote_refs" \
            | awk '/\^\{\}$/ { peeled=$1 } !/\^\{\}$/ { direct=$1 } END { print peeled ? peeled : direct }')"
    else
        die "Use a stable release tag (v2.2.0), a full lowercase commit SHA, or latest."
    fi
    printf '%s\n' "$RESOLVED_COMMIT" | grep -Eq '^[0-9a-f]{40}$' \
        || die "GitHub returned an invalid commit SHA."
    RESOLVED_REF=$requested_ref
}

fetch_revision() {
    checkout_dir=$1
    checkout_commit=$2
    git -c init.defaultBranch=main init --quiet "$checkout_dir"
    git -C "$checkout_dir" remote add origin "$REPO_URL"
    git -C "$checkout_dir" fetch --quiet --depth 1 origin "$checkout_commit"
    git -C "$checkout_dir" checkout --quiet --detach FETCH_HEAD
    [ "$(git -C "$checkout_dir" rev-parse HEAD)" = "$checkout_commit" ] \
        || die "Downloaded checkout does not match the selected commit."
}

read_deployment_value() {
    [ -r "${WEB_ROOT}/${DEPLOYMENT_FILE}" ] || return 0
    sed -n "s/^${1}=//p" "${WEB_ROOT}/${DEPLOYMENT_FILE}"
}

show_status() {
    deployed_commit="$(read_deployment_value COMMIT)"
    if [ -z "$deployed_commit" ]; then
        printf 'No versioned deployment metadata found. Run this command as root; legacy installs need one update.\n'
        return 0
    fi
    printf 'Version: %s\nCommit:  %s\nSite:    https://%s\nCaddy:   ' \
        "$(read_deployment_value VERSION)" "$deployed_commit" "$(read_deployment_value IP)"
    systemctl is-active caddy || true
}

check_update() {
    resolve_revision latest
    deployed_commit="$(read_deployment_value COMMIT)"
    printf 'Latest stable tag: %s\nCommit: %s\n' "$RESOLVED_REF" "$RESOLVED_COMMIT"
    if [ "$deployed_commit" = "$RESOLVED_COMMIT" ]; then
        printf 'The deployed site is current.\n'
    elif [ -z "$deployed_commit" ]; then
        printf 'Installed version is unknown. Run as root or update a legacy installation.\n'
    else
        printf 'The latest stable tag differs from the deployed commit. To install it, run:\n  homelab-vault-update %s\n' "$RESOLVED_REF"
    fi
}

bootstrap_update() (
    [ "$(id -u)" -eq 0 ] || die "Run updates as root inside the Debian LXC."
    resolve_revision "$1"
    bootstrap_dir="$(mktemp -d /tmp/homelab-vault-update.XXXXXX)"
    trap 'rm -rf -- "$bootstrap_dir"' EXIT
    trap 'exit 130' HUP INT TERM
    fetch_revision "${bootstrap_dir}/source" "$RESOLVED_COMMIT"
    grep -Fxq "PINNED_INSTALLER_PROTOCOL=${PINNED_INSTALLER_PROTOCOL}" \
        "${bootstrap_dir}/source/install-caddy-lxc.sh" \
        || die "That revision predates this pinned updater or uses an unsupported installer protocol."
    printf 'Installing %s (%s).\n' "$RESOLVED_REF" "$RESOLVED_COMMIT"
    VAULT_REF="$RESOLVED_COMMIT" /bin/sh "${bootstrap_dir}/source/install-caddy-lxc.sh" install
)

activate_site() {
    if [ -d "$WEB_ROOT" ]; then
        SITE_BACKUP="${SITE_PARENT}/.homelab-vault.previous.$$"
        if [ -e "$SITE_BACKUP" ] || [ -L "$SITE_BACKUP" ]; then
            die "Temporary backup path already exists: ${SITE_BACKUP}"
        fi
    fi
    SITE_MUTATION_BEGUN=1
    [ -z "$SITE_BACKUP" ] || mv -- "$WEB_ROOT" "$SITE_BACKUP"
    mv -- "$SITE_STAGE" "$WEB_ROOT"
    SITE_STAGE=""
}

acquire_install_lock() {
    command -v flock >/dev/null 2>&1 || die "Install Debian's util-linux package (flock is required)."
    lock_directory=${LOCK_FILE%/*}
    if [ -L "$lock_directory" ] || [ -L "$LOCK_FILE" ]; then
        die "Refusing a symbolic link in the installer lock path."
    fi
    # /run is root-owned. Keep the lock outside world-writable /run/lock so an
    # unprivileged user cannot pre-create a lockfile or redirect a root write.
    install -d -m 0700 "$lock_directory"
    exec 9>"$LOCK_FILE"
    flock -n 9 || die "Another Homelab Vault installation or update is running."
}

# BEGIN INSTALLER MAIN (the shell harness loads only the functions above).
case "${0##*/}" in
    homelab-vault-update) action=${1:-update} ;;
    *) action=${1:-install} ;;
esac
case "$action" in
    help|--help|-h)
        printf '%s\n' \
            'Install:     install-caddy-lxc.sh (defaults to its embedded release tag)' \
            'Update:      homelab-vault-update [update] [latest|vX.Y.Z|full-commit-SHA]' \
            'Inspect:     homelab-vault-update status' \
            'Check tags:  homelab-vault-update check-update' \
            'Override the initial installer ref with VAULT_REF; its bytes must match that revision.'
        exit 0
        ;;
    status) [ "$#" -le 1 ] || die "Usage: homelab-vault-update status"; show_status; exit 0 ;;
    check-update) [ "$#" -le 1 ] || die "Usage: homelab-vault-update check-update"; check_update; exit 0 ;;
    update)
        [ "$#" -eq 0 ] || shift
        [ "$#" -le 1 ] || die "Usage: homelab-vault-update [update] [tag|commit]"
        bootstrap_update "${1:-latest}"
        exit 0
        ;;
    install) [ "$#" -le 1 ] || die "Usage: install-caddy-lxc.sh [install]" ;;
    *)
        [ "$#" -eq 1 ] || die "Usage: homelab-vault-update [status|check-update|update|tag|commit]"
        bootstrap_update "$action"
        exit 0
        ;;
esac

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

[ "$(id -u)" -eq 0 ] || die "Run this installer as root inside the Debian LXC."
[ -r /etc/os-release ] || die "Cannot identify this operating system."

# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "debian" ] || die "This installer supports Debian LXC containers only."
[ -d /run/systemd/system ] || die "This container is not running systemd."

# The descriptor remains open until cleanup exits, including failure rollback.
acquire_install_lock

TEMP_DIR="$(mktemp -d /tmp/homelab-vault-install.XXXXXX)"

if dpkg-query -W -f='${Status}\n' caddy 2>/dev/null | grep -Fq 'install ok installed'; then
    CADDY_PREINSTALLED=1
fi

if systemctl is-active --quiet caddy 2>/dev/null; then
    CADDY_WAS_ACTIVE=1
fi

if systemctl is-enabled --quiet caddy 2>/dev/null; then
    CADDY_WAS_ENABLED=1
fi

if [ -L "$CADDY_CONFIG" ]; then
    die "${CADDY_CONFIG} is a symbolic link. Move it aside before continuing."
elif [ -f "$CADDY_CONFIG" ]; then
    HAD_CONFIG=1
    CONFIG_BACKUP="${TEMP_DIR}/Caddyfile.previous"
    cp -p -- "$CADDY_CONFIG" "$CONFIG_BACKUP"

    if ! grep -Fq "$MANAGED_MARKER" "$CADDY_CONFIG"; then
        if ! grep -Fq 'Homelab Vault' "$CADDY_CONFIG" || ! grep -Fq '/srv/homelab-vault' "$CADDY_CONFIG"; then
            die "${CADDY_CONFIG} belongs to another deployment. Move it aside before continuing."
        fi
    fi
elif [ -e "$CADDY_CONFIG" ]; then
    die "${CADDY_CONFIG} is not a regular file. Move it aside before continuing."
fi

if [ "$CADDY_WAS_ACTIVE" -eq 1 ] && [ "$HAD_CONFIG" -eq 0 ]; then
    die "An active Caddy service has no ${CADDY_CONFIG}; refusing to replace an unknown deployment."
fi

if [ -L "$WEB_ROOT" ]; then
    die "${WEB_ROOT} is a symbolic link. Move it aside before continuing."
elif [ -d "$WEB_ROOT" ]; then
    HAD_WEB_ROOT=1
    if [ -f "${WEB_ROOT}/${WEB_MARKER}" ] \
        && [ ! -L "${WEB_ROOT}/${WEB_MARKER}" ] \
        && grep -Fxq 'Managed by Homelab Vault.' "${WEB_ROOT}/${WEB_MARKER}"; then
        :
    elif [ -z "$(find "$WEB_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        :
    elif grep -Fq '<title>Homelab Vault Generator</title>' "${WEB_ROOT}/index.html" 2>/dev/null \
        && [ -f "${WEB_ROOT}/styles.css" ] \
        && [ -f "${WEB_ROOT}/core.js" ] \
        && [ -f "${WEB_ROOT}/app.js" ] \
        && [ -f "${WEB_ROOT}/words.js" ] \
        && [ -f "${WEB_ROOT}/qrcode.min.js" ]; then
        say "Recognized an older Homelab Vault deployment; it will be migrated safely"
    else
        die "${WEB_ROOT} is not an installer-managed Homelab Vault site. Move it aside before continuing."
    fi
elif [ -e "$WEB_ROOT" ]; then
    die "${WEB_ROOT} is not a directory. Move it aside before continuing."
fi

say "Installing the required Debian packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    debian-archive-keyring \
    debian-keyring \
    git \
    gnupg \
    iproute2

say "Fetching one verified Homelab Vault revision"
resolve_revision "${VAULT_REF:-v${RELEASE_VERSION}}"
DEPLOY_COMMIT=$RESOLVED_COMMIT
SOURCE_DIR="${TEMP_DIR}/source"
fetch_revision "$SOURCE_DIR" "$DEPLOY_COMMIT"
cmp -s "$0" "${SOURCE_DIR}/install-caddy-lxc.sh" \
    || die "This installer differs from commit ${DEPLOY_COMMIT}. Download the installer from that exact commit, or use homelab-vault-update."

for required_file in \
    Caddyfile \
    index.html \
    styles.css \
    core.js \
    app.js \
    words.js \
    qrcode.min.js \
    version.js \
    LICENSE \
    THIRD_PARTY_NOTICES.md \
    assets/vault-icon.png \
    install-caddy-lxc.sh
do
    if [ ! -f "${SOURCE_DIR}/${required_file}" ] || [ -L "${SOURCE_DIR}/${required_file}" ]; then
        die "The selected revision is missing a regular ${required_file}."
    fi
done

say "Choose this LXC's stable IPv4 address"
ip -4 -brief address show scope global

while :; do
    printf "Enter this LXC's reserved IPv4 address (without /24): "
    if ! IFS= read -r VAULT_IP </dev/tty; then
        die "No address was entered."
    fi

    if ip -4 -o address show scope global | awk -v ip="$VAULT_IP" '
        {
            split($4, address, "/")
            if (address[1] == ip) found = 1
        }
        END { exit !found }
    '; then
        break
    fi

    printf 'That address is not assigned to this LXC. Check its network settings and try again.\n' >&2
done

say "Installing Caddy from its official Debian repository"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --output "${TEMP_DIR}/caddy-key.asc" \
    'https://dl.cloudsmith.io/public/caddy/stable/gpg.key'
gpg --batch --yes --dearmor \
    --output "${TEMP_DIR}/caddy-key.gpg" \
    "${TEMP_DIR}/caddy-key.asc"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --output "${TEMP_DIR}/caddy-stable.list" \
    'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt'
grep -Eq '^[[:space:]]*deb ' "${TEMP_DIR}/caddy-stable.list" \
    || die "The downloaded Caddy repository definition is invalid."
install -o root -g root -m 0644 \
    "${TEMP_DIR}/caddy-key.gpg" \
    /usr/share/keyrings/caddy-stable-archive-keyring.gpg
install -o root -g root -m 0644 \
    "${TEMP_DIR}/caddy-stable.list" \
    /etc/apt/sources.list.d/caddy-stable.list
apt-get update
CADDY_PACKAGE_TOUCHED=1
apt-get install -y caddy

# The package starts its example site automatically. Keep a new installation
# offline until the IP-specific Homelab Vault configuration has been validated.
if [ "$CADDY_PREINSTALLED" -eq 0 ]; then
    systemctl disable --now caddy >/dev/null
fi

install -d -o root -g root -m 0755 /usr/local/sbin
UPDATE_CANDIDATE="$(mktemp "${UPDATE_COMMAND}.new.XXXXXX")"
install -o root -g root -m 0755 "${SOURCE_DIR}/install-caddy-lxc.sh" "$UPDATE_CANDIDATE"
/bin/sh -n "$UPDATE_CANDIDATE"

say "Staging the static site"
install -d -o root -g root -m 0755 /srv
SITE_STAGE="$(mktemp -d /srv/.homelab-vault.new.XXXXXX)"
chown root:caddy "$SITE_STAGE"
chmod 0750 "$SITE_STAGE"
install -o root -g caddy -m 0640 \
    "${SOURCE_DIR}/index.html" \
    "${SOURCE_DIR}/styles.css" \
    "${SOURCE_DIR}/core.js" \
    "${SOURCE_DIR}/app.js" \
    "${SOURCE_DIR}/words.js" \
    "${SOURCE_DIR}/qrcode.min.js" \
    "${SOURCE_DIR}/LICENSE" \
    "${SOURCE_DIR}/THIRD_PARTY_NOTICES.md" \
    "$SITE_STAGE/"
install -o root -g caddy -m 0640 /dev/null "${SITE_STAGE}/version.js"
printf "globalThis.VAULT_BUILD = Object.freeze({ version: '%s', commit: '%s' });\n" \
    "$RELEASE_VERSION" "$DEPLOY_COMMIT" >"${SITE_STAGE}/version.js"
install -d -o root -g caddy -m 0750 "${SITE_STAGE}/assets"
install -o root -g caddy -m 0640 \
    "${SOURCE_DIR}/assets/vault-icon.png" \
    "${SITE_STAGE}/assets/vault-icon.png"
install -o root -g root -m 0600 /dev/null "${SITE_STAGE}/${WEB_MARKER}"
printf '%s\n' 'Managed by Homelab Vault.' >"${SITE_STAGE}/${WEB_MARKER}"
install -o root -g root -m 0600 /dev/null "${SITE_STAGE}/${DEPLOYMENT_FILE}"
printf 'VERSION=%s\nCOMMIT=%s\nIP=%s\n' "$RELEASE_VERSION" "$DEPLOY_COMMIT" "$VAULT_IP" \
    >"${SITE_STAGE}/${DEPLOYMENT_FILE}"

template="${SOURCE_DIR}/Caddyfile"
placeholder_count="$(grep -Fc 'https://<LXC_IPV4> {' "$template" || true)"
guard_count="$(grep -Ec '^[[:space:]]*ip_address_must_be_configured[[:space:]]*$' "$template" || true)"
[ "$placeholder_count" -eq 1 ] || die "The Caddy template must contain exactly one IP placeholder."
[ "$guard_count" -eq 1 ] || die "The Caddy template setup guard is missing."

say "Validating the IP-specific Caddy configuration"
install -d -o root -g root -m 0755 /etc/caddy
install -d -o caddy -g caddy -m 0750 "$CADDY_HOME"
CANDIDATE_CONFIG="$(mktemp /etc/caddy/Caddyfile.homelab-vault.XXXXXX)"
{
    printf '%s\n' "$MANAGED_MARKER"
    sed \
        -e "s|^https://<LXC_IPV4> {|https://${VAULT_IP} {|" \
        -e '/^[[:space:]]*ip_address_must_be_configured[[:space:]]*$/d' \
        "$template"
} >"$CANDIDATE_CONFIG"
chown root:root "$CANDIDATE_CONFIG"
chmod 0644 "$CANDIDATE_CONFIG"

if grep -Eq '^https://<LXC_IPV4>[[:space:]]*\{|^[[:space:]]*ip_address_must_be_configured[[:space:]]*$' "$CANDIDATE_CONFIG"; then
    die "The Caddy IP setup guard remains in the rendered configuration."
fi

rendered_count="$(grep -Fxc "https://${VAULT_IP} {" "$CANDIDATE_CONFIG" || true)"
[ "$rendered_count" -eq 1 ] || die "The Caddy IP placeholder was not replaced exactly once."

runuser -u caddy -- env HOME="$CADDY_HOME" \
    /usr/bin/caddy validate --config "$CANDIDATE_CONFIG" --adapter caddyfile

say "Activating the staged site"
activate_site

CONFIG_MUTATION_BEGUN=1
mv -f -- "$CANDIDATE_CONFIG" "$CADDY_CONFIG"
CANDIDATE_CONFIG=""

say "Starting Homelab Vault"
systemctl enable caddy >/dev/null
if systemctl is-active --quiet caddy; then
    systemctl reload caddy
else
    systemctl start caddy
fi

healthy=0
attempt=0
while [ "$attempt" -lt 15 ]; do
    if [ -s "$CA_CERT" ] && curl --noproxy '*' --fail --silent --show-error --max-time 5 \
        --cacert "$CA_CERT" --head "https://${VAULT_IP}/" >/dev/null; then
        healthy=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done

if [ "$healthy" -ne 1 ]; then
    journalctl -u caddy -n 40 --no-pager >&2 || true
    die "Caddy did not pass its local HTTPS health check."
fi

# root.crt is public. Publishing it briefly makes client setup easier; the
# installer never copies or exposes Caddy's private root.key.
install -o root -g caddy -m 0640 "$CA_CERT" "$PUBLIC_CA"
digest_line="$(sha256sum "$PUBLIC_CA")"
certificate_digest="${digest_line%% *}"
mv -f -- "$UPDATE_CANDIDATE" "$UPDATE_COMMAND"
UPDATE_CANDIDATE=""
DEPLOYMENT_HEALTHY=1

if [ -n "$SITE_BACKUP" ] && [ -d "$SITE_BACKUP" ]; then
    say "Removing the previous managed site after the successful health check"
    if safe_remove_tree "$SITE_BACKUP"; then
        SITE_BACKUP=""
    else
        printf 'WARNING: The previous managed site remains at %s\n' "$SITE_BACKUP" >&2
    fi
fi

printf '\nHomelab Vault is ready.\n'
printf 'Version:     %s\nCommit:      %s\n' "$RELEASE_VERSION" "$DEPLOY_COMMIT"
printf 'Site:        https://%s\n' "$VAULT_IP"
printf 'CA download: https://%s/caddy-root.crt\n' "$VAULT_IP"
printf 'CA file SHA-256: %s\n' "$certificate_digest"
printf 'Update later: homelab-vault-update\n'
printf 'View status:  homelab-vault-update status\n'
printf 'Check tags:   homelab-vault-update check-update\n'
printf '\nTrust caddy-root.crt on every client before using the generator.\n'
printf 'Compare its SHA-256 with the value above, then remove the download with:\n'
printf '  rm -f -- %s\n' "$PUBLIC_CA"
printf 'Never copy or expose Caddy\047s root.key.\n'
