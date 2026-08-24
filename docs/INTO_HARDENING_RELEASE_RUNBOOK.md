# INTO hardening release runbook

This runbook applies to the verified-user, supplier-learning, document-analysis, and resolver hardening rollout. Migrations are expand-only. Never use a rollback to disable the learning-only booking guard.

## Release prerequisites

1. Back up the runtime and normalized auth/learning databases.
2. Apply the numbered auth and learning migrations before application traffic.
3. Run `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build` with the release artifact.
4. Run the repository contract and concurrency suites against both SQLite and a real PostgreSQL service. For the disposable Neon gate, set `INTO_POSTGRES_INTEGRATION_DATABASE_URL` in `.env.local` and run `pnpm run test:postgres`; the test applies idempotent migrations, verifies rollback, and removes its temporary probe table.
5. Confirm at least two active verified users before changing `AUTH_MODE` from `dual` to `verified_user`.
6. Confirm managed OCR privacy/region/retention approval before enabling `DOCUMENT_INTELLIGENCE_ENABLED`.
7. Confirm the approved held-out resolver gate before enabling automatic supplier selection: empirical precision at least 99.5%, 95% lower confidence bound at least 99%, zero policy violations, and at least 500 eligible decisions across 50 suppliers.

## Staged rollout

1. Deploy schema-compatible code with `AUTH_MODE=dual`, learning/document V2 enabled only for the pilot, managed OCR off, resolver shadow mode on, pattern mode `observe`, and automatic selection off.
2. Verify actor/session/request attribution, compact-snapshot parity, Learn/reset replay, and Learned non-bookability.
3. Enable verified auth for the pilot, then switch production to `AUTH_MODE=verified_user` only after recovery is rehearsed.
4. Enable learning UI, Learn, reset, reliability, and drift observation for the pilot scope.
5. Review shadow evaluation by held-out supplier and format. Investigate every override, hard conflict, and manual-first violation.
6. Enable learned automatic selection only for approved canonical Exact supplier IDs. Expand by deterministic percentage only while the approved gate remains satisfied.

## Required monitoring

- Auth: session resolution failures, verification failures, revocations, and user status changes.
- Document analysis: adapter/model, source mode, duration, page count, fallback reason, and estimated request units; never document content.
- Learning: transaction success/failure, CAS conflict, projection parity, derivation lag, reset, migration, and pattern outcomes.
- Resolver: hashed supplier reference, cluster familiarity, score/margin gates, manual/automatic/override classification, precision lower bound, and policy violations.
- Booking: reservations, completion/uncertain outcomes, and every learning-only block.

Escalate immediately for any Exact call after a learning-only block, compact-snapshot/normalized-core mismatch, or resolver hard-conflict/policy violation. Disable automatic selection immediately if its precision gate is breached. Operational thresholds for sustained auth, learning, or OCR failure rates must be approved before production enablement.

## Rollback

1. Set learned automatic selection off; keep evidence collection and manual Exact search available.
2. Change supplier learning mode from `apply` to `observe` or `off`; do not delete evidence.
3. Disable managed OCR; embedded PDF/XML/plain extraction continues and scans become explicit manual-review cases.
4. Disable Learn/reset UI and routes if necessary; existing Learned invoices remain terminal and non-bookable.
5. Revert verified auth to `dual` only within the bounded compatibility window. Do not restore retired credentials after that window.
6. Do not down-migrate normalized tables and do not reactivate an old supplier generation by flag change.
7. After rollback, run the complete suite and explicitly verify that every `Learned` or `learning_only` invoice is rejected before any Exact call.

## Evidence to retain

Retain migration checksums/parity reports, test and build output, held-out evaluation reports, privacy/security approvals, rollback-drill results, and the production flag matrix. Do not retain raw cookies, tokens, passwords, invoice text, filenames, supplier identifiers, content hashes, or corrected values in release logs.
