'use strict';

// A loopback-only test server using the actual nginx deployment headers.
// Only production assets are served; development files and directory traversal are denied.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const nginx = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8');
const headers = Object.fromEntries(
    [...nginx.matchAll(/^\s*add_header\s+(\S+)\s+"([^"]+)"\s+always;/gm)]
        .map((match) => [match[1], match[2]])
);
if (!headers['Content-Security-Policy']) throw new Error('nginx.conf must define the test CSP.');

const publicFiles = new Map([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/core.js', 'text/javascript; charset=utf-8'],
    ['/version.js', 'text/javascript; charset=utf-8'],
    ['/words.js', 'text/javascript; charset=utf-8'],
    ['/qrcode.min.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/LICENSE', 'text/plain; charset=utf-8'],
    ['/THIRD_PARTY_NOTICES.md', 'text/plain; charset=utf-8'],
    ['/assets/vault-icon.png', 'image/png'],
]);

const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const resource = pathname === '/' ? '/index.html' : pathname;
    const contentType = publicFiles.get(resource);
    if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
        response.end();
        return;
    }
    if (!contentType) {
        response.writeHead(404, headers);
        response.end();
        return;
    }
    fs.readFile(path.join(root, resource.slice(1)), (error, content) => {
        if (error) {
            response.writeHead(404, headers);
            response.end();
            return;
        }
        response.writeHead(200, { ...headers, 'Content-Type': contentType });
        response.end(request.method === 'HEAD' ? undefined : content);
    });
});

server.listen(4173, '127.0.0.1', () => {
    console.log('Browser test server listening at http://127.0.0.1:4173');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
