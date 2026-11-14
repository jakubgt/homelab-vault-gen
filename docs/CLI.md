# Local command line

Run `node cli/vault.cjs --help` from the repository root or an extracted release with Node.js 22 or newer. Keep the neighboring `public/` directory in place; it contains the shared generation core, version metadata, and wordlist. No npm installation, server, or network access is required. This command uses the same cryptographic core and EFF wordlist as the browser app.

```bash
node cli/vault.cjs password --length 32
node cli/vault.cjs password --config-friendly --count 5
node cli/vault.cjs passphrase --words 6
node cli/vault.cjs username --words 2 --lowercase --separator -
node cli/vault.cjs pattern --template '[A-Z]{3}-[0-9]{4}'
node cli/vault.cjs raw --bytes 32 --encoding base64
```

Standard output contains only exact generated values, one per line, with a final newline. Errors go to standard error and produce a nonzero exit status. `--count` accepts 1–1,000 results. Pattern output is limited to 1,000 characters per result; total output is limited to 1 MiB. Invalid options are rejected rather than silently ignored. `--version` prints the package version.

For raw secrets, `--bytes` accepts 32 (256 bits) or 64 (512 bits), and `--encoding` accepts `hex`, `base64`, or unpadded `base64url`. These are uniformly random bytes encoded for storage. Select a format required by the target application; this command does not create SSH private keys, signed JWTs, or algorithm-specific key pairs.

Generation templates describe random character classes and fixed public literals. Never enter an existing password, token, or other secret as a command argument: arguments can appear in process listings and shell history. `pattern --template-stdin` reads one template from standard input (one final line ending is removed). It does not echo that template on errors. Do not use it to transform existing credentials.

Output is plaintext. Use a trusted terminal and direct pipes to a trusted consumer when possible. Redirected files, terminal scrollback, shell transcripts, backups, and downstream programs can retain it. The CLI does not save preferences or copy to the clipboard. JavaScript strings, stream buffers, and OS copies cannot be proven erased, even though the mutable generation buffer is overwritten.
