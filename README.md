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

## HTTPS with Caddy

The included `Caddyfile` defaults to LAN access at `https://vault.lan` using Caddy's internal CA. It serves the app directly from `/srv/homelab-vault` and sends the same CSP and privacy headers as the Docker NGINX configuration. This is a separate deployment method: `docker-compose.yml` still runs NGINX and does not use the `Caddyfile`.

The commands below assume Caddy's official Linux package and `caddy` systemd service. See [Caddy's install guide](https://caddyserver.com/docs/install) first if Caddy is not installed.

### 1. Configure the LAN hostname

Give the Caddy host a stable LAN address, preferably with a DHCP reservation. Add an A/AAAA record for `vault.lan` to your local DNS, or add the following entry to every client's hosts file, replacing the example address with the server's LAN address:

```text
192.168.1.50 vault.lan
```

Hosts files are normally `/etc/hosts` on Linux and macOS and `%SystemRoot%\System32\drivers\etc\hosts` on Windows. Phones and tablets generally need local DNS instead. Open the site by its exact hostname, not by IP address. `vault.lan` is a conventional private name; `vault.home.arpa` is the standards-based alternative for a new home DNS zone.

### 2. Install the app and start Caddy

From a checked-out repository, install only the runtime files into a web root that the Caddy account cannot modify:

```bash
sudo install -d -o root -g caddy -m 0750 /srv/homelab-vault
sudo install -o root -g caddy -m 0640 \
  index.html styles.css core.js app.js words.js qrcode.min.js \
  /srv/homelab-vault/
sudo install -d -o root -g caddy -m 0750 /srv/homelab-vault/assets
sudo install -o root -g caddy -m 0640 assets/*.png /srv/homelab-vault/assets/
sudo install -o root -g root -m 0644 Caddyfile /etc/caddy/Caddyfile
sudo -u caddy -H caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl --no-pager --full status caddy
```

For later changes, validate first and use `sudo systemctl reload caddy` rather than stopping the service. If startup or reload fails, inspect `sudo journalctl -u caddy -n 50 --no-pager`.

### 3. Trust Caddy's local CA

After the first successful start, securely copy **only** this certificate from the Caddy host to every client:

```text
/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

That path is the default for Caddy's official systemd service. Import `root.crt` as a trusted root CA in each operating system or browser that will open the site; some browsers use their own trust store. On the Caddy host itself, `sudo caddy trust` installs the CA into the host trust store. See [Caddy's local HTTPS instructions](https://caddyserver.com/docs/running#local-https-with-systemd) for details.

Verify the certificate's SHA-256 fingerprint on the server and client over a separate trusted channel before importing it:

```bash
openssl x509 -in root.crt -noout -sha256 -fingerprint
```

Never copy or expose `root.key`: possession of the CA private key would allow someone to impersonate trusted sites to clients that installed this CA. Do not bypass browser certificate warnings; fix name resolution and CA trust instead.

Once DNS and trust are configured, verify the site:

```bash
curl --cacert root.crt -I https://vault.lan
```

Allow inbound TCP 443 only from trusted LAN networks. TCP 80 is optional for Caddy's HTTP-to-HTTPS redirect, and UDP 443 is optional for HTTP/3. No public DNS record or WAN port forwarding is required for this LAN-only setup.

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
| `Caddyfile` | HTTPS deployment examples |
| `test.js` | Zero-dependency production-core tests |

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source, digest, and license information for vendored assets, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Homelab Vault is released under the [MIT License](LICENSE).
