# Guimai Controlled Publication Linux Rehearsal v1

Date: 2026-08-22

Status: PASS (isolated rehearsal only; not deployed)

## Scope

This rehearsal validates the Linux-only filesystem behavior of the opt-in
`controlled-reader-v1` publication profile from checkpoint
`b563ff6a7a6eb81d1e7f61162d9ef313d1b29735`.

The run was intentionally isolated:

- executed as an unprivileged account in a one-time directory below `/tmp`;
- did not read production environment files or application state;
- did not call application APIs other than existing `/health` endpoints;
- did not change users, groups, service units, permissions, or production paths;
- did not restart, reload, deploy, import, migrate, or backfill anything.

## Audited bundle

The read-only Harness audit completed with the workspace unchanged and found
that the Linux test needs exactly these seven files:

- `package.json`
- `src/state-store.js`
- `src/state-publication-profile.js`
- `src/server.js` (read as text only)
- `src/bridge-queue.js` (read as text only)
- `src/oauth-provider.js` (read as text only)
- `test/state-store.test.js`

The executed import chain uses Node core modules only. It performs no network
access, service calls, secret reads, or production-path reads. All seven remote
files matched the local SHA-256 hashes before execution.

Harness evidence: `ds-20260822T150347Z-f3f30d` (`completed`,
`workspace_unchanged=true`).

## Environment and result

- Linux host runtime: Node.js `v20.20.2`
- Command: `node --test test/state-store.test.js`
- Environment: cleared process environment with only `PATH`, isolated `TMPDIR`,
  and `NODE_ENV=test`
- Result: 9 tests, 9 passed, 0 failed, 0 skipped

The passing Linux paths include:

- strict-umask override only after a complete write;
- final state mode/group validation;
- valid `02750` publication-directory enforcement;
- wrong mode, wrong gid, and linked-directory rejection;
- bootstrap and published-mode-drift rejection;
- complete-before-readable and rename-last ordering;
- publication options remaining limited to the primary state store.

## Isolation and production invariants

Before and after the accepted run:

- four existing production units reported `active`;
- four existing health endpoints returned HTTP `200`;
- no service was restarted or modified.

The exact canonical rehearsal path was checked against the required
`/tmp/guimai-controlled-rehearsal.*` prefix before recursive removal. The
directory was removed and the remaining matching-directory count was zero.

An earlier orchestration attempt was excluded from acceptance because its
middle test output was not retained. Its isolated directory was confirmed
removed and production health was rechecked before the accepted rerun.

## Acceptance boundary

This closes the Linux POSIX rehearsal gap for the local controlled-publication
implementation. It does not prove a production reader group, production path,
service-unit wiring, cross-process read, deployment, or Private Corpus access.
