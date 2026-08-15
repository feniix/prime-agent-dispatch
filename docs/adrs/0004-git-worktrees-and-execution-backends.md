---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Isolate Git changes with worktrees and an execution backend

## Context and Problem Statement

Prime must modify and verify repositories without disturbing the user's checkout. The first spike intentionally omits containers, but its architecture must make Apple container execution an additive backend rather than a rewrite.

## Decision Drivers

- Preserve source-checkout changes and repository instructions.
- Resolve an immutable, reproducible base commit without automatic fetches.
- Permit local commits while forbidding pushes and pull requests.
- Make the absence of host isolation explicit.
- Allow Apple native containers later.

## Considered Options

- Dedicated Git worktree behind an `ExecutionBackend`.
- Edit the source checkout directly.
- Require Apple containers in the first spike.
- Clone every job into a new repository.

## Decision Outcome

Chosen option: **dedicated Git worktree behind an `ExecutionBackend`**.

The dispatcher canonicalizes the repository and configured roots, rejects symlink escapes, resolves the requested base to a commit SHA, and creates `prime/<job-id>`. The prototype implements `unsafe-local` only for fixture use and retains an Apple-container contract stub.

### Consequences

- Good, because source-checkout dirty state is neither disturbed nor imported implicitly.
- Good, because worktree commits and diffs remain reviewable after completion.
- Good, because containment can be added behind the same interface.
- Bad, because a worktree is not a filesystem or network sandbox.
- Bad, because preserved branches and worktrees require a future lossless cleanup policy.
- Bad, because repository-local external services can still conflict across worktrees.

### Confirmation

Tests cover canonical repo roots, symlink escape rejection, immutable base resolution, worktree creation, gate execution, dedicated unsigned commit identity, and final diff/report capture. The Prime environment uses a Git guard that rejects ordinary `fetch`, `pull`, and `push`, removes inherited authentication, and leaves configured remotes unchanged. With normal host networking this is defense in depth, not an enforceable no-remote boundary: model code can invoke an absolute Git binary with configuration overrides or another network client. The opt-in real Prime acceptance ran only against a disposable fixture and left its source checkout and inert remote configuration untouched.

This current-user backend remains explicitly unsafe-local: it is not a sandbox and has normal host networking. Existing real repositories require separate explicit selection; containers remain deferred.

## More Information

- Minimal environment variables are defense in depth, not a security boundary.
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
