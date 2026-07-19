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

## LAN HTTPS with Caddy on a Debian LXC

This is the easiest LAN-only setup: each device opens the LXC's IPv4 address directly, such as `https://192.168.1.50`. It needs no local DNS, hostname, or hosts-file entry.

Caddy creates a private local certificate authority (CA). Each Windows computer, phone, tablet, or browser-specific trust store must trust its public `root.crt` once. Until then, the browser warning means the connection is not authenticated; do not generate credentials by clicking through it.

### Before you start

- Create and start a Debian LXC with internet access. Run the commands below as `root` inside that container.
- Give the LXC an address that will not change, either with a static address in Proxmox or a DHCP reservation in the router. The installer verifies the address you enter, but it cannot reserve it for you.
- Make sure the intended computers and phones can reach the LXC. Guest Wi-Fi isolation or VLAN firewall rules may block it.

### 1. Run the installer

Copy this block into the LXC console:

```bash
apt-get update
apt-get install -y ca-certificates curl
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --output /root/install-homelab-vault.sh \
  https://raw.githubusercontent.com/jakubgt/homelab-vault-gen/main/install-caddy-lxc.sh
chmod 0700 /root/install-homelab-vault.sh
/root/install-homelab-vault.sh
```

The installer shows the LXC's addresses and asks for the stable IPv4 address without its CIDR suffix: enter the containers IP such as `192.168.1.50`, not `192.168.1.50/24`.

It then installs Caddy from its [official Debian repository](https://caddyserver.com/docs/install), downloads Homelab Vault, validates the IP-specific configuration, enables the service, checks HTTPS locally, and prints the site URL and CA file digest. It refuses to overwrite an unrelated Caddy configuration or web root and restores the previous site and Caddy configuration if startup fails.

### 2. Allow LAN access

If the Proxmox or Debian firewall is enabled, allow inbound TCP port `443` to this LXC from the trusted LAN. UDP port `443` is optional for HTTP/3. Do not forward either port from the internet.

Use the exact URL printed by the installer, such as `https://192.168.1.50`.

### 3. Trust the CA on each device

The installer temporarily makes the public certificate available at:

```text
https://LXC_IP/caddy-root.crt
```

It also prints the public certificate file's SHA-256 digest in the trusted LXC console. The certificate is public, but verifying the file prevents you from importing an attacker's replacement. Never copy or expose `root.key`.

#### Windows 11

In PowerShell, download the certificate and display the file's SHA-256 digest. `--insecure` is used only for this first download because the CA is not trusted yet.

```powershell
$VaultIp = Read-Host 'Enter the LXC IPv4 address'
curl.exe --insecure --fail --show-error `
  "https://$VaultIp/caddy-root.crt" `
  --output .\caddy-root.crt
certutil -hashfile .\caddy-root.crt SHA256
```

Compare that value with `CA file SHA-256` still visible in the LXC console. If they differ, delete the file and do not import it. If they match, open PowerShell **as Administrator** in the same folder and run:

```powershell
certutil -addstore -f "Root" .\caddy-root.crt
```

Completely close and reopen the browser. Firefox may require a separate import under **Settings > Privacy & Security > Certificates > View Certificates > Authorities**. The Windows command follows Microsoft's [`certutil -addstore` documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil).

#### iPhone or iPad

Transfer the digest-verified `caddy-root.crt` from the Windows computer through a trusted method and open it on the device. Promptly open **Settings > Profile Downloaded** and select **Install**; Apple may remove an uninstalled downloaded profile after eight minutes. Then enable it under **Settings > General > About > Certificate Trust Settings**. If Stolen Device Protection blocks profile installation away from a familiar location, follow Apple's prompt and re-enable the protection afterward. Apple documents both [profile installation](https://support.apple.com/en-us/102400) and the required [full-trust setting](https://support.apple.com/en-us/102390).

#### Android

Transfer the same verified file to the device. Search Settings for **Install a certificate**, choose **CA certificate**, and select `caddy-root.crt`. Menu names vary by manufacturer and Android version; a screen lock may be required. Google provides [Pixel certificate instructions](https://support.google.com/pixelphone/answer/2844832).

Some browsers and apps use their own trust stores or deliberately ignore user-installed CAs. If a browser still warns, import the root into that browser's Authorities store. Caddy explains this behavior in its [local HTTPS guidance](https://caddyserver.com/docs/running#local-https-with-systemd).

After all clients are configured, remove the temporary public download from the LXC:

```bash
rm -f -- /srv/homelab-vault/caddy-root.crt
```

The original CA remains protected under `/var/lib/caddy`. Keep that directory in secured LXC backups; rebuilding without it creates a new CA that every client must trust again.

### 4. Update or change the IP

The installer creates one update command. Run it as `root` whenever the repository changes or the LXC gets a new reserved address:

```bash
homelab-vault-update
```

Enter the current LXC IPv4 address when prompted. The updater downloads the current installer, uses a fast-forward-only Git pull, stages the explicit runtime files, revalidates Caddy, and keeps the existing CA.

### Troubleshooting

```bash
systemctl --no-pager --full status caddy
journalctl -u caddy -n 100 --no-pager
```

- A timeout normally points to the IP, firewall, VLAN routing, or Wi-Fi client isolation.
- An authority warning means the CA is not trusted by that operating system or browser.
- A name-mismatch warning means the client used a different IP from the one entered during installation.
- To make the public CA download available again, rerun `homelab-vault-update`.

The repository `Caddyfile` keeps commented examples for same-machine localhost and a public domain. The installer uses the default LAN-IP block. This deployment serves files directly from `/srv/homelab-vault`; it does not use `docker-compose.yml`.

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

The suite checks the random-integer and generation guarantees, entropy calculations, pattern parsing, audited wordlist, security headers, browser integration, and deployment templates. GitHub Actions also checks the Debian installer syntax and executable bit and validates the Compose file. Dependabot is configured for monthly GitHub Actions and Docker dependency checks.

For reproducible high-assurance deployments, set `VAULT_IMAGE` to the same image pinned by a multi-platform digest (`nginxinc/nginx-unprivileged@sha256:...`) after verifying that digest in your registry.

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | Accessible browser UI and state handling |
| `core.js` | Shared RNG, password, entropy, symbol, and pattern logic |
| `words.js` | Vendored EFF large wordlist |
| `qrcode.min.js` | Vendored local QR renderer |
| `docker-compose.yml`, `nginx.conf` | Unprivileged container deployment |
| `Caddyfile` | Required-IP LAN HTTPS template and deployment alternatives |
| `install-caddy-lxc.sh` | Guided Debian LXC installation and update script |
| `test.js` | Zero-dependency production-core and integration tests |

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source, digest, and license information for vendored assets, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Homelab Vault is released under the [MIT License](LICENSE).
