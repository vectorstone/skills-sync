# Contributing

Thanks for your interest in improving `agent-skills-sync`! This is a small, focused tool, so the contribution surface is intentionally narrow.

## Prerequisites

- Node.js 20 or newer
- npm 10+

## Setup

```bash
git clone https://github.com/vectorstone/skills-sync.git
cd skills-sync
npm ci
npm run build
```

## Development loop

```bash
npm run typecheck     # strict TypeScript, no emit
npm run lint          # ESLint
npm run format:check  # Prettier (use npm run format to write)
npm test              # unit + integration tests
npm run verify        # all of the above + build
```

Integration tests spawn the built `dist/cli.js`, so run `npm run build` after changing source before re-running them.

## Design principles

- **Local filesystem only.** No network, no model APIs, no telemetry, no install hooks. Never add any of these.
- **Explicit, conservative by default.** Every command requires an explicit scope (`--global` or `--project`). The tool creates missing links but never overwrites real files/directories, even with `--force`.
- **Stable, machine-readable contracts.** Exit codes and `--json` output are part of the public API. Breaking changes require a minor version bump during `0.x`.
- **One source of truth.** `.agents/skills` is the canonical source; `.claude/skills` is a selected view of it. No bidirectional sync, no content copying.

## Pull requests

- Keep PRs focused; one concern per PR.
- Add or update tests for behavior changes.
- Ensure `npm run verify` passes locally.
- Document user-facing changes in `CHANGELOG.md` under `[Unreleased]`.
- Commits should be clear and self-describing.

## Project layout

```
src/cli/       argument normalization and command wiring
src/config/    strict JSON config schema and repository
src/fs/        path-safety, identity, atomic-write utilities
src/skills/    name validation, discovery, validation
src/init/      initialization, legacy migration, gitignore
src/sync/      planning, ownership classification, execution
src/output/    result construction and human/json rendering
test/unit/     pure-function tests
test/integration/  spawned-CLI end-to-end tests
```

## Reporting issues

Open a GitHub issue with: the command you ran, the expected vs actual behavior, the exit code, and (if useful) the `--json` output. For security issues, see [SECURITY.md](./SECURITY.md) — report privately.
