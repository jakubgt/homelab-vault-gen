<p align="center">
  <img src="assets/vault-icon.png" alt="Homelab Vault logo" width="120">
</p>

# Homelab Vault

[![Tests](https://img.shields.io/github/actions/workflow/status/jakubgt/homelab-vault-gen/tests.yml?branch=main&label=tests)](https://github.com/jakubgt/homelab-vault-gen/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An offline-first password, passphrase, username, and pattern generator for homelabs. Everything runs in the browser: there is no backend, telemetry, CDN, or outbound application request after the local assets load.

## Highlights

- Cryptographically secure randomness from `crypto.getRandomValues`, with rejection sampling to avoid modulo bias.
- Passwords that include every selected character class; custom symbol pools are validated and deduplicated.
- Exact password entropy for the class-constrained output space, plus conservative passphrase and pattern estimates.
- The full 7,776-word EFF large wordlist for passphrases and usernames.
- Printable-ASCII pattern templates such as `[A-Z]{3}-[0-9]{4}`.
- Local QR rendering and bulk TXT/CSV export with no upload.
- Paranoid Mode that stops preference persistence, hides the result, clears it when the tab loses focus, and disables file export.
- Responsive light/dark UI, keyboard-accessible tabs, reduced-motion support, and screen-reader labels.
- Hardened NGINX and Caddy examples with a strict Content Security Policy.

## Use it

1. Pick Password, Passphrase, Username, or Pattern.
2. Adjust the options. Each generation setting immediately creates one new value.
3. Select **Generate** for another value, **Copy** for the clipboard, or **Show QR** for local transfer.
4. The displayed result clears after the selected post-copy delay. The app cannot erase OS clipboard history.

Press <kbd>Space</kbd> outside a form control to generate again. The selected mode and preferences are stored in `localStorage` unless Paranoid Mode is active; generated credentials are never intentionally stored there.

## Quick start

### Open the file locally

Download or clone the repository, then open `index.html` in a current browser. This is the simplest air-gapped option. Some browsers restrict the modern clipboard API on `file://`; the app will try a legacy local fallback and report if copying fails.

### Loopback development server

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000>. This command is for same-machine use only; it does not add TLS or the production security headers.

### Docker Compose

```bash
docker compose up -d
```

Open <http://127.0.0.1:8080>. The container runs unprivileged, drops Linux capabilities, uses a read-only filesystem, and binds to loopback by default.

To change the local port:

```bash
VAULT_PORT=9000 docker compose up -d
```

To intentionally expose the container on every interface:

```bash
VAULT_BIND_ADDRESS=0.0.0.0 docker compose up -d
```

For access from other devices, put the app behind trusted HTTPS. Plain HTTP lets anyone able to modify the response replace the generator code and capture future credentials.

Useful commands:

```bash
docker compose ps
docker compose logs -f vault-gen
docker compose down
```

## HTTPS with Caddy on a fresh Debian LXC

This is the simplest LAN-only Caddy deployment: clients open the Debian LXC's reserved IPv4 address directly, so there is no local DNS or hosts-file setup. [Caddy supports IP addresses as site addresses](https://caddyserver.com/docs/caddyfile/concepts#addresses). The included `Caddyfile` contains an intentionally invalid `<LXC_IPV4>` marker. Setup requires the actual address, verifies that it belongs to the container, and replaces the marker before Caddy can start.

Caddy uses its internal CA for HTTPS. Every Windows computer, phone, tablet, or separate browser trust store that opens the site must trust this deployment's `root.crt` once. Without that import a browser may offer a certificate-warning bypass, but the connection is not authenticated and should not be used to generate credentials.

This Caddy deployment serves the files directly from `/srv/homelab-vault`; it does not use `docker-compose.yml`, which continues to run NGINX. The Debian commands below are run as `root` inside the LXC.

### 1. Create the Debian LXC and reserve its address

Before creating the container, choose one unused address on the LAN. The most direct route is a static address outside the router's DHCP pool. A typical example is `192.168.1.50/24` with gateway `192.168.1.1`, but those values must match the actual LAN. An address conflict will make the service unreliable.

In the Proxmox web interface:

1. Download a current Debian standard LXC template under the node's local storage **CT Templates** view.
2. Select **Create CT**, choose the Debian template, and create an unprivileged container. Nesting is not required. One CPU, 512 MB RAM, and 4 GB disk are ample for this static site.
3. Attach `eth0` to the LAN bridge, normally `vmbr0`.
4. Enter the static IPv4 with its CIDR suffix and the LAN gateway. Alternatively, create the CT with **DHCP**, find its generated MAC under **CT > Hardware > Network Device**, reserve the desired address for that MAC in the router, restart the CT, and confirm the reserved address before continuing.
5. Enable start-at-boot if desired, finish the wizard, start the container, and open its console.

Log in as `root` and confirm the address. Record the bare IPv4 without the CIDR suffix; for example, record `192.168.1.50`, not `192.168.1.50/24`.

```bash
ip -4 -brief address show scope global
```

The computers and phones that will use Homelab Vault must be able to reach this address on the same LAN or routed trusted VLAN. Guest Wi-Fi client isolation can prevent access.

### 2. Update Debian and install Caddy

Install the prerequisites and Caddy from its [official Debian repository](https://caddyserver.com/docs/install):

```bash
(
  set -eu
  set -o pipefail

  apt update
  apt full-upgrade -y
  apt install -y \
    apt-transport-https ca-certificates curl debian-archive-keyring \
    debian-keyring git gnupg

  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --batch --yes --dearmor \
        -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list

  apt update
  apt install -y caddy
  systemctl disable --now caddy
)
```

The official package creates the `caddy` service account and systemd service. Disabling the package's starter configuration keeps it offline, including across a reboot, until the IP-specific configuration is ready.

### 3. Download Homelab Vault

```bash
git clone --depth 1 https://github.com/jakubgt/homelab-vault-gen.git \
  /opt/homelab-vault-gen
cd /opt/homelab-vault-gen
```

### 4. Enter the LXC address and deploy

The following prompt accepts only an IPv4 address currently assigned to this container. It then installs the read-only application files and renders a normal `/etc/caddy/Caddyfile` with that literal address:

```bash
(
  set -eu
  set -o pipefail
  cd /opt/homelab-vault-gen

  ip -4 -brief address show scope global

  while true; do
    if ! read -r -p "Enter this LXC's reserved IPv4 address (without /24): " VAULT_IP; then
      printf '\nNo address entered; nothing was changed.\n'
      exit 1
    fi

    if ip -4 -o address show scope global | awk -v ip="$VAULT_IP" '
      { split($4, address, "/"); if (address[1] == ip) found = 1 }
      END { exit !found }
    '; then
      break
    fi

    echo "That address is not assigned to this LXC. Check Proxmox networking and try again."
  done

  install -d -o root -g caddy -m 0750 /srv/homelab-vault
  install -o root -g caddy -m 0640 \
    index.html styles.css core.js app.js words.js qrcode.min.js \
    /srv/homelab-vault/
  install -d -o root -g caddy -m 0750 /srv/homelab-vault/assets
  install -o root -g caddy -m 0640 assets/*.png /srv/homelab-vault/assets/

  RENDERED_CADDY="$(mktemp /etc/caddy/Caddyfile.new.XXXXXX)"
  trap 'rm -f -- "$RENDERED_CADDY"' EXIT
  sed -e "s|^https://<LXC_IPV4> {|https://${VAULT_IP} {|" \
    -e '/^[[:space:]]*ip_address_must_be_configured[[:space:]]*$/d' \
    Caddyfile > "$RENDERED_CADDY"
  chown root:root "$RENDERED_CADDY"
  chmod 0644 "$RENDERED_CADDY"

  if grep -Eq '^https://<LXC_IPV4>[[:space:]]*\{|^[[:space:]]*ip_address_must_be_configured[[:space:]]*$' "$RENDERED_CADDY"; then
    echo "The Caddy IP setup guard remains; Caddy was not changed."
    exit 1
  fi

  if ! grep -Fxq "https://${VAULT_IP} {" "$RENDERED_CADDY"; then
    echo "The Caddy IP marker was not replaced; Caddy was not changed."
    exit 1
  fi

  grep -F "https://${VAULT_IP} {" "$RENDERED_CADDY"
  runuser -u caddy -- env HOME=/var/lib/caddy \
    /usr/bin/caddy validate --config "$RENDERED_CADDY" --adapter caddyfile
  mv -f -- "$RENDERED_CADDY" /etc/caddy/Caddyfile
  trap - EXIT

  systemctl enable caddy
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    systemctl start caddy
  fi
  systemctl --no-pager --full status caddy

  systemctl is-active --quiet caddy
  curl --fail --show-error --max-time 15 --cacert \
    /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
    -I "https://${VAULT_IP}"
  printf '\nServer ready at https://%s\n' "$VAULT_IP"
)
```

The guarded block stops at the first error, validates a temporary file as Caddy's service account, and only then replaces the live configuration. It is safe to run again: an active service is reloaded, while an inactive service is started. Caddy's private CA state stays under `/var/lib/caddy`. The `skip_install_trust` global option prevents the unprivileged service from trying to modify the LXC or browser trust stores; client trust is installed manually below. If startup or reload fails, inspect the logs:

```bash
journalctl -u caddy -n 100 --no-pager
```

### 5. Limit access to the LAN

If the Proxmox firewall is enabled, add an inbound **ACCEPT** rule on this container for TCP destination port `443`, restricted to the trusted LAN CIDR. TCP `80` is optional for HTTP-to-HTTPS redirects, and UDP `443` is optional for HTTP/3. Apply equivalent rules if a Debian firewall is enabled.

Do not create router/WAN port forwards for this LAN-only service. Client devices must use the exact configured URL, such as `https://192.168.1.50`. No DNS record or hosts-file entry is needed.

### 6. Trust Caddy's CA on every client

After Caddy starts, its public root certificate is here:

```text
/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

Copy **only** `root.crt` to each client through a trusted path, such as an existing SSH/SCP connection, a USB drive, AirDrop, or a trusted local file share. The certificate is public, but its integrity matters: importing an attacker's replacement would trust that attacker.

If the fresh LXC does not yet have a file-transfer method, use this one-time, hash-verified bootstrap. In the trusted Proxmox console, temporarily publish the public certificate and note its hash:

```bash
install -o root -g caddy -m 0640 \
  /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
  /srv/homelab-vault/caddy-root.crt
sha256sum /srv/homelab-vault/caddy-root.crt
```

On Windows, enter the LXC's address when prompted and download the certificate. `--insecure` is used only for this bootstrap because the CA is not trusted yet:

```powershell
$VaultIp = Read-Host 'Enter the LXC IPv4 address'
curl.exe --insecure --fail --show-error `
  "https://$VaultIp/caddy-root.crt" `
  --output .\caddy-root.crt
certutil -hashfile .\caddy-root.crt SHA256
```

Compare the hexadecimal Windows hash with the hash still visible in the Proxmox console; capitalization and displayed whitespace do not matter. If the values differ, delete the download and do not import it. After an exact match, remove the temporary web copy from the LXC:

```bash
rm -f -- /srv/homelab-vault/caddy-root.crt
```

You can transfer that verified Windows copy to phones and other devices. Do not use Homelab Vault or bypass certificate warnings for normal browsing until the root is installed.

Never copy, expose, or import `root.key`. Anyone who obtains that private key can impersonate HTTPS sites to devices that trust this CA. Keep `/var/lib/caddy` protected and include it in the LXC's secured backups. Rebuilding the container without restoring that directory creates a new CA that must be trusted again.

#### Windows 11

Save the file as `caddy-root.crt`. Open Windows Terminal or PowerShell **as Administrator**, move to the folder containing it, compare the displayed SHA-256 hash with the LXC, and then add it to the local computer's Trusted Root Certification Authorities store:

```powershell
certutil -hashfile .\caddy-root.crt SHA256
certutil -addstore -f "Root" .\caddy-root.crt
```

Completely close and reopen the browser. The import command follows [Microsoft's documented `certutil -addstore` flow](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil).

#### iPhone or iPad

Transfer and open `root.crt`, then promptly install the downloaded profile under **Settings > General > VPN & Device Management** (or the **Profile Downloaded** prompt). Apple may remove a downloaded profile after eight minutes if it is not installed. Next, go to **Settings > General > About > Certificate Trust Settings** and enable full trust for that root. Apple requires this second trust step for manually installed roots; see Apple's [profile installation](https://support.apple.com/en-us/102400) and [certificate trust](https://support.apple.com/en-us/102390) instructions. If Stolen Device Protection blocks profile installation away from a familiar location, follow Apple's prompt and re-enable that protection afterward.

#### Android phone or tablet

Menu names and available certificate types vary by manufacturer and Android version. Save `root.crt`, search Settings for **Install a certificate**, choose **CA certificate** if offered, and select the file. On a Pixel the path begins at **Settings > Security & privacy > More security settings > Encryption & credentials**. A screen lock may be required. See [Google's certificate instructions](https://support.google.com/pixelphone/answer/2844832).

Some browsers keep a separate authority store, and some Android apps intentionally ignore user-installed CAs; Android documents this behavior in its [Network Security Configuration guide](https://developer.android.com/privacy-and-security/security-config). If the system import succeeds but a browser still warns, import `root.crt` into that browser's Authorities store as described in [Caddy's local HTTPS guidance](https://caddyserver.com/docs/running#local-https-with-systemd). Do not click through a warning for normal use.

### 7. Verify, update, and troubleshoot

On each client, open the exact address configured in Caddy. After the root import there should be no certificate warning. On Windows, this should also succeed:

```powershell
$VaultIp = Read-Host 'Enter the LXC IPv4 address'
curl.exe -I "https://$VaultIp"
```

Common failures:

- A timeout usually means the address, Proxmox/Debian firewall, VLAN routing, or Wi-Fi client isolation is wrong.
- A certificate-authority warning means `root.crt` is not trusted by that operating system or browser.
- A certificate name mismatch means the client used a different IP from the active site address.
- If the reserved IP changes, rerun step 4 with the new assigned address. Caddy will validate and reload the configuration, then issue a new leaf certificate from the same local CA.

To update the application later, pull the repository and reinstall the runtime files. Static-file changes take effect immediately:

```bash
(
  set -eu
  cd /opt/homelab-vault-gen
  git pull --ff-only
  install -o root -g caddy -m 0640 \
    index.html styles.css core.js app.js words.js qrcode.min.js \
    /srv/homelab-vault/
  install -o root -g caddy -m 0640 assets/*.png /srv/homelab-vault/assets/
)
```

If the repository's `Caddyfile` changes, rerun the entire guarded block in step 4. It prompts for the assigned IP again, validates and installs the new configuration atomically, and reloads the active service.

The `Caddyfile` also contains commented alternatives for same-machine `https://localhost` and a public domain. Enable exactly one site block and validate before every reload.

`nginx.conf` is designed for the unprivileged Docker image and its `/usr/share/nginx/html` root; it is not a drop-in host NGINX site configuration.

## Security model

### What the app provides

- Random choices come from the browser's operating-system-backed Web Crypto source.
- Generated values stay client-side unless you copy, scan, download, or otherwise share them.
- No application code makes network requests.
- Served deployments use CSP, clickjacking protection, MIME sniffing protection, restrictive Permissions Policy, and no-store caching headers.
- Password entropy counts only outputs that satisfy the selected class guarantees.

### What it cannot guarantee

- **Authentic delivery:** Remote clients must receive the HTML and JavaScript over trusted HTTPS. CSP cannot help if an attacker replaces the entire HTTP response.
- **JavaScript memory erasure:** The mutable working buffer is overwritten and the DOM is cleared on supported paths, but JavaScript strings, browser internals, QR canvases, Blobs, and garbage-collected copies cannot be proven erased.
- **Clipboard deletion:** Clipboard managers and OS history can retain copied values. The timer clears the displayed result, not the operating system's clipboard.
- **Safe endpoints:** Malware, malicious extensions, screen capture, developer tools, or a compromised browser can read generated values.
- **QR privacy:** A QR code is plaintext in visual form. Nearby people and the scanning app can read it.
- **Downloaded-file secrecy:** Bulk exports are unencrypted plaintext and may remain in download history, backups, or synced folders.
- **Universal crack time:** The meter assumes an average search at 100 billion guesses/second. Actual rates depend heavily on the target's hash, KDF, rate limits, and attacker.

For sensitive use, prefer a trusted local file or HTTPS deployment, a clean browser profile, and a password manager that can generate and store credentials directly.

## Pattern syntax

Pattern mode supports a small template language, not full regular expressions:

| Syntax | Meaning |
|---|---|
| `[A-Z]` | One character from a range |
| `[abc]` | One character from a listed set |
| `{4}` | Repeat the preceding token four times |
| `-` or `_` | Include a literal character |
| `\[` or `\{` | Include a reserved character literally |

Patterns accept printable ASCII, up to 512 input characters and 1,000 output characters. Descending ranges and zero repetitions are rejected with an inline error.

## Tests

Requires Node.js 20 or newer; there are no packages to install.

```bash
node --check core.js
node --check app.js
node --check test.js
node test.js
```

The suite imports the same `core.js` used by the browser and checks:

- deterministic rejection of biased Uint32 boundary values;
- random-integer range safety and invalid-input guards;
- symbol normalization and strict character-class guarantees, including tight edge cases;
- exact class-constrained entropy;
- valid and invalid pattern parsing;
- EFF wordlist length, format, uniqueness, and an audited sequence digest;
- CSP, QR cleanup, storage isolation, script ordering, and Docker asset integration.

GitHub Actions also checks JavaScript syntax and validates the Compose file. Dependabot is configured for monthly GitHub Actions and Docker dependency checks.

For reproducible high-assurance deployments, set `VAULT_IMAGE` to the same image pinned by a multi-platform digest (`nginxinc/nginx-unprivileged@sha256:…`) after verifying that digest in your registry.

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | Accessible browser UI and state handling |
| `core.js` | Shared RNG, password, entropy, symbol, and pattern logic |
| `words.js` | Vendored EFF large wordlist |
| `qrcode.min.js` | Vendored local QR renderer |
| `docker-compose.yml`, `nginx.conf` | Unprivileged container deployment |
| `Caddyfile` | Required-IP LAN HTTPS template and deployment alternatives |
| `test.js` | Zero-dependency production-core tests |

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source, digest, and license information for vendored assets, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Homelab Vault is released under the [MIT License](LICENSE).
