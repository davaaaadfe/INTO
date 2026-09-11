# INTO hardening release runbook

This runbook applies to the password-only access, supplier-learning, document-analysis, and resolver hardening rollout. The September 2026 password-only decision supersedes the earlier verified-person/invitation rollout. Migrations are expand-only. Never use a rollback to disable the learning-only booking guard.

## Release prerequisites

1. Back up the runtime and normalized auth/learning databases.
2. Run `npm run db:migrate:postgres` with the production `DATABASE_URL` available locally before application traffic. Retain its count-free schema-version result with the release evidence.
3. Run `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build` with the release artifact.
4. Run the repository contract and concurrency suites against both SQLite and a real PostgreSQL service. For the disposable Neon gate, set `INTO_POSTGRES_INTEGRATION_DATABASE_URL` in `.env.local` and run `pnpm run test:postgres`; the test applies idempotent migrations, verifies rollback, checks booking reservations with a fake Exact provider, and restores its test snapshot. Use a dedicated disposable endpoint with no application traffic or concurrent test runner. The endpoint must differ from production.
5. Confirm `INTO_ACCESS_PASSWORD` contains a long, private shared password and that the deployed site's HTTPS origin is trusted through `INTO_TRUSTED_ORIGINS`, `APP_URL`, or the Vercel deployment URL configuration. No email, display name, invitation, second user, or auth database is required to sign in. Old `AUTH_MODE` values have no effect on access.
6. Confirm managed OCR privacy/region/retention approval before enabling `DOCUMENT_INTELLIGENCE_ENABLED`.
7. Confirm the approved held-out resolver gate before enabling automatic supplier selection: empirical precision at least 99.5%, 95% lower confidence bound at least 99%, zero policy violations, and at least 500 eligible decisions across 50 suppliers.
8. Configure a unique `INTO_STORAGE_CLEANUP_TOKEN` of at least 32 characters for the machine scheduler, separate from the entrance password. For Vercel Cron, set `CRON_SECRET` to the exact same cleanup-token value; Vercel invokes the secured cleanup route daily at 03:00 UTC. Manual machine calls use `POST /api/storage/cleanup` with `Authorization: Bearer <token>`; browser sessions are intentionally rejected.
9. Keep `EXACT_ONLINE_ENABLE_REAL_BOOKING=false` until the approved Exact test-division smoke test and reconciliation recovery drill pass. Mocked payload tests and disposable PostgreSQL tests do not authorize production bookings.

## Staged rollout

1. Deploy schema-compatible password-only code with learning/document V2 enabled only for the pilot, managed OCR off, resolver shadow mode on, pattern mode `observe`, and automatic selection off. Do not enable real booking during this access change.
2. Verify actor/session/request attribution, compact-snapshot parity, Learn/reset replay, and Learned non-bookability.
3. Verify that the correct shared password opens INTO, incorrect passwords fail, no personal details are requested, and Lock INTO returns to the password screen. Test an invoice read/save and an Exact connection in the approved pilot scope. All shared-password sessions have identical human capabilities; feature flags and invoice safety checks still apply.
4. Enable learning UI, Learn, reset, reliability, and drift observation for the pilot scope.
5. Review shadow evaluation by held-out supplier and format. Investigate every override, hard conflict, and manual-first violation.
6. Enable learned automatic selection only for approved canonical Exact supplier IDs. Expand by deterministic percentage only while the approved gate remains satisfied.

## Required monitoring

- Auth: incorrect-password attempts, rate limits, rejected origins, and expired/tampered-session denials. Never record submitted credentials. New audit events use Shared access and an opaque session correlation, not a person's identity.
- Document analysis: adapter/model, source mode, duration, page count, fallback reason, and estimated request units; never document content.
- Learning: transaction success/failure, CAS conflict, projection parity, derivation lag, reset, migration, and pattern outcomes.
- Resolver: hashed supplier reference, cluster familiarity, score/margin gates, manual/automatic/override classification, precision lower bound, and policy violations.
- Booking: reservations, completion/uncertain outcomes, and every learning-only block.
- Storage cleanup: machine-attributed completion events and deleted/pruned counts only; never invoice records, invoice IDs, or the bearer token.

Escalate immediately for any Exact call after a learning-only block, compact-snapshot/normalized-core mismatch, or resolver hard-conflict/policy violation. Disable automatic selection immediately if its precision gate is breached. Operational thresholds for sustained auth, learning, or OCR failure rates must be approved before production enablement.

## Rollback

1. Set learned automatic selection off; keep evidence collection and manual Exact search available.
2. Change supplier learning mode from `apply` to `observe` or `off`; do not delete evidence.
3. Disable managed OCR; embedded PDF/XML/plain extraction continues and scans become explicit manual-review cases.
4. Disable Learn/reset UI and routes if necessary; existing Learned invoices remain terminal and non-bookable.
5. Use a password-only compatible rollback build. Old `AUTH_MODE` values and old personal-session cookies cannot enable account login. Rotating `INTO_ACCESS_PASSWORD` and redeploying invalidates existing shared sessions. Do not reactivate invitations or delete historical auth records as a rollback step.
6. Do not down-migrate normalized tables and do not reactivate an old supplier generation by flag change.
7. After rollback, run the complete suite and explicitly verify that every `Learned` or `learning_only` invoice is rejected before any Exact call.
8. Once booking reservations have been used, the rollback build must understand `bookingOperation` and block both `reserved` and `uncertain` operations. Snapshot schema v3 support alone is insufficient. Do not roll back to a pre-reservation build while these operations exist.

## Password-only access operations

The login/session routes do not open the auth database. Retired account and invitation endpoints return no personal records, and old verification links return to the entrance. Historical users, credentials, audit attribution, invoices, and normalized learning evidence are retained for data compatibility; this release does not purge them.

Sessions expire after 12 hours. Lock INTO clears cookies in that browser; it does not revoke a copied cookie elsewhere. To end every session, change the shared password and redeploy. Individual attribution or per-person revocation is not available under the approved shared-password model. Reconnect Exact if an authorization flow was started before this release or before rotating the password; callbacks require the same shared browser session that started them.

Login attempts are bounded per application instance. Configure ingress-wide rate limiting before broader exposure if needed; an in-process limit is not a cross-instance defense. Only set `INTO_TRUSTED_SOURCE_HEADER` when the trusted ingress overwrites it, never to an arbitrary client-controlled header. With no trusted source, requests share a bounded unattributed quota. Keep secrets out of screenshots, chat, source control, and logs.

## Booking reconciliation

Single booking requires `Idempotency-Key` (or body `requestKey`) and `expectedRevision`. Bulk booking requires a batch request key and 1–100 unique `{invoiceId, expectedRevision}` items. A completed invoice/key/input-revision replay returns the stored result without another Exact call. Changed keys never unlock a pending operation.

Before the first Exact POST, INTO commits a snapshot-CAS reservation. It then saves the returned document, attachment, and purchase-entry IDs before proceeding. Booked state is committed before temporary attachment deletion. Any interruption after reservation leaves a durable lock, even if no usable provider response arrived. There is no timed expiry or automatic repost.

When an invoice says booking is in progress or requires reconciliation:

1. Do not retry with another key, edit the invoice, clear `bookingOperation`, or manually upload/book another copy.
2. Have the responsible Exact operator inspect the division's purchase entry and attachment records. A timeout does not prove the operation failed. Save the evidence privately; do not place invoice values or provider responses in logs.
3. Keep the original invoice and file. The cleanup scheduler skips pending and uncertain bookings.
4. Recovery requires an audited, revision-safe reconciliation operation after the Exact outcome is established. This release intentionally has no unlock button or automatic recovery endpoint. Keep real booking disabled until that recovery workflow is implemented and rehearsed.

## Evidence to retain

Retain migration checksums/parity reports, test and build output, held-out evaluation reports, privacy/security approvals, rollback-drill results, and the production flag matrix. Do not retain raw cookies, tokens, passwords, invoice text, filenames, supplier identifiers, content hashes, or corrected values in release logs.
