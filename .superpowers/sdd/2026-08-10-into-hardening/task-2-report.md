# Task 2 report — auth schema and legacy-role migration

Status: DONE

Implemented checksum-gated SQLite and PostgreSQL auth schema migrations for users, credentials, invitations, sessions, and append-only events. Added a minimal configured repository that auto-migrates only outside production, plus raw SQLite snapshot/normalized-user inventory that never calls `getStore()`.

Legacy `Admin`, `Accountant`, `Reviewer`, and `Viewer` roles map case-insensitively to `verified_user`. Role-only identities remain invited, real verification markers activate users, disabled users remain disabled, and `shared_user`, missing, and unknown roles cannot become auth users. Replays preserve user versions and event cardinality.

TDD evidence: the initial auth test failed because the repository module did not exist; the configured-repository and raw-inventory edge tests likewise failed before their corresponding minimal implementations. Focused suite: 10/10 passing. Full suite: 319/319 passing. `pnpm run typecheck` and `pnpm run lint` pass.

Concern: PostgreSQL coverage is SQL-contract/migration-seam coverage only because no live PostgreSQL service is configured. Real transactional PostgreSQL coverage remains for Tasks 6 and 22. PostgreSQL legacy normalized-user discovery is intentionally deferred to a deployment command; the pure inventory seam and SQLite raw-storage discovery are available without hydrating the runtime snapshot.

Implementation commit: 78c0370c2a630846647aa263e516da5049ea3fd3
