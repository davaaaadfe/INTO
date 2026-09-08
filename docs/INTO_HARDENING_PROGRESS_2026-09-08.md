# Hardening progress — 2026-09-08

## Implemented in this working batch

- Durable booking reservation before every real Exact POST sequence, using the existing SQLite/PostgreSQL snapshot CAS rather than a parallel persistence store.
- Per-step remote ID persistence; completed-state persistence before file deletion; safe completed request replay; locked reconciliation state after partial or uncertain remote results.
- Shared single/bulk booking command, bounded request keys, strict bulk item validation, and permanent learning-only exclusion.
- Review, supplier, Learn, re-read, recompute, and cleanup protection while booking is reserved or uncertain; the workbench displays the lock and disables review controls.
- Request checkpoints advance after durable commits, so later exceptions cannot restore an unreserved invoice.
- Verified actor/session/request attribution for reservation and uncertainty, with sanitized events and no raw request key or provider failure body.
- PostgreSQL stale-generation learning fix: rejected requests cannot supersede old evidence or report same-truth success after reset.
- Expanded live PostgreSQL coverage for absolute pattern rebuild/replay, concurrent reset, stale generation, and booking lock persistence across restart. Exact calls in tests are simulated.

## Release boundaries

Fresh verification for this batch: `pnpm test` — 443 passed; `pnpm run test:postgres` — 5 passed on the disposable Neon endpoint; typecheck, lint, production build, and `git diff --check` passed. The finalization fault-injection test first reproduced a partial-success-record defect and then passed with checkpoint restoration. No real Exact booking was performed.

These changes do not enable production OCR, supplier automation, Learn/reset UI, or real Exact booking. They do not create a second verified user, perform a production migration, or push a deployment automatically.

The full program is not production-complete. Remaining gates include a fresh production backup and schema verification, a second verified recovery user and auth recovery drill, an audited Exact reconciliation workflow and approved test-division validation, representative held-out supplier/format evidence, rendered accessibility checks, and operational monitoring/rollback sign-off.

Follow `INTO_HARDENING_RELEASE_RUNBOOK.md`. Do not use a pre-reservation build as a rollback target once pending booking operations exist.
