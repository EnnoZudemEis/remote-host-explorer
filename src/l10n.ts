import * as vscode from 'vscode';

/**
 * Translates a user-visible message. The English text is the key; German translations live in
 * l10n/bundle.l10n.de.json. Placeholders are {0}, {1}, … Always pass a plain string literal so
 * the consistency test (test/l10n.test.ts) can find it.
 */
export const t = vscode.l10n.t;
