# Changelog

## 0.8.0
- New: "Berechtigungen ändern (chmod)" in the context menu of the remote tree (SFTP and FTP via `SITE CHMOD`). The input is prefilled with the current permissions and validated (3 or 4 octal digits).
- New server option `ignoreLineEndings` (checkbox in the server form): files that differ only in line endings (CRLF vs LF) count as equal when comparing. Only text files up to 5 MB are checked, binary files are never treated as equal this way.
- Fix: a single unreadable local entry (for example a broken symlink) no longer makes the whole folder "Nicht lesbar". The entry is skipped and noted in the output channel.
- Fix: permissions in the remote tree tooltip were shown as `rw` (SFTP) or `644` (FTP). Both now show the usual `rw-r--r--`.

## 0.7.0
- Large files: uploads and downloads of files are now streamed instead of being read into memory completely (SFTP and FTP/FTPS).
- Safe replacement: a file is first written under a temporary name (`<name>.part-…` on the server, `<name>.part` locally) and only replaces the target when it is complete. An interrupted transfer no longer leaves a half-written file. If the final replace fails on a server that cannot overwrite, the new version stays under the temporary name and the message tells you where.
- Bulk actions show the transferred bytes of the current file ("12.4 MB / 80.0 MB").
- Fix (since 0.5.0): files were read from the server for the backup even when "backup before overwrite" was off. They are now only read when the option is on.

## 0.6.0
- `.vscode/remote-hosts.json` now has a JSON schema: autocomplete, descriptions and validation (typos in option names, wrong protocol) directly in the editor.
- `${env:NAME}` placeholders in `host`, `username`, `localPath`, `remotePath` and `privateKeyPath`: the file can be shared without personal values. Unknown variables are reported in the "Remote Host" output channel. The settings form keeps the placeholders as typed.
- A dropped connection is rebuilt after a short pause. `rename` and `remove` are no longer repeated automatically (the first attempt may already have reached the server); you get a clear message and the next action works.
- Command Palette: all commands are grouped under "Remote Host:", and commands that only make sense on a tree item are hidden there.
- More tests (retry rules, serialization of operations, environment expansion).

## 0.5.0
- Preview (dry run): the confirmation dialog of every bulk action now has a "Vorschau" button. It opens a list of exactly what would happen (overwrite / create / delete, files whose target is newer, skipped files) and changes nothing.
- Backup: new server option `backupBeforeOverwrite` (checkbox in the server form). Files that are overwritten or deleted by a transfer are first copied to `.vscode/remote-host-backup/<server>/<timestamp>/`.
- Delete extras: new context-menu actions in the Differences view, "Nur auf dem Server vorhandene Dateien löschen" and "Nur lokal vorhandene Dateien löschen (Papierkorb)". Only available for folders, status groups or selected files (never "everything"), with a confirmation. Remote deletes are backed up first if the backup option is on; local deletes go to the trash.

## 0.4.0
- New output channel "Remote Host" (command "Remote Host: Protokoll anzeigen"): connections, uploads/downloads, comparison summaries, errors. Errors when expanding the remote tree are shown only once in a while instead of one notification per folder.
- Faster comparisons: SFTP uploads keep the local modification time and downloads keep the remote one, so unchanged files are no longer downloaded again to compare their content.
- "Upload on save" now works for every server that has it enabled and maps the saved file, not only for the active server.
- New server option `useGitignore`: also exclude everything from the `.gitignore` in the server's local folder (checkbox in the server form).
- SFTP: authentication through the SSH agent (`useAgent`, checkbox in the server form), no password needed.
- If a stored password no longer works, the extension asks for a new one once instead of failing every time.

## 0.3.1
Security and robustness release.
- SFTP: the server's host key is now verified. The first connection asks you to confirm the fingerprint (SHA256), a changed key triggers a clear warning. Accepted keys are stored in the extension (not in the workspace). New command "Remote Host: Gespeicherte SFTP-Host-Keys löschen".
- Downloads and bulk transfers are hardened against malicious file names from a server (`..`, path separators, and `\` / `:` on Windows). Local target paths must stay inside the target folder.
- A folder that cannot be read during a comparison is now shown as "Nicht lesbar" (badge `!`) instead of being treated as empty. Before, everything on the other side looked "only there", and bulk upload would have copied it all. Such folders are never transferred.
- A cancelled comparison is marked as incomplete (message above the tree, warning in the confirmation dialog).
- Before overwriting a file that is NEWER on the target (single and bulk upload/download), the extension now warns and lists those files first.
- Diffs and the remote editor show the real error (e.g. login or network problem) instead of an empty file or "file not found".
- The publish workflow now runs the tests before publishing.

## 0.3.0
- "Upload Here" in the normal Explorer now asks which server to upload to when several servers are configured (active server first, multiple servers can be ticked). Multi-selection in the Explorer is supported. Previously it always used the active server without asking.
- Bulk sync in the Differences view: upload or download a whole folder, a status group, a multi-selection or everything visible. Confirmation with file count and overwrite count, progress with cancel, errors per file do not stop the run. Conflicts and identical files are skipped.
- Server-to-server comparison: bulk download to local from server A or B.

## 0.2.0
- Differences view: file names are colored and carry a badge (M/L/R/C/=) like the Git view; file-type icons from your icon theme.
- Clearer status labels incl. direction ("Lokal neuer", "Remote neuer"), rich tooltip with size and date of both sides.
- Summary line and badge for the view, difference count per folder.
- New layouts: folder tree, grouped by status, flat list. Compact folders (`a/b/c`).
- New status filter; "Unverändert" (identical files) can be shown. Layout and filter are remembered per workspace.
- File-vs-folder conflicts are reported once as "Typ-Konflikt" instead of local-only plus remote-only.

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
