import * as vscode from 'vscode';
import { t } from '../l10n';
import { loadServers, saveServers, passwordKey } from '../config/config';
import { ServerConfig } from '../connection/types';

let panel: vscode.WebviewPanel | undefined;

interface SaveMessage {
  type: 'save';
  originalName: string | null;
  server: ServerConfig;
  password: string;
}

/** Opens (or focuses) the server settings form. `onChanged` runs after servers were saved/deleted. */
export function openServerForm(ctx: vscode.ExtensionContext, onChanged: () => Promise<void>): void {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('remoteHost.servers', 'Remote Host: Servers', vscode.ViewColumn.Active, {
    enableScripts: true,
  });
  panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);

  const post = async (extra: object = {}) => panel?.webview.postMessage({ type: 'servers', servers: await loadServers(), ...extra });

  panel.webview.onDidReceiveMessage(async (msg: SaveMessage | { type: 'ready' } | { type: 'delete'; name: string }) => {
    if (msg.type === 'ready') return post();

    const servers = await loadServers();
    if (msg.type === 'delete') {
      const target = servers.find((s) => s.name === msg.name);
      if (!target) return;
      const deleteLabel = t('Delete');
      const ok = await vscode.window.showWarningMessage(t('Delete server "{0}"?', target.name), { modal: true }, deleteLabel);
      if (ok !== deleteLabel) return;
      const rest = servers.filter((s) => s !== target);
      await saveServers(rest);
      if (!rest.some((s) => passwordKey(s) === passwordKey(target))) await ctx.secrets.delete(passwordKey(target));
      await onChanged();
      return post({ selected: null });
    }

    if (msg.type === 'save') {
      const s = msg.server;
      if (!s.name || !s.host || !s.remotePath || !s.localPath) {
        return post({ error: 'Name, host, local path and remote path are required.', selected: msg.originalName });
      }
      if (servers.some((x) => x.name === s.name && x.name !== msg.originalName)) {
        return post({ error: `A server named "${s.name}" already exists.`, selected: msg.originalName });
      }
      const old = servers.find((x) => x.name === msg.originalName);
      if (msg.password) {
        await ctx.secrets.store(passwordKey(s), msg.password);
      } else if (old && passwordKey(old) !== passwordKey(s)) {
        const oldPw = await ctx.secrets.get(passwordKey(old)); // host or user changed: keep the password
        if (oldPw !== undefined) await ctx.secrets.store(passwordKey(s), oldPw);
      }
      const next = old ? servers.map((x) => (x === old ? s : x)) : [...servers, s];
      await saveServers(next);
      await onChanged();
      return post({ selected: s.name, saved: true });
    }
  });

  panel.webview.html = html();
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2);
  return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; display: flex; height: 100vh; }
  #list { width: 220px; border-right: 1px solid var(--vscode-panel-border); padding: 12px; overflow: auto; }
  #list button.item { display: block; width: 100%; text-align: left; margin: 2px 0; background: none; color: inherit; border: none; padding: 6px 8px; cursor: pointer; border-radius: 3px; }
  #list button.item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #list button.item:hover:not(.active) { background: var(--vscode-list-hoverBackground); }
  #form { flex: 1; padding: 16px 24px; overflow: auto; max-width: 640px; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  small { display: block; opacity: .7; font-weight: normal; margin-top: 2px; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    width: 100%; box-sizing: border-box; margin-top: 4px; padding: 5px 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 14px; font-weight: 600; }
  .actions { margin-top: 20px; display: flex; gap: 8px; }
  button.primary, button.secondary, button.danger { padding: 6px 14px; border: none; cursor: pointer; border-radius: 2px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-foreground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  #msg { margin-top: 12px; min-height: 1.2em; } .err { color: var(--vscode-errorForeground); } .ok { color: var(--vscode-testing-iconPassed); }
</style></head>
<body>
<div id="list"><button class="secondary" id="new" style="width:100%;margin-bottom:8px">+ New Server</button><div id="items"></div></div>
<div id="form">
  <h2 id="title">New Server</h2>
  <label>Name <small>e.g. Test, Live</small><input type="text" id="name"></label>
  <div class="row">
    <div><label>Protocol<select id="protocol"><option value="sftp">SFTP</option><option value="ftp">FTP</option><option value="ftps">FTPS</option></select></label></div>
    <div><label>Port <small>empty = default</small><input type="number" id="port" min="1" max="65535"></label></div>
  </div>
  <label>Host<input type="text" id="host"></label>
  <label>Username<input type="text" id="username"></label>
  <label>Password <small id="pwhint">Stored in the system keychain, never in the config file.</small><input type="password" id="password" autocomplete="off"></label>
  <label>SSH private key <small>SFTP only, optional. The password field is then used as passphrase.</small><input type="text" id="privateKeyPath" placeholder="~/.ssh/id_ed25519"></label>
  <div class="row">
    <div><label>Local folder <small>relative to the workspace</small><input type="text" id="localPath" value="."></label></div>
    <div><label>Remote folder<input type="text" id="remotePath" value="/"></label></div>
  </div>
  <label>Exclude <small>One pattern per line: <code>.git</code>, <code>*.log</code>, <code>cache/**</code></small><textarea id="exclude" rows="4"></textarea></label>
  <div class="row">
    <div><label>Time offset (minutes) <small>FTP servers without timezone info</small><input type="number" id="timeOffsetMinutes" value="0"></label></div>
  </div>
  <label class="check"><input type="checkbox" id="uploadOnSave"> Upload on save</label>
  <label class="check"><input type="checkbox" id="useGitignore"> Also exclude everything from the <code>.gitignore</code> in the local folder</label>
  <label class="check"><input type="checkbox" id="backupBeforeOverwrite"> Back up files before they are overwritten or deleted by a transfer <small>(<code>.vscode/remote-host-backup</code>)</small></label>
  <label class="check"><input type="checkbox" id="ignoreLineEndings"> Ignore line-ending differences (CRLF / LF) when comparing</label>
  <label class="check"><input type="checkbox" id="useAgent"> SFTP: use the SSH agent <small>(no password needed)</small></label>
  <label class="check"><input type="checkbox" id="allowSelfSigned"> FTPS: accept self-signed / invalid certificate <small>(insecure, only for servers you trust)</small></label>
  <div class="actions">
    <button class="primary" id="save">Save</button>
    <button class="danger" id="delete" style="display:none">Delete</button>
  </div>
  <div id="msg"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let servers = [], selected = null;

  const blank = { name: '', protocol: 'sftp', host: '', username: '', localPath: '.', remotePath: '/', exclude: ['.git', 'node_modules'], uploadOnSave: false, timeOffsetMinutes: 0 };

  function renderList() {
    $('items').innerHTML = '';
    servers.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'item' + (s.name === selected ? ' active' : '');
      b.textContent = s.name + '  (' + s.protocol + ')';
      b.onclick = () => select(s.name);
      $('items').appendChild(b);
    });
  }
  function fill(s) {
    $('name').value = s.name; $('protocol').value = s.protocol; $('port').value = s.port || '';
    $('host').value = s.host; $('username').value = s.username || '';
    $('password').value = ''; $('privateKeyPath').value = s.privateKeyPath || '';
    $('localPath').value = s.localPath; $('remotePath').value = s.remotePath;
    $('exclude').value = (s.exclude || []).join('\\n');
    $('timeOffsetMinutes').value = s.timeOffsetMinutes || 0; $('uploadOnSave').checked = !!s.uploadOnSave;
    $('allowSelfSigned').checked = !!s.allowSelfSigned;
    $('useGitignore').checked = !!s.useGitignore; $('useAgent').checked = !!s.useAgent; $('backupBeforeOverwrite').checked = !!s.backupBeforeOverwrite;
    $('ignoreLineEndings').checked = !!s.ignoreLineEndings;
  }
  function select(name) {
    selected = name;
    const s = servers.find((x) => x.name === name);
    fill(s || blank);
    $('title').textContent = s ? 'Edit "' + s.name + '"' : 'New Server';
    $('delete').style.display = s ? '' : 'none';
    $('pwhint').textContent = s ? 'Leave empty to keep the stored password.' : 'Stored in the system keychain, never in the config file.';
    $('msg').textContent = '';
    renderList();
  }
  $('new').onclick = () => select(null);
  $('delete').onclick = () => vscode.postMessage({ type: 'delete', name: selected });
  $('save').onclick = () => {
    const server = {
      name: $('name').value.trim(), protocol: $('protocol').value, host: $('host').value.trim(),
      username: $('username').value.trim(), localPath: $('localPath').value.trim() || '.',
      remotePath: $('remotePath').value.trim() || '/',
      exclude: $('exclude').value.split('\\n').map((x) => x.trim()).filter(Boolean),
      uploadOnSave: $('uploadOnSave').checked,
    };
    if ($('allowSelfSigned').checked) server.allowSelfSigned = true;
    if ($('useGitignore').checked) server.useGitignore = true;
    if ($('useAgent').checked) server.useAgent = true;
    if ($('backupBeforeOverwrite').checked) server.backupBeforeOverwrite = true;
    if ($('ignoreLineEndings').checked) server.ignoreLineEndings = true;
    if ($('port').value) server.port = Number($('port').value);
    if ($('privateKeyPath').value.trim()) server.privateKeyPath = $('privateKeyPath').value.trim();
    if (Number($('timeOffsetMinutes').value)) server.timeOffsetMinutes = Number($('timeOffsetMinutes').value);
    vscode.postMessage({ type: 'save', originalName: selected, server, password: $('password').value });
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type !== 'servers') return;
    servers = m.servers;
    if (m.error) { // keep the user's input, only show the message
      renderList();
      $('msg').className = 'err'; $('msg').textContent = m.error;
      return;
    }
    if ('selected' in m) select(m.selected); else if (selected === null && servers.length) select(servers[0].name); else renderList();
    if (m.saved) { $('msg').className = 'ok'; $('msg').textContent = 'Saved.'; }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
