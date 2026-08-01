# Security Policy

## Supported versions

`agent-skills-sync` is early in its lifecycle (`0.x`). Only the latest published version receives security fixes.

## Reporting a vulnerability

Please report security issues **privately** rather than as a public issue.

- Open a private vulnerability report via GitHub: **Security → Report a vulnerability** on the [repository](https://github.com/vectorstone/skills-sync/security/advisories/new).
- Do **not** open a public issue or PR that exposes exploit details.

Please include: affected version, a minimal reproduction, and your assessment of impact. Acknowledgement is typically within a few days.

## Scope

`agent-skills-sync` is a **local filesystem-only** CLI. It does not access the network, does not call any model APIs, collects no telemetry, and runs no install hooks. It manages symlinks between local skill directories. Security concerns in scope include:

- path traversal / escaping the selected scope
- unsafe deletion or overwrite of files outside managed symlinks
- unsafe handling of symlinks, race conditions (TOCTOU), or permission escalation
- injection via config or legacy manifest parsing

## Local race-condition boundary

The tool detects cooperative races and re-validates filesystem identity before each mutation, but Node's pathname-based filesystem APIs do not expose directory-handle (`openat`/`unlinkat`) operations. This means a **privileged, malicious local process** that swaps paths between the final identity check and the syscall could theoretically interfere. The CLI is designed to **refuse** when it detects a change rather than act on a swapped object. It is not intended to defend against an actively hostile privileged local user on a shared machine.

## Disclosure policy

Once a fix is released, a GitHub Security Advisory is published crediting the reporter (unless they prefer to remain anonymous).
