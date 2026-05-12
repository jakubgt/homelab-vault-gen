# 🔐 Homelab Vault: Secure Offline Password Generator

A hyper-secure, single-file offline password generator built specifically for self-hosting in a homelab environment. 

Unlike many online generators or complex Webpack-compiled tools, this generator uses pure Vanilla JavaScript and relies strictly on the Web Crypto API (`window.crypto.getRandomValues`) for OS-level entropy. It is designed to be hosted locally, completely air-gapped from the internet, with zero external dependencies or trackers.

![UI Preview](Preview.png)

## ✨ Features

* **True Cryptographic Security:** Uses `window.crypto.getRandomValues` instead of `Math.random()` or outdated ARC4 PRNGs.
* **Maximum Entropy:** Defaults to 20 characters and features an expanded 29-character symbol pool (`!@#$%^&*()-_=+[]{};:,.<>/?|~`).
* **Zero Dependencies:** No React, no Webpack, no external CDNs, and no telemetry. Just one clean `index.html` file containing HTML, CSS, and JS.
* **Air-Gap Ready:** Runs 100% client-side in the browser.
* **Modern UI:** Clean dark mode interface.
* **1-Click Copy:** Native clipboard API integration with visual feedback.

---

## 🚀 Deployment (Debian/Ubuntu LXC via NGINX)

Because this is a static, single-file application, it requires almost zero system resources. It is highly recommended to host this on a dedicated, unprivileged LXC container using NGINX.

### 1. Prepare the Environment
Update your system and install NGINX:
```bash
apt update && apt upgrade -y
apt install nginx git ufw -y
```

### 2. Deploy the Code
```bash
# 2. Deploy the Code
echo "Clearing old files and pulling your custom generator..."
rm -rf /var/www/html/*

# Clone your specific repository
git clone https://github.com/jakubgt/homelab-vault-gen.git /tmp/passgen

# Move the file and clean up
cp /tmp/passgen/index.html /var/www/html/index.html
rm -rf /tmp/passgen

echo "Deployment complete!"
```

### 3. Lock Down Permissions
Ensure the web server can only read the file, never modify it:
```bash
chown -R www-data:www-data /var/www/html
find /var/www/html -type d -exec chmod 555 {} \;
find /var/www/html -type f -exec chmod 444 {} \;
```

### 4. Hardening (Optional but Recommended)
For maximum security, configure NGINX to drop its version number and add security headers:
```bash
echo 'add_header X-Frame-Options "DENY";' > /etc/nginx/conf.d/security.conf
echo 'add_header X-Content-Type-Options "nosniff";' >> /etc/nginx/conf.d/security.conf
echo 'add_header X-XSS-Protection "1; mode=block";' >> /etc/nginx/conf.d/security.conf
nginx -t && systemctl restart nginx
```

### 5. Lock down the firewall to only accept web traffic:
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 80/tcp
ufw enable
```

## 🧠 Why Build This?
Many open-source password generators are either bloated with frameworks, pull external fonts/scripts from CDNs, or use legacy math functions that do not provide cryptographically secure pseudorandom numbers (CSPRNG).

This project strips everything away to leave only the bare essentials: a mathematically sound window.crypto algorithm wired to a simple, indestructible UI. It's the perfect utility to embed in a local network for generating passwords for new Docker containers, VMs, or databases.

## 📄 License
This project is open-source and available under the MIT License. Feel free to fork, modify, and host it in your own labs!
