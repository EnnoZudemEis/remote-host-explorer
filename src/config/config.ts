import * as vscode from 'vscode';
import { ServerConfig } from '../connection/types';

const FILE = '.vscode/remote-hosts.json';

export function configUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, FILE) : undefined;
}

export async function loadServers(): Promise<ServerConfig[]> {
  const uri = configUri();
  if (!uri) return [];
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const json = JSON.parse(Buffer.from(raw).toString('utf8'));
    return Array.isArray(json.servers) ? json.servers : [];
  } catch {
    return [];
  }
}

export async function saveServers(servers: ServerConfig[]): Promise<void> {
  const uri = configUri();
  if (!uri) throw new Error('Open a workspace folder first.');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  const text = JSON.stringify({ servers }, null, 2);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

export function passwordKey(server: Pick<ServerConfig, 'protocol' | 'username' | 'host'>): string {
  return `remoteHost:${server.protocol}://${server.username}@${server.host}`;
}
