# Task 4 report — credential and invitation workflows

Status: DONE_WITH_CONCERNS

## Delivered

- Added versioned scrypt credentials with random salts, bounded inputs, explicit parameters, and constant-time comparison.
- Added deterministic, digest-only one-time invitations with idempotent replay, atomic verification/activation/session issuance, expiry and replay protection, and sanitized auth events.
- Added verified login, persisted known-user failure/lockout tracking, safe session lookup, idempotent logout/revocation, safe user listing, and optimistic user-status changes with final-active-user protection.
- Implemented the legacy/dual/verified API matrix while retaining `legacy_password` as the default and limiting dual legacy bootstrap after two active verified users.
- Added forward-only auth schema v5 changes plus transactional SQLite commands and PostgreSQL CTE command contracts.
- Added the minimal mode-aware login, verification, signed-in actor/logout, and Users interfaces without roles or client permission arrays.
- Propagated the Task 3 principal through request-local `AsyncLocalStorage` so verified upload, review, supplier, duplicate/review/approval, learning/reset, Exact, and booking events inherit the verified actor, request ID, and opaque session correlation. Legacy requests retain the explicit shared actor.

## TDD evidence

- RED: focused credential/invitation tests initially failed on missing credential and invitation repository/service commands.
- GREEN: scrypt, invitation replay/conflict/consume concurrency, login lockout, safe-user/status CAS, handler-flow, PostgreSQL SQL-contract, and actor-context tests passed after implementation.
- RED: a direct cross-origin verified-login handler assertion initially returned the wrong status.
- GREEN: unsafe verified login now maps origin rejection to `403`; direct invitation/status boundary assertions also pass through the authoritative request wrapper.

## Verification

- Focused auth/route suite: 41 passed, 0 failed.
- Full `pnpm test`: 346 passed, 0 failed.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm run build`: passed; Next.js compiled, typechecked, generated all 22 static pages, and finalized route output.
- `git diff --check`: passed.

## Concerns

- PostgreSQL atomic commands have SQL-contract coverage only; no live PostgreSQL service was available in this workspace.
- Public verification throttling is intentionally process-local and conservative. A shared limiter is required before relying on aggregate limits across multiple application instances.
- No email delivery, SSO, or auth vendor was added. Invitation links remain manual, and production stays on the legacy default until explicitly configured otherwise.
