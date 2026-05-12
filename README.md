# 🔐 Homelab Vault: Secure Offline Password & Passphrase Generator

A hyper-secure, offline password and diceware generator built specifically for self-hosting in a homelab environment. 

Unlike many online generators or complex Webpack-compiled tools, this generator uses pure Vanilla JavaScript and relies strictly on the Web Crypto API. It has been architecturally hardened to support a bulletproof Content Security Policy (CSP) with zero inline scripts or styles. It is designed to be hosted locally, completely air-gapped from the internet, with zero external dependencies, CDNs, or trackers.

<p align="center">
  <img src="Preview.png" alt="Project Preview" width="600">
</p>

## ✨ Features

* **True Cryptographic Security:** Uses `window.crypto.getRandomValues` combined with **Rejection Sampling** to completely eliminate modulo bias, ensuring perfect uniform distribution of characters.
* **Passphrase / Diceware Mode:** Generate highly memorable, mathematically secure passphrases using a built-in dictionary, complete with custom separators, capitalization, and number injection.
* **Character Class Guarantees:** Enforces enterprise-grade security by guaranteeing at least one character from every selected set (Uppercase, Lowercase, Numbers, Symbols) is included in the final password.
* **Real-Time Entropy Meter:** Accurately calculates true bit-entropy using the following formula:
  $$H = L \cdot \log_{2}(N)$$
  Where $L$ is length and $N$ is the charset size.
* **Paranoid Mode & Memory Wiping:**
  * Blurs the password on-screen until hovered.
  * Auto-clears the DOM if you switch browser tabs or close the window.
  * Disables all `localStorage` saving.
* **Strict Content Security Policy (CSP):** The application is strictly separated into HTML, CSS, and JS files, allowing web servers to ban all `'unsafe-inline'` executions.
* **Persistent Settings:** (When Paranoid Mode is off) Uses local browser storage to securely remember your preferred theme, timer, toggles, and lengths.

---

## 🛡️ Threat Model

To ensure this tool fits your security requirements, please review its intended scope.

### This project PROTECTS against:
* **Weak PRNGs:** Uses OS-level entropy to eliminate predictable patterns.
* **Online Leakage:** Your passwords never touch a network or a remote server.
* **CDN Compromise:** Zero external dependencies means no "supply chain" script injections.
* **Interception:** Since all logic is local, secrets cannot be sniffed in transit.

### This project does NOT protect against:
* **Compromised Browsers:** A hijacked browser can see everything you generate.
* **OS-Level Malware:** Keyloggers or screen-recorders bypass all web-app security.
* **Clipboard History:** Clipboard auto-clear is "best-effort"; OS managers may still retain copies.
* **Malicious Extensions:** Some browser extensions can read the data on your screen.

---

## 🖥️ Quick Start (Docker, Windows, Mac)

Because this application relies entirely on client-side code with zero external dependencies, it is incredibly easy to deploy.

### Method 1: Local File Execution (Air-Gapped, easiest)
You do not need a web server at all to use this securely.

1. Download the repository folder to your Windows or Mac machine.
2. Unzip the contents of the repository
3. Double-click index.html to open it directly in your web browser (Chrome, Edge, Safari, Firefox).

The Web Crypto API works perfectly in this local file:/// context, ensuring maximum offline security.

### Method 2: Docker Compose (Homelab Standard - Recommended)
The repository includes a hardened NGINX configuration and a `docker-compose.yml` file. This drops all container privileges, mounts the files as read-only, and applies strict security headers.

1. Clone or download the repository.
2. Navigate to the folder in your terminal.
3. Run:
   ```bash
   docker compose up -d
   ```
4. Access the generator at http://localhost (or your server's IP)

### Method 3: Python Local Server (Quick Network Access)
If you want to quickly host the generator on your machine so other local devices can access it:

Open your Terminal or Command Prompt.

Navigate to the repository folder.

Run the built-in HTTP server:
   ```bash
   python3 -m http.server 8000
   ```

---

### 🚀 Advanced Deployment (Debian/Ubuntu LXC via NGINX)
It is highly recommended to host this on a dedicated, unprivileged LXC container using NGINX to take advantage of the strict CSP headers.

1. Prepare the Environment
Update your system and install NGINX and Git:
```bash
apt update && apt upgrade -y
apt install nginx git ufw -y
```

### 2. Deploy the Code
```bash
echo "Clearing old files and pulling your custom generator..."
rm -rf /var/www/html/*

git clone https://github.com/jakubgt/homelab-vault-gen.git /tmp/passgen

# Move all files and clean up
cp -r /tmp/passgen/* /var/www/html/
rm -rf /tmp/passgen

echo "Deployment complete!"
```

### 3. Lock Down Permissions
Ensure the web server can only read the files, never modify it:
```bash
chown -R www-data:www-data /var/www/html
find /var/www/html -type d -exec chmod 555 {} \;
find /var/www/html -type f -exec chmod 444 {} \;
```

### 4. Hardening (Optional but Recommended)
For maximum security, configure NGINX to drop its version number, add isolation headers, and enforce a strict Content Security Policy tailored for this split-file app:
```bash
# Hide NGINX version number
sed -i 's/# server_tokens off;/server_tokens off;/g' /etc/nginx/nginx.conf

# Add security headers and strict CSP
cat << 'EOF' > /etc/nginx/conf.d/security.conf
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "clipboard-read=(), clipboard-write=(self)" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';" always;
EOF

nginx -t && systemctl restart nginx
```

### 5. Lock down the firewall to only accept web traffic:
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 80/tcp
ufw enable
```
> 💡 **LXC/Proxmox Note:** If running in an unprivileged container, the included Docker config uses `network_mode: host`. This ensures the web server can bind to the network correctly without complex bridge configurations.

## 🧠 Why Build This?
Many open-source password generators are either bloated with frameworks, pull external fonts/scripts from CDNs, or use naive generation logic (like standard modulo math) that introduces cryptographic bias.

This project strips everything away to leave only the bare essentials: mathematically sound rejection sampling wired to a bulletproof, indestructible UI. It's the perfect utility to embed in a local network for generating secure credentials for new Docker containers, VMs, or databases.

## 📄 License
This project is open-source and available under the MIT License. Feel free to fork, modify, and host it in your own labs!
