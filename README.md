# Remote Hosts Compare & Sync

Browse FTP, FTPS and SFTP servers from VS Code, **compare them with your local project (or with each other, e.g. Test against Live)** and copy only what changed, with a preview and an optional backup.

Inspired by the "Remote Host" tool window known from PHP IDEs. Not affiliated with or endorsed by JetBrains or Microsoft.

## Contents
- [Features](#features) · [Quick start](#quick-start) · [Server settings](#server-settings) · [Signing in](#signing-in)
- [Jump host](#jump-host-bastion) · [Comparing and syncing](#comparing-and-syncing) · [More features](#more-features) · [Security](#security)
- [Troubleshooting](#troubleshooting) · [FAQ](#faq) · [Known limitations](#known-limitations) · [Development](#development)

## Features
- **Remote tree** with size and date: upload, download, new file/folder, rename, delete, copy path, change permissions (chmod).
- **Compare with local**: shows what is changed, only local, only remote, in conflict or unreadable. Diff per file, upload or download per entry.
- **Compare two servers** (Test against Live), no local folder involved.
- **Safe bulk transfers**: upload or download a folder, a status group or everything visible, always with confirmation, a **preview (dry run)**, a warning when the target is newer, progress and cancel.
- **Optional backup** of every file that is overwritten or deleted.
- **Streamed transfers** (large files do not fill your memory) written under a temporary name first, so an interrupted transfer never leaves a half file.
- **Edit remote files** directly (save uploads), **upload on save** per server, **search files on the server**.
- **SSH terminal** in a remote folder (SFTP servers).
- Passwords in the system keychain, SFTP **host key verification**, optional SSH agent.
- English interface with a German translation (shown automatically when VS Code runs in German).

## Quick start
1. Open your project folder in VS Code (a local workspace folder is required).
2. Click the **Remote Host** icon in the Activity Bar, then the gear icon (**Manage Servers**) and add a server. Passwords are stored in the system keychain, never in a file.
3. The server appears in the tree. Use the toolbar icons or right-click:
   - **Compare Local Files with Server** shows the differences in the *Differences* view.
   - Click a file there to open a diff, use the inline icons to upload or download it.
   - Right-click a file or folder in the VS Code Explorer and choose **Upload Here** to send it to one or more servers.

The settings are stored in `.vscode/remote-hosts.json` (without passwords). `localPath` is relative to the workspace folder, `remotePath` is the server folder it maps to.

```json
{
  "servers": [
    {
      "name": "Test", "protocol": "sftp", "host": "test.example.com",
      "username": "deploy", "privateKeyPath": "~/.ssh/id_ed25519",
      "localPath": ".", "remotePath": "/var/www/test",
      "exclude": [".git", "node_modules"], "useGitignore": true
    },
    {
      "name": "Live", "protocol": "sftp", "host": "${env:LIVE_HOST}",
      "username": "${env:LIVE_USER}", "useAgent": true,
      "localPath": ".", "remotePath": "/var/www/html",
      "exclude": [".git", "node_modules"], "backupBeforeOverwrite": true
    }
  ]
}
```

The file has a JSON schema, so VS Code offers autocomplete and flags typos in option names.

## Server settings
All options of `.vscode/remote-hosts.json` (also available in the **Manage Servers** form):

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | – | Unique display name, e.g. `Test` or `Live`. |
| `protocol` | `sftp` \| `ftp` \| `ftps` | – | `sftp` is recommended. `ftps` is FTP over TLS. `ftp` is **unencrypted**. |
| `host` | string | – | Host name or IP address. |
| `port` | number | 22 (sftp), 21 (ftp, ftps) | Port. |
| `username` | string | – | Login name. |
| `privateKeyPath` | string | – | SFTP: private key, e.g. `~/.ssh/id_ed25519`. If the key has a passphrase, enter it in the password field of the form. |
| `useAgent` | boolean | `false` | SFTP: sign in with the running SSH agent, no password needed. |
| `jumpHost` | object | none | SFTP: connect through a jump host (bastion), like OpenSSH `ProxyJump`. Fields: `host`, `username` (both required), `port` (default 22), `privateKeyPath`, `useAgent`. See [Jump host](#jump-host-bastion). |
| `localPath` | string | – | Local folder relative to the workspace, e.g. `.`. |
| `remotePath` | string | – | Server folder the local folder maps to, e.g. `/var/www/html`. |
| `exclude` | string[] | none | Patterns that are ignored. `.git` and `*.log` match names at any depth. Patterns with a slash like `cache/**` or `/uploads` match the path from the compared root. |
| `useGitignore` | boolean | `false` | Also exclude everything from the `.gitignore` in the local folder (negations with `!` are not supported). |
| `uploadOnSave` | boolean | `false` | Upload a file to this server whenever you save it. Works for every server that has it enabled. |
| `backupBeforeOverwrite` | boolean | `false` | Copy files that are overwritten or deleted by a transfer to `.vscode/remote-host-backup/<server>/<timestamp>/` first. Add that folder to your `.gitignore`. |
| `ignoreLineEndings` | boolean | `false` | Treat files that differ only in line endings (CRLF vs LF) as equal when comparing (text files up to 5 MB). |
| `allowSelfSigned` | boolean | `false` | FTPS only: accept self-signed certificates. Insecure, only for servers you trust. |
| `timeOffsetMinutes` | number | `0` | FTP servers that report times without a timezone: minutes added to the server times. |

**Environment variables:** `host`, `username`, `localPath`, `remotePath` and `privateKeyPath` (and `host`, `username`, `privateKeyPath` of `jumpHost`) may contain `${env:NAME}`. This lets you share the file without personal values. Variables that are not set are reported in the output channel.

## Signing in
- **Password:** asked once and stored in the system keychain. If a stored password stops working, you are asked again.
- **Private key:** set `privateKeyPath`. A key passphrase goes into the password field.
- **SSH agent:** set `useAgent` (SFTP). The extension uses `SSH_AUTH_SOCK` (Windows: the OpenSSH agent pipe).
- **SFTP host keys:** the first connection to a server shows its fingerprint (SHA256) and asks whether to trust it. If the key of a known server changes, you get a clear warning, because this can be an attack. Accepted keys are stored in the extension, not in the workspace. **Remote Host: Delete Saved SFTP Host Keys** forgets them.
- **FTPS:** the server certificate is verified. Use `allowSelfSigned` only for servers you trust.

### Jump host (bastion)
If your server is only reachable through an SSH gateway, add a `jumpHost` to the (SFTP) server:

```json
{
  "name": "Live", "protocol": "sftp", "host": "10.0.0.5", "username": "deploy",
  "jumpHost": { "host": "bastion.example.com", "username": "jane", "useAgent": true },
  "localPath": ".", "remotePath": "/var/www/html"
}
```
The extension first connects to the jump host and tunnels the connection to `host` through it. Both hosts are verified: you confirm the host key of the jump host and of the server. The jump host signs in with `privateKeyPath`, the SSH agent (`useAgent`) or a password that you are asked for once (stored in the system keychain). Keys with a passphrase are not supported for the jump host, use the agent for them. The form of **Manage Servers** has a *Jump host* section. FTP and FTPS servers cannot use a jump host.

## Comparing and syncing
**Compare Local Files with Server** (toolbar of the remote tree, or right-click a folder) and **Compare Servers** open the *Differences* view.

| Badge | Meaning |
|---|---|
| `M` | Changed (both sides have the file, content differs). The label tells which side is newer. |
| `L` | Only local (on server A when comparing two servers). |
| `R` | Only on the server (on server B when comparing two servers). |
| `C` | Type conflict: a file on one side, a folder on the other. Resolve it manually. |
| `!` | Unreadable: the folder could not be listed and was **not compared**. It is never transferred. |
| `=` | Unchanged (hidden by default, enable it in the filter). |

- **Layouts:** folder tree, grouped by status, or flat list. **Filter** by status. Layout and filter are remembered per workspace.
- **Single file:** click it for a diff; use the inline icons to upload or download. If the target is newer, you are asked first.
- **Bulk actions:** the toolbar icons act on everything visible, the context menu on a folder or a status group.
  Every bulk action asks for confirmation and offers **Preview**, which opens a list of exactly what would happen and changes nothing.
  Files that are newer on the target are listed first and called out.
- **Backup:** with `backupBeforeOverwrite`, files are copied to `.vscode/remote-host-backup/<server>/<timestamp>/` before they are overwritten or deleted.
- **Delete extras:** right-click a folder, a status group or one or more selected files, then *Delete Files That Exist Only on the Server* or *…Only Locally (Trash)*. These actions never apply to "everything". Local files go to the trash, server files are backed up first when the backup option is on.
- **Cancelled comparison:** if you cancel a comparison, the result is marked incomplete.

How files are compared: different size means changed. Same size and a modification time within a tolerance (2 s for SFTP, 2 min for FTP) means equal. Same size and a different time: the content is compared. SFTP uploads and all downloads keep the modification time, so repeated comparisons stay fast.

## Pending uploads

The **Pending Uploads** view lists, per server, the local files that still have to be uploaded there. Every save (and every change made on disk by other programs or AI tools) adds the file to the list of each server that maps it; excluded files are skipped. Uploading to *Test* removes the file only from *Test*, it stays listed under *Live* until it is uploaded there too. A change that is undone (the file equals the version last transferred to that server again) disappears from the list.

- Click a file to compare it with the server version, use the inline buttons to upload it or mark it as done.
- *Upload All to This Server* on a server node asks for confirmation first.
- Only changes made since tracking started are known. Use **Compare with Server** (toolbar of the view or on a server) once to include older differences, or after changing files with other tools while VS Code was closed.
- Deleted local files are only removed from the lists, nothing is deleted on the servers.

**Keyboard shortcut:** `Ctrl+Alt+U` (`Cmd+Alt+U` on macOS) uploads the files selected in the Explorer. You can change it under *Keyboard Shortcuts* (command "Remote Host: Upload Selected Files").

## More features
- **Upload Here** (Explorer context menu): with several servers configured, you choose the target server(s). Multi-selection works.
- **Edit Remote File:** opens a remote file in the editor; saving uploads it.
- **Upload on save:** per server, see `uploadOnSave`.
- **Change permissions (chmod):** right-click a remote file or folder (SFTP, and FTP servers that support `SITE CHMOD`). Not recursive.
- **Search files on the server:** the magnifier icon in the remote tree, or right-click a folder (*Search Files on Server…*). Type a text (finds names containing it, ignoring case) or a pattern such as `*.php`. The search honours your exclude patterns, shows progress, can be cancelled and stops at 500 matches. Pick a result to open it.
- **SSH terminal:** right-click a remote folder or file, *Start SSH Session Here* (SFTP servers only). It opens a VS Code terminal that runs your system's `ssh` client in that folder. Things to know: an `ssh` client must be in your PATH (built into Windows 10/11); the stored password is not passed on, you type it in the terminal; the host key check is done by `ssh` and your `known_hosts`; a `ProxyJump` from your `~/.ssh/config` works there.
- **Status bar:** shows the active server; click it to switch.
- **Output channel "Remote Host"** (command *Remote Host: Show Log*): connections, transfers, comparison summaries and errors.

## Security
- **FTP is unencrypted:** password and files travel in clear text. Use SFTP or FTPS whenever possible.
- **Host keys:** SFTP servers are verified (see above). Never accept a changed key without knowing why.
- **Passwords** are stored in the system keychain, not in `.vscode/remote-hosts.json`.
- **Workspace Trust:** the server list lives in the workspace and controls connections, upload on save and SSH sessions, so the extension only runs in trusted workspaces.
- **Server names are not trusted:** names with `..`, path separators (and `\` or `:` on Windows) are rejected, local paths must stay inside the target folder.
- **Backups** may contain sensitive files. Keep `.vscode/remote-host-backup` out of version control.

## Troubleshooting
First open **Output → Remote Host** (or run *Remote Host: Show Log*). It shows what was done and the exact error.

| Problem | What to do |
|---|---|
| *"The host key of … has changed"* | The server was reinstalled or someone intercepts the connection. Ask the server admin. If it is expected, choose *Accept new key*. |
| *"All configured authentication methods failed"* or login errors | Wrong password, key or user. A key passphrase goes into the password field. For `useAgent`, check that `ssh-add -l` lists your key. |
| Nothing happens, tree is empty | Open a workspace **folder** (not just a file), and trust the workspace. Add a server in **Manage Servers**. |
| FTP: many files show as changed, or times look wrong | Set `timeOffsetMinutes` to the difference between server and your time. |
| FTPS certificate error | Fix the certificate. For a server you trust with a self-signed certificate set `allowSelfSigned`. |
| A folder shows *Unreadable* (`!`) | Usually missing permissions on the server. It was not compared and is not transferred. The log names the folder. |
| Files named `….part-…` on the server (or `….part` locally) | Left behind by an interrupted transfer. The real file was not touched. You can delete them. |
| Connection drops during long operations | The extension reconnects and repeats safe operations. Deleting and renaming are not repeated automatically, you get a message instead. |
| A bulk action skipped files | The confirmation and the preview list them under *skipped* (conflicts, identical files, unreadable folders, files that exist only on the other side). |

## FAQ
**Is anything deleted automatically?** No. Files are only deleted by the explicit *Delete* actions after a confirmation.

**Where are my backups?** In `.vscode/remote-host-backup/<server>/<timestamp>/`, only if `backupBeforeOverwrite` is on.

**Can I share the configuration with my team?** Yes, `.vscode/remote-hosts.json` contains no passwords. Use `${env:NAME}` for values that differ per person.

**Does it work with multi-root workspaces?** Only the first workspace folder is used.

**Can I use a jump host / bastion?** Yes for SFTP servers, see [Jump host](#jump-host-bastion). The SSH terminal uses your system `ssh`, so a `ProxyJump` in `~/.ssh/config` works there too.

**Which language is the interface in?** English, and German when VS Code's display language is German. The *Manage Servers* form is English only.

## Known limitations
- Jump host: SFTP only, one hop, no passphrase-protected key for the jump host (use the agent). No generic proxy support.
- No watch / automatic sync of changes made outside the editor (only *upload on save*).
- Multi-root workspaces: only the first folder.
- FTP uploads cannot keep the modification time, so unchanged files may be compared by content.
- chmod is not recursive; FTP chmod depends on server support.
- Deleting only removes files; empty folders are not removed by *Delete extras*.

## Development
`npm install`, `npm test` (the integration tests need `cd test-fixtures && docker compose up -d`, they are skipped otherwise), F5 to debug.
Install a build: `npm run package`, then *Extensions: Install from VSIX…*.
Messages are written in English with `t('…')`; German translations live in `l10n/bundle.l10n.de.json` and `package.nls.de.json` (a test keeps them in sync).

## License
MIT. Not affiliated with JetBrains or Microsoft.
