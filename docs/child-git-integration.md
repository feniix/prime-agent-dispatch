# Child proposal worktrees and root integration

Writable child attempts never run in the root job worktree. The host creates a
dedicated branch and worktree for each attempt from an immutable, recorded wave
base, then passes that proven identity to the native child runtime. Read-only
children use the same proposal protocol without manufacturing a commit.

## Authority and layout

SQLite records the canonical repository, owned worktree path, owned branch,
base commit, and observed initial HEAD before a runtime is started. The host
derives rather than accepts the writable locations:

```text
<state-root>/worktrees/children/<job-id>/<child-id>/attempt-<ordinal>
prime-child/<job-id>/<child-id>/attempt-<ordinal>
```

The coordinator rejects repository, path, branch, base, HEAD, and Git common
directory substitution. A proposal is an immutable record containing its
outcome, base, commit when applicable, and a bounded binary-safe base-to-HEAD
patch with its digest. Recording it does not alter the root branch. The patch
remains authoritative SQLite evidence after Git cleanup removes the proposal's
last branch reference.

## Root-owned integration

Only the root coordinator integrates a proposal. It proves that the root
worktree is clean and still at the caller's expected HEAD, records an
`applying` transition, applies the proposal without retaining child-authored
commits, and creates one attributable root-owned integration commit. A clean
application records the new root HEAD and selects the child result.

Conflicts are terminal integration evidence, not an implicit merge. The
coordinator records bounded conflict paths and an error summary, restores the
exact pre-integration root commit, leaves the child proposal intact, and keeps
the result pending for root resolution. An `applying` record left by a crash is
deliberately fail-closed; recovery must reconcile durable evidence with Git
before another integration is attempted.

Successful `no_change` and `read_only` proposals complete an integration record
with the unchanged root HEAD. Trusted verification cannot start while a current
successful child proposal is unintegrated.

## Dependency waves and cleanup

Wave 1 is bound to the confirmed job base. After the root has integrated the
chosen proposals and is clean, it can record the current root HEAD as the next
immutable wave base. Admission requires the child envelope to name exactly that
recorded base, so dependent test and review children see a stable integrated
snapshot.

Cleanup inventory includes host-owned child worktrees and their exact branches.
Application re-proves the Git common directory, canonical path, branch, base,
and current identity, removes each worktree before its branch, and retains the
SQLite proposal and integration evidence.
