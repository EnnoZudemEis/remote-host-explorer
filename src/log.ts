import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** Creates the "Remote Host" output channel (transfer log, connection events, errors). */
export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Remote Host');
  ctx.subscriptions.push(channel);
}

export function log(message: string): void {
  channel?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export function showLog(): void {
  channel?.show(true);
}
