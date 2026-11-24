# Remote Hosts Compare & Sync

FTP / FTPS / SFTP for VS Code, inspired by the "Remote Host" tool window known from PHP IDEs.
Not affiliated with or endorsed by JetBrains or Microsoft.

- Remote tree with size and date, upload / download for files and folders, new / rename / delete
- **Sync with Local**: compare a remote folder with your local project, shows changed / only local / only remote files, diff per file, upload or download per entry
- **Compare Servers**: Test against Live, no local folder involved
- Edit Remote File (save uploads), Upload on save (per server), Select Opened File in Remote Host
- SSH session in a remote folder (SFTP), status bar server switcher

## Setup
1. Open your project folder.
2. Activity Bar -> Remote Host -> **Manage Servers** (gear icon), add a server. Passwords go to the system keychain.
   Settings are stored in `.vscode/remote-hosts.json` (no passwords).
3. `localPath` is relative to the workspace folder, `remotePath` is the server folder it maps to.

Example `.vscode/remote-hosts.json`:
```json
{
  "servers": [{
    "name": "Live", "protocol": "sftp", "host": "example.com", "port": 22,
    "username": "deploy", "privateKeyPath": "~/.ssh/id_ed25519",
    "localPath": ".", "remotePath": "/var/www/html",
    "exclude": [".git", "node_modules"], "uploadOnSave": false
  }]
}
```
Protocols: `sftp` (recommended), `ftps` (certificate is verified, set `"allowSelfSigned": true` only for servers you trust), `ftp` (**unencrypted**, avoid on untrusted networks).

Works on Windows, macOS and Linux. The SSH session needs an `ssh` client in your PATH (built into Windows 10/11). The extension requires a trusted workspace because the server list lives in the workspace.

Exclude patterns: `.git`, `*.log` (name at any depth), `cache/**`, `/uploads` (path from the root).
Set `"useGitignore": true` to also exclude everything from the `.gitignore` in the server's local folder (negations `!` are not supported).

Authentication: password (keychain), private key (`privateKeyPath`, the passphrase goes into the password field) or the SSH agent (`"useAgent": true`, SFTP only). SFTP host keys are verified: the first connection asks you to confirm the fingerprint, a changed key triggers a warning ("Remote Host: Gespeicherte SFTP-Host-Keys löschen" resets this).

Transfers, comparisons and errors are logged in the Output panel ("Remote Host", command "Remote Host: Protokoll anzeigen"). SFTP uploads keep the local modification time, so later comparisons do not have to download unchanged files again.

## Development
`npm install`, `npm test` (integration tests need `cd test-fixtures && docker compose up -d`), F5 to debug.
Install permanently: `npm run package`, then "Extensions: Install from VSIX...".
