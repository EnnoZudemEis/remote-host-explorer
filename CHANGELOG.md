# Changelog

## 0.1.3
- Security: FTPS now verifies the server certificate by default. New per-server option `allowSelfSigned` for self-signed certificates.
- SSH session: started via `ssh` with arguments instead of a shell string, so it also works in PowerShell/cmd on Windows.
- Fix: `~` in the SSH private key path is now expanded (Windows: `~\.ssh\id_ed25519` works too).
- Extension is bundled into a single file, no platform-specific binaries in the package.
- Declares that it needs a trusted, local workspace.

## 0.1.2
- Packaging fixes (icon, license).

## 0.1.1
- Remote file editing, upload on save, status bar server switcher.

## 0.1.0
- First release: remote tree, upload/download, folder compare, server compare.
