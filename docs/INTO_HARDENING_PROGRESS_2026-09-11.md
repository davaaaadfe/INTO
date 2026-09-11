# Hardening progress — 2026-09-11

## Password-only access replaces the earlier personal-account rollout

The user's updated decision is implemented directly in the main checkout. The existing shared entrance password grants equal access to every enabled human workflow. Login no longer asks for email, user ID, or display name. Users/invitation controls are removed, old verification links redirect home, and retired personal-account endpoints return no personal records. `AUTH_MODE` cannot reactivate them.

Login and session resolution no longer depend on auth-database availability. Shared sessions retain signed 12-hour expiry, server-side verification, same-origin protection for unsafe requests, bounded password guesses, and an opaque per-session audit correlation. Rotating the entrance password invalidates existing shared sessions. Lock INTO clears the local browser cookie; this stateless model does not individually revoke copied cookies or identify which person acted.

Exact authorization now binds signed callback state to the same valid shared browser session that initiated it. Old personal/legacy states, missing/different/expired cookies, and changed passwords cannot reach the token exchange. New audit attribution uses Shared access. Existing historic attribution and auth tables remain unchanged; no data purge or schema migration is part of this access change.

The existing password/session implementation and bounded limiter were reused; no authentication vendor, parallel store, or dependency was added. The two unused account UI components were removed and remain recoverable through Git. TSX support in the test loader uses the already-installed TypeScript compiler for rendered UI tests.

## Verification

- Full deterministic suite: **451 passed**, zero failures.
- Real disposable PostgreSQL suite: **5 passed**, including migrations, transactional rollback, concurrent learning/reset, and durable booking reservation behavior. Historical auth repository compatibility remains covered even though those account APIs are retired.
- Typecheck, full ESLint, production build, and diff whitespace checks: passed.
- **13 isolated production-build HTTP checks passed**: password-only HTML, locked invoice route, rejection of personal cookies, incorrect-password and foreign-origin denial, correct-password login, shared workbench without Users, minimal session response, authenticated invoice access, retired user endpoint, machine-only cleanup denial, verification redirect, and logout cookie clearing. This server used memory-only data and throwaway credentials; no production database or real Exact calls were used.
- Independent read-only security review: no important introduced findings. Existing non-production mock callback behavior remains test-only; production rejects mock callbacks.

Focused tests first reproduced the old auth-database dependency and missing password-only/session policies. The full-suite follow-up corrected a production-mode test fixture to supply a real shared session; the production authentication check was not weakened to accommodate it.

## Release boundaries and next steps

This batch is local, not pushed or deployed. The existing `INTO_ACCESS_PASSWORD` remains the entrance secret; no invitation secret, second user, or account bootstrap is needed. The current release runbook and original plan now explicitly record the superseding access decision.

Keep managed OCR, learned automatic supplier selection, and real Exact booking disabled during the safe pilot. Machine cleanup continues to require its separate bearer token; browser password access does not authorize it. Learning feature flags, revision CAS, validation, and permanent Learned non-bookability are unchanged.

The wider program still has production gates: current backup/schema verification before future production migrations, an audited Exact reconciliation workflow and approved test-division recovery drill before real booking, representative held-out supplier/format evaluation before auto-selection, broader rendered accessibility checks, and operational monitoring/rollback sign-off. This access change does not claim those gates are complete. Follow `INTO_HARDENING_RELEASE_RUNBOOK.md`; do not restore personal-account login from an older checklist.
