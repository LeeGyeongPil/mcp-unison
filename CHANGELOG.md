# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-18

### Fixed

- CI: the integration test launches VS Code with `--no-sandbox`, `--disable-gpu` and `--disable-workspace-trust` so it runs on Ubuntu 24.04 runners, and the job has a 10 minute timeout.

## [0.1.0] - 2026-11-17

### Added

- Conversion core: reads Claude Code user, local and project scopes, Codex `config.toml`, VS Code `.vscode/mcp.json` and the Copilot `mcp-config.json`.
- Claude Code semantics reproduced: local over project over user with whole-entry replacement, unset variables kept as literal text, empty strings counted as set values, credential variables read as empty strings in remote `url` and `headers`.
- Warning codes (`W_*`) that explain why a server could not be translated, in English and Korean.
- VS Code extension: live MCP server definition provider, `Sync to Copilot config` (diff, then write managed entries only), drift report, export for Claude Code, language choice.
- Copilot config writes keep user entries, comments and other keys byte for byte, track managed entries in `mcp-unison.lock.json`, create a `.bak` backup and report hand-edited entries as conflicts.
- Local-scope Claude Code servers are not written to the global Copilot config (warning `W_LOCAL_SCOPE_NOT_SYNCED`), so syncing from another project never removes entries.
- `diff` reports leftovers of an earlier sync as `stale-managed` and your own same-name entries as `kept-user` (not drift, so `diff --check` stays 0).
- `--write` keeps the file mode of the Copilot config (new files and the lock are 0600) and follows symlinks.
- CLI: `list`, `diff [--check]`, `sync-copilot [--write]`, `export-claude [--format mcp-json|add-json]`, `--json`, `--home`, `--project`, `--demo`, `--lang en|ko`.
- Practice mock home folder (`examples/demo-home`) and `--demo` mode that runs the real conversion on a throwaway copy.
