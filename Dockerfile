ARG BASE_IMAGE=nginxinc/nginx-unprivileged:1.31.7-alpine
FROM ${BASE_IMAGE}

ARG VAULT_VERSION=source
ARG VAULT_COMMIT=source
LABEL org.opencontainers.image.title="Homelab Vault" \
      org.opencontainers.image.description="Offline-first, self-contained credential generator" \
      org.opencontainers.image.source="https://github.com/jakubgt/homelab-vault-gen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VAULT_VERSION}" \
      org.opencontainers.image.revision="${VAULT_COMMIT}"

USER root
RUN rm -rf /usr/share/nginx/html/*
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css core.js app.js words.js qrcode.min.js version.js LICENSE THIRD_PARTY_NOTICES.md manifest.webmanifest /usr/share/nginx/html/
COPY assets/vault-icon.png assets/icon-192.png assets/icon-512.png /usr/share/nginx/html/assets/
RUN case "$VAULT_COMMIT" in source) ;; *) \
      printf '%s' "$VAULT_COMMIT" | grep -Eq '^[0-9a-f]{40}$' && \
      printf '%s' "$VAULT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && \
      printf "'use strict';\nglobalThis.VAULT_BUILD = Object.freeze({ version: '%s', commit: '%s' });\n" "$VAULT_VERSION" "$VAULT_COMMIT" > /usr/share/nginx/html/version.js ;; \
    esac
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
