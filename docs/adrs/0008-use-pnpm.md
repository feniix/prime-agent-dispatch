---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Use pnpm for package management

## Context and Problem Statement

The prototype was initially scaffolded with npm, but the project convention is to use pnpm. The package manager and lockfile must be unambiguous and reproducible across local and CI environments.

## Decision Drivers

- Match the selected project tooling convention.
- Pin the package-manager release used to generate the lockfile.
- Support frozen-lockfile installation.
- Keep lifecycle scripts independent of recursive package-manager invocation.

## Considered Options

- pnpm with `pnpm-lock.yaml` and a pinned `packageManager` field.
- npm with `package-lock.json`.
- No committed lockfile.

## Decision Outcome

Chosen option: **pnpm with `pnpm-lock.yaml` and a pinned `packageManager` field**.

The project pins pnpm `11.21.0`, removes `package-lock.json`, and uses direct tool commands inside package lifecycle scripts so `pnpm test` does not depend on a separately installed recursive package-manager binary.

### Consequences

- Good, because dependency resolution is reproducible with `pnpm install --frozen-lockfile`.
- Good, because the intended package manager is machine-readable.
- Good, because generated lockfile formatting is excluded from Prettier.
- Bad, because contributors need pnpm or Corepack available.

### Confirmation

Run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run format
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm audit --audit-level=high
```

All commands passed when this ADR was accepted.
