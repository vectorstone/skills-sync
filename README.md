# Agent Skills Sync

[简体中文](README.zh-CN.md)

`agent-skills-sync` is a filesystem-only Node.js CLI for exposing a selected set of agent skills through managed symlinks.

It treats `.agents/skills` as the canonical source and creates links in `.claude/skills`. Linking keeps one source of truth and avoids copying skill contents into a second tree.

## Status

This repository contains the initial `0.1.0` implementation contract. The package is intended for Node.js 20 or newer on macOS and Linux. Native Windows filesystem commands are rejected with a WSL recommendation. Other POSIX systems are best-effort and not a supported test target.

The project is public, but no release or test result is implied by this documentation. Run the local verification commands below for the current checkout.

## What it does

- Uses a strict JSON configuration at `.agents/skills-sync.json`.
- Requires an explicit scope on every command (`--project` or `--global`).
- Exposes only explicitly selected skills.
- Plans changes before applying them.
- Preserves symlink-based single-source behavior rather than copying contents.
- Provides deterministic human output and a versioned `--json` result contract.
- Makes conservative ownership decisions and can prune only verifiably managed stale links.
- Performs no runtime network calls, telemetry, API calls, or bidirectional synchronization.

It does not copy skill contents, synchronize in both directions, or run the obsolete common-source-to-two-target workflow.

## Install

When the package is published:

```sh
npm install --global agent-skills-sync
```

For a checkout, build it first and invoke the generated binary:

```sh
npm install
npm run build
node dist/cli.js --help
```

## Quick start

From a project containing `.agents/skills/<skill-name>/SKILL.md` directories:

```sh
agent-skills-sync init
agent-skills-sync add review
agent-skills-sync sync
agent-skills-sync check
```

`init` creates the project configuration and the standard source/target directories. `add` selects an existing source skill. `sync` creates or updates managed symlinks after planning and confirmation when changes are needed. `check` is read-only.

Inspect a plan without changing the filesystem:

```sh
agent-skills-sync sync --dry-run
agent-skills-sync list --available
```

Use global configuration explicitly:

```sh
agent-skills-sync --global init
agent-skills-sync --global add review
agent-skills-sync --global sync
```

Use an alternate project root with an absolute path:

```sh
agent-skills-sync --project=/absolute/path/to/project list
```

## Configuration

The default project configuration is `.agents/skills-sync.json`:

```json
{
  "schemaVersion": 1,
  "source": ".agents/skills",
  "target": ".claude/skills",
  "skills": ["review"]
}
```

`skills` must be sorted by Unicode code point, contain no duplicates, and use a safe 1–128 character ASCII name. Source and target must be separate, non-nested directories and remain within the selected scope. A custom config path must also remain within that scope.

## Commands and options

### `init`

Create the configuration and safe directory layout. Existing configuration is not silently replaced.

### `add <name...>` / `remove <name...>`

Add or remove selected skill names. Changes are validated and written atomically. These commands do not create links; run `sync` afterward.

### `list`

Show configured skills and their current link status. `--available` also shows valid source skills that are not selected.

### `check`

Read-only drift detection. Missing or invalid configured links return exit code 4. A stale managed link returns exit code 0 by default and exit code 4 with `--strict`.

### `sync`

Apply the shared plan serially. `--dry-run` only renders the plan. `--force` permits replacement of an invalid managed symlink, never a non-symlink item. `--prune` removes only stale links that can be verified as previously managed. If no action is needed, no target directory is created.

Common options:

- `--global` — select the user-wide scope.
- `--project` or `--project=DIR` — select project scope; `DIR` must be absolute when supplied.
- `--config=FILE` — use a config path inside the selected scope.
- `--json` — emit exactly one machine-readable JSON document for business commands.
- `--quiet` — suppress successful normal human output.
- `--no-color` — disable color output; `NO_COLOR` is also honored.
- `--help`, `--version` — print command help or the package version.

## JSON and exit codes

JSON output has `outputVersion: 1`, the command and mode, selected scope, resolved and raw paths, status, exit code, stable summary counts, sorted items, warnings, and errors. Apply-mode items include `outcome: succeeded`, `failed`, or `skipped`; plans and checks do not imply that an action completed.

Exit codes:

| Code | Meaning                                                               |
| ---: | --------------------------------------------------------------------- |
|    0 | Success; no drift, or requested work completed                        |
|    2 | Usage or configuration error                                          |
|    3 | Required source, project, home, or config is missing                  |
|    4 | Drift detected, or strict stale-link checking failed                  |
|    5 | A filesystem item is blocked or an apply action cannot proceed safely |
|    6 | Confirmation was cancelled                                            |
|    7 | Filesystem I/O failure                                                |
|  130 | Interrupted                                                           |

## Safety model

The tool resolves lexical and real filesystem paths before mutation, refuses scope escapes and nested source/target trees, and revalidates identity while applying. Existing non-symlink target items are blocked and are never overwritten by `--force`. Symlink targets must resolve to the final source directory and expose a valid `SKILL.md`.

Git metadata is not modified by synchronization. `init` may add the managed target pattern to a project `.gitignore` according to the approved initialization contract; review that change in your working tree before committing it.

## Development

The repository uses TypeScript, ESM, npm, ESLint, Prettier, Vitest, and Node.js 20+.

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm audit --audit-level=high
```

The command sequence is the intended local verification sequence. This README does not claim that those checks have passed for every checkout. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [CHANGELOG.md](CHANGELOG.md) for release history.

## Release gates

The approved release plan keeps source publication, tagging, npm bootstrap publication, trusted-publisher setup, and GitHub Release publication as separate outward-facing gates. None of those actions is performed by this repository documentation or CI pull-request checks.

The first `0.1.0` bootstrap publish requires a fresh confirmation, an npm identity check, and an exact package-content review. It is expected to use `npm publish --access public` locally and therefore will not have GitHub OIDC provenance. After that bootstrap version exists, configure npm trusted publishing for the exact `vectorstone/skills-sync` repository and `.github/workflows/release.yml` workflow. Subsequent published GitHub Releases use tokenless npm publishing with `id-token: write` and automatic provenance, subject to npm's trusted-publishing requirements. The release workflow validates the package version and matching dated changelog section and recognizes an already-published exact version rather than attempting a duplicate publish.

Do not treat a successful CI run as permission to publish. Re-check package availability immediately before the bootstrap gate.

## Support and troubleshooting

- Verify the current directory and scope before using `--global`.
- Run `list --available` to discover valid source skills.
- Use `sync --dry-run --json` to inspect actions without mutation.
- A blocked item is deliberately not overwritten; move or remove it yourself after reviewing the path.
- A stale link is prunable only when its ownership can be proven; foreign links are ignored.
- For Windows, use WSL rather than native Windows filesystem commands.

## License

MIT. See [LICENSE](LICENSE).
