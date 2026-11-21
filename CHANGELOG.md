# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-11-21

### Fixed

- `--config <path>` is now honoured by every command; it was previously parsed but silently ignored, so the default config path was always used.

### Changed

- Expanded the test suite to cover the CLI, config, executor, planner, and output modules; the coverage gate now passes on lines, branches, and functions.

## [0.2.0] - 2026-11-17

### Changed

- Renamed the package and CLI from `agent-skills-sync` to `@vectorstone/sksync`; the command is `sksync`.

## [0.1.1] - 2026-08-01

### Fixed

- Follow a directory symlink when checking the configured source root, so global shared skill directories are recognized correctly.

## [0.1.0] - 2026-08-01

The first public release.

### Added

- `agent-skills-sync` CLI with `init`, `add`, `remove`, `list`, `check`, and `sync` commands.
- One-way selective symlink exposure from `.agents/skills` to `.claude/skills`, driven by a strict JSON config at `.agents/skills-sync.json`.
- Explicit `--project` / `--global` scope on every filesystem command; `--project=DIR` and bare `--project` (current directory) forms.
- Strict config schema (`schemaVersion: 1`) with canonical sorted-unique skill names, fatal UTF-8 decoding, and rejection of unknown fields, BOMs, and unsorted/duplicate names.
- Path safety: scope containment via lexical plus nearest-existing-ancestor realpath checks, strict-descendant target, and source/target overlap rejection.
- Conservative ownership model: `--force` replaces only wrong symlinks and never overwrites real files or directories; `--prune` removes only verifiably managed stale links.
- Side-effect-free `check` and `sync --dry-run`; planning shared across `list`/`check`/`sync`.
- Versioned machine output (`--json`, `outputVersion: 1`) and stable exit codes (`0/2/3/4/5/6/7/130`).
- Legacy `.agents/claude-skills.txt` migration via `init --from-legacy`.
- Project `.gitignore` management for the managed target.
- No runtime network access, telemetry, API calls, or install hooks.

### Changed

- Deviation from the legacy shell script: scope is now explicit (no default), the manifest is JSON, and `check` is strictly read-only.

[unreleased]: https://github.com/vectorstone/skills-sync/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/vectorstone/skills-sync/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vectorstone/skills-sync/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/vectorstone/skills-sync/releases/tag/v0.1.1
[0.1.0]: https://github.com/vectorstone/skills-sync/releases/tag/v0.1.0
