# AGENTS.md

`prime-dispatch-prototype` authorizes a job, launches a detached per-job worker in an isolated Git
worktree, runs a Prime agent inside it, verifies the result through structured gates, and preserves
the evidence. It is a **prototype**: no feature flags, no compatibility shims, no deprecation
windows — change the code and its tests together and delete what the change replaces.

## Build and test loop

Source is TypeScript under `src/`. Tests are hand-written JavaScript under `test/` that import the
**compiled** output — `../dist/index.js`, occasionally `../dist/<module>.js`. Two consequences
govern every change:

- Run tests through pnpm. `pnpm test` compiles first via `pretest`. Invoking the node test runner
  directly exercises a stale `dist/` and reports green on code you did not write.
- A new export is invisible to tests until `src/index.ts` re-exports its module.

A change is done when all four pass — the same gate CI enforces on every PR:

```bash
pnpm run format      # prettier --check . ; use format:write to fix
pnpm run typecheck
pnpm test
pnpm audit --audit-level=high
```

Touching `openclaw-plugin/` adds `pnpm run test:adapter` — it is a separate package with its own
install, build, and suite. Use pnpm for every lifecycle command; npm and `package-lock.json` stay
out of the repo.

Live acceptance tests drive a real Prime runtime and are excluded from `pnpm test` on purpose. Run
them only when deliberately validating that path, via `pnpm run test:live` or
`pnpm run test:openclaw-lifecycle`.

## Invariants

Every change holds all of these. When one of them makes a change awkward, the change is wrong.

- **Fail closed.** Ambiguous, malformed, or uncertain input, configuration, or recovery state is
  rejected with a reason. Guessing, silent truncation, and silent retry are how this system loses
  work. Corruption is quarantined with an audit record.
- **One authority.** SQLite owns requests, revisions, attempts, checkpoints, confirmations, leases,
  results, usage, and cleanup history. JSON and JSONL files are projections regenerated from it —
  read them for display, and write durable facts through `JobStore`.
- **Evidence survives.** `result.json`, `report.md`, `final.diff`, `inference-usage.json`,
  `worker.log`, and gate output outlive quota enforcement, cleanup, and failure.
- **Gates are argv.** A verification gate is `{ name, command, args[], timeoutMs }`, executed
  directly. Keep argument arrays out of shell strings so nothing is interpolated.
- **Schemas guard the boundary.** Zod schemas are strict, embed defaults with `z.default()`, and
  enforce cross-field invariants in `.superRefine()`, so contradictory config dies before execution.
- **Confirmation is hash-bound.** A real start needs `--confirm-hash` against the previewed
  commitment; resume needs a single-use token bound to the owner route and state revision, and
  creates a linked attempt rather than rewriting interrupted history.
- **Paths are untrusted.** Repositories canonicalize through `realpath` against approved roots;
  artifacts stay inside `state-root/jobs/{jobId}/artifacts/`.
- **Lifecycle is persisted data.** State comes from the store, never inferred from which subprocess
  happens to be alive. A dead worker means `interrupted` plus `uncertain` checkpoints, awaiting an
  explicit operator resume.

## Where behaviour lives

- `dispatcher.ts` — preview, authorize, launch, reconcile. Every transition routes through `store.ts`.
- `store.ts`, `sqlite.ts` — the durable authority and its transactions.
- `worker.ts` — the detached lifecycle: provision, run the agent, gate, commit, materialize.
- `execution.ts`, `repository.ts` — worktree and repository policy.
- `agent.ts`, `prime-runtime.ts`, `fake-prime.ts` — the Prime RPC boundary and its deterministic fake.
- `recovery.ts`, `resume.ts`, `cleanup.ts` — checkpoint proof, resume policy, two-phase cleanup.
- `host-config.ts` — trusted release, approved roots, execution policy loaded at dispatch time.
- `openclaw-host.ts`, `openclaw-install.ts` — install, upgrade, audit, rollback of the integration.

## Reaching further

- Changing the control database schema → read [`docs/database-migrations.md`](docs/database-migrations.md)
  first. Versions form a contiguous prefix, applied migrations are never edited (checksum drift
  blocks startup by design), and every new module registers in `src/migrations/index.ts`.
- Making or revisiting an architectural decision → [`docs/adrs/README.md`](docs/adrs/README.md) indexes
  20 MADR 4.0 records and marks which are superseded. Add a record when a change alters an authority,
  a trust boundary, or a lifecycle guarantee.
- Needing the operator's view — install steps, threat model, known limitations, production exit
  criteria → [`README.md`](README.md).
- Milestone scope and evidence → `docs/beta-milestone-{1,2,3}.md`.

## Style

Names, signatures, and types carry the documentation. Reserve a comment for a hidden constraint, an
invariant, or a workaround whose reason is not visible in the code, and keep it to a line or two.
Prefer three similar lines to a premature helper; introduce an abstraction once a third caller
actually needs it.

## Landing a change

Work on a branch and open a PR — main is protected and requires the CI quality check. Commit
subjects follow Conventional Commits as used here: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.
Keep each change narrowly scoped, cover its failure paths deterministically, and record the
architectural decision when it made one.
