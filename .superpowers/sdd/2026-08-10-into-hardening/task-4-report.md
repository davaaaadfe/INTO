# Task 4 report — credential and invitation workflows

Status: DONE_WITH_CONCERNS

## Delivered

- Added versioned scrypt credentials with random salts, bounded inputs, explicit parameters, and constant-time comparison.
- Added deterministic, digest-only one-time invitations with idempotent replay, atomic verification/activation/session issuance, expiry and replay protection, and sanitized auth events.
- Added verified login with one fixed scrypt verification for known and unknown identities, persisted hashed-scope throttling for both paths, safe session lookup, same-origin idempotent logout/revocation, safe user listing, and optimistic user-status changes with final-active-user protection.
- Implemented the legacy/dual/verified API matrix while retaining `legacy_password` as the default and limiting dual legacy bootstrap after two active verified users.
- Added forward-only auth schema v5 and v6 changes plus transactional SQLite commands and PostgreSQL CTE command contracts. PostgreSQL invitation conflicts return and fingerprint the winning row, and status changes lock all active-user rows in deterministic order before evaluating the final-user invariant.
- Added the minimal mode-aware login, verification, signed-in actor/logout, and Users interfaces without roles or client permission arrays. Dual legacy sessions expose only the bounded invite capability, never a fabricated verified actor.
- Propagated the Task 3 principal through request-local `AsyncLocalStorage` so verified upload, review, supplier, duplicate/review/approval, learning/reset, Exact, and booking events inherit the verified actor, request ID, and opaque session correlation. Legacy requests retain the explicit shared actor.
- Bound real Exact OAuth state to the signed initiating principal and restored that context during the public callback without trusting callback cookies.
- Sanitized general audit records to field identifiers, change classifications, and bounded scalar metadata; raw old/new document, evidence, and line values remain outside general audit.

## TDD evidence

- RED: focused credential/invitation tests initially failed on missing credential and invitation repository/service commands.
- GREEN: scrypt, invitation replay/conflict/consume concurrency, login lockout, safe-user/status CAS, handler-flow, PostgreSQL SQL-contract, and actor-context tests passed after implementation.
- RED: a direct cross-origin verified-login handler assertion initially returned the wrong status.
- GREEN: unsafe verified login now maps origin rejection to `403`; direct invitation/status boundary assertions also pass through the authoritative request wrapper.
- RED: review tests reproduced PostgreSQL cross-target final-user and invitation-key races, double-work unknown login, unknown-user throttle disclosure, global verification limiter coupling, legacy verified-flow access, unreachable bootstrap UI, unbound OAuth callback actor, raw audit values, cross-origin logout, and non-positive versions.
- GREEN: focused persistence/service/handler/UI/OAuth/audit contracts now cover each corrected behavior, including one verification on already-locked requests and verified callback actor/request/session attribution.

## Verification

- Focused auth/repository/route/UI/OAuth suite: 37 passed, 0 failed.
- Full `pnpm test`: 350 passed, 0 failed.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm run build`: passed; Next.js compiled, typechecked, generated all 22 static pages, and finalized route output.
- `git diff --check`: passed.

## Concerns

- PostgreSQL atomic commands have SQL-contract coverage only; no live PostgreSQL service was available in this workspace.
- Public verification throttling is intentionally process-local and conservative. A shared limiter is required before relying on aggregate limits across multiple application instances.
- No email delivery, SSO, or auth vendor was added. Invitation links remain manual, and production stays on the legacy default until explicitly configured otherwise.
