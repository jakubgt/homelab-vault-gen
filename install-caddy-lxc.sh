#!/bin/sh

set -eu
umask 077

REPO_URL="https://github.com/jakubgt/homelab-vault-gen.git"
INSTALL_DIR="/opt/homelab-vault-gen"
WEB_ROOT="/srv/homelab-vault"
WEB_MARKER=".homelab-vault-managed"
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
        /srv/.homelab-vault.new.*|\
        /srv/.homelab-vault.failed.*|\
        /srv/.homelab-vault.previous.*)
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
    printf '\nInstallation failed after changing the site; restoring the previous files.\n' >&2

    if [ "$HAD_WEB_ROOT" -eq 1 ] && [ -d "$SITE_BACKUP" ]; then
        if [ -e "$WEB_ROOT" ] || [ -L "$WEB_ROOT" ]; then
            failed_site="/srv/.homelab-vault.failed.$$"
            if [ -e "$failed_site" ] || [ -L "$failed_site" ]; then
                site_restore_failed=1
            elif ! mv -- "$WEB_ROOT" "$failed_site"; then
                site_restore_failed=1
            fi
        fi

        if [ "$site_restore_failed" -eq 0 ] && ! mv -- "$SITE_BACKUP" "$WEB_ROOT"; then
            site_restore_failed=1
        fi
    elif [ "$HAD_WEB_ROOT" -eq 1 ]; then
        [ -d "$WEB_ROOT" ] || site_restore_failed=1
    elif [ -d "$WEB_ROOT" ] && [ -f "${WEB_ROOT}/${WEB_MARKER}" ]; then
        failed_site="/srv/.homelab-vault.failed.$$"
        if [ -e "$failed_site" ] || ! mv -- "$WEB_ROOT" "$failed_site"; then
            site_restore_failed=1
        fi
    fi

    if [ -n "$failed_site" ] && [ -d "$failed_site" ]; then
        safe_remove_tree "$failed_site" || site_restore_failed=1
    fi

    if [ "$site_restore_failed" -ne 0 ]; then
        printf 'WARNING: Automatic site rollback failed. Recovery files were kept under /srv.\n' >&2
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

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

[ "$(id -u)" -eq 0 ] || die "Run this installer as root inside the Debian LXC."
[ -r /etc/os-release ] || die "Cannot identify this operating system."

# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "debian" ] || die "This installer supports Debian LXC containers only."
[ -d /run/systemd/system ] || die "This container is not running systemd."

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

say "Downloading or updating Homelab Vault"
if [ -d "${INSTALL_DIR}/.git" ]; then
    origin="$(git -C "$INSTALL_DIR" remote get-url origin)"
    case "$origin" in
        https://github.com/jakubgt/homelab-vault-gen|\
        https://github.com/jakubgt/homelab-vault-gen.git|\
        git@github.com:jakubgt/homelab-vault-gen.git) ;;
        *) die "${INSTALL_DIR} is linked to an unexpected Git repository: ${origin}" ;;
    esac

    branch="$(git -C "$INSTALL_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    [ "$branch" = "main" ] || die "${INSTALL_DIR} must be on the main branch."
    [ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ] \
        || die "${INSTALL_DIR} has local changes. Save or remove them before updating."
    git -C "$INSTALL_DIR" pull --ff-only origin main
elif [ -e "$INSTALL_DIR" ]; then
    die "${INSTALL_DIR} already exists but is not the Homelab Vault Git clone."
else
    git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi

for required_file in \
    Caddyfile \
    index.html \
    styles.css \
    core.js \
    app.js \
    words.js \
    qrcode.min.js \
    assets/vault-icon.png \
    install-caddy-lxc.sh
do
    [ -f "${INSTALL_DIR}/${required_file}" ] \
        || die "The repository is missing ${required_file}."
done

install -d -o root -g root -m 0755 /usr/local/sbin
UPDATE_CANDIDATE="$(mktemp "${UPDATE_COMMAND}.new.XXXXXX")"
{
    printf '%s\n' '#!/bin/sh' '' 'set -eu' 'umask 077' ''
    printf '%s\n' 'installer="$(mktemp /tmp/homelab-vault-update.XXXXXX)"'
    printf '%s\n' 'cleanup() {' '    rm -f -- "$installer"' '}'
    printf '%s\n' 'trap cleanup EXIT' "trap 'exit 130' HUP INT TERM" ''
    printf '%s\n' "curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --output \"\$installer\" https://raw.githubusercontent.com/jakubgt/homelab-vault-gen/main/install-caddy-lxc.sh"
    printf '%s\n' 'chmod 0700 "$installer"' '"$installer"'
} >"$UPDATE_CANDIDATE"
/bin/sh -n "$UPDATE_CANDIDATE"
chown root:root "$UPDATE_CANDIDATE"
chmod 0755 "$UPDATE_CANDIDATE"
mv -f -- "$UPDATE_CANDIDATE" "$UPDATE_COMMAND"
UPDATE_CANDIDATE=""

say "Staging the static site"
install -d -o root -g root -m 0755 /srv
SITE_STAGE="$(mktemp -d /srv/.homelab-vault.new.XXXXXX)"
chown root:caddy "$SITE_STAGE"
chmod 0750 "$SITE_STAGE"
install -o root -g caddy -m 0640 \
    "${INSTALL_DIR}/index.html" \
    "${INSTALL_DIR}/styles.css" \
    "${INSTALL_DIR}/core.js" \
    "${INSTALL_DIR}/app.js" \
    "${INSTALL_DIR}/words.js" \
    "${INSTALL_DIR}/qrcode.min.js" \
    "$SITE_STAGE/"
install -d -o root -g caddy -m 0750 "${SITE_STAGE}/assets"
install -o root -g caddy -m 0640 \
    "${INSTALL_DIR}/assets/vault-icon.png" \
    "${SITE_STAGE}/assets/vault-icon.png"
install -o root -g root -m 0600 /dev/null "${SITE_STAGE}/${WEB_MARKER}"
printf '%s\n' 'Managed by Homelab Vault.' >"${SITE_STAGE}/${WEB_MARKER}"

template="${INSTALL_DIR}/Caddyfile"
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
if [ -d "$WEB_ROOT" ]; then
    SITE_BACKUP="/srv/.homelab-vault.previous.$$"
    [ ! -e "$SITE_BACKUP" ] && [ ! -L "$SITE_BACKUP" ] \
        || die "Temporary backup path already exists: ${SITE_BACKUP}"
fi
SITE_MUTATION_BEGUN=1
[ -z "$SITE_BACKUP" ] || mv -- "$WEB_ROOT" "$SITE_BACKUP"
mv -- "$SITE_STAGE" "$WEB_ROOT"
SITE_STAGE=""

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
printf 'Site:        https://%s\n' "$VAULT_IP"
printf 'CA download: https://%s/caddy-root.crt\n' "$VAULT_IP"
printf 'CA file SHA-256: %s\n' "$certificate_digest"
printf 'Update later: homelab-vault-update\n'
printf '\nTrust caddy-root.crt on every client before using the generator.\n'
printf 'Compare its SHA-256 with the value above, then remove the download with:\n'
printf '  rm -f -- %s\n' "$PUBLIC_CA"
printf 'Never copy or expose Caddy\047s root.key.\n'
