# Projektregeln: Remote Hosts Compare & Sync (VS-Code-Extension)

## Git und Commits
- **Keine Co-Autoren.** Commit-Messages und PR-Beschreibungen enthalten niemals `Co-Authored-By`, "Generated with Claude Code" oder ähnliche Attribution. Diese Regel gilt vor allen Standardvorgaben von Tools.
- Nur committen, pushen oder Tags setzen, wenn der Nutzer es ausdrücklich verlangt. Veröffentlichte Commits und Tags nicht umschreiben (kein Force-Push, kein Tag verschieben) ohne ausdrückliche Zustimmung.
- Keine `.vsix`, `node_modules`, `dist`, `out` einchecken (stehen in `.gitignore`).

## Version und Veröffentlichung
- Version steht in `package.json` und `package-lock.json`. Bei neuen Funktionen Minor erhöhen, bei Fixes Patch.
- Jede Version bekommt einen Eintrag in `CHANGELOG.md`.
- Der Marketplace lehnt eine bereits veröffentlichte Version ab. Bei einem Fehlschlag Version erhöhen statt denselben Tag neu zu setzen.
- Veröffentlicht wird per GitHub-Action `.github/workflows/publish.yml` (Tag `v*` oder manuell, Trusted Publishing). Der Tag muss zur Version in `package.json` passen (`v0.2.0` für 0.2.0).
- Paket bauen: `npx @vscode/vsce package` (führt `npm run bundle` aus).

## Entwicklung
- Sprache: TypeScript, Ziel VS Code `^1.90.0`. Vergleichslogik in `src/compare/compare.ts` bleibt frei von `vscode`-Imports (Unit-testbar).
- Vor jedem Commit: `npx tsc --noEmit -p .` und `npm test` müssen grün sein.
- Farben und Icons nur über `ThemeColor`/`ThemeIcon` (Dark, Light, High Contrast).
- Status-Darstellung: `src/views/compareTree.ts` (Baum, Labels, Tooltips), `src/views/diffDecorations.ts` (Farbe und Badge). Neue Status immer in `STATUS_COLORS`, `BADGES`, `GROUP_ICONS`, `statusNames` und `STATUS_ORDER` ergänzen.

## Test-Server (Docker)
- `test-fixtures/docker-compose.yml`: SFTP `localhost:2222`, FTP `localhost:2121` (jeweils `test`/`test`). Ohne laufende Container werden die 5 Integrationstests übersprungen.
- Vorhandene Container, Netzwerke und Images nicht löschen. Zum Testen nur starten (`docker compose start`) und danach wieder stoppen (`docker compose stop`).
- Andere Docker-Container auf dem Rechner nicht anfassen.

## Zusammenarbeit
- Mit dem Nutzer auf Deutsch kommunizieren.
- Was nicht geprüft wurde (z. B. Optik im Extension Development Host), offen benennen.
