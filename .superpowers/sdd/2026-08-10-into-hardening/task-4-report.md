# Task 4 report — credential and invitation workflows

Status: DONE_WITH_CONCERNS

## Delivered

- Added versioned scrypt credentials with random salts, bounded inputs, explicit parameters, and constant-time comparison.
- Added deterministic, digest-only one-time invitations with idempotent replay, atomic verification/activation/session issuance, expiry and replay protection, and sanitized auth events.
- Added verified login with one fixed scrypt verification for allowed known and unknown identities, bounded HMAC-keyed per-identity and aggregate source/global throttling before scrypt, known-user-only bounded credential failure state/events, safe session lookup, mode-aware idempotent logout/revocation, safe user listing, and optimistic user-status changes with final-active-user protection.
- Implemented the legacy/dual/verified API matrix while retaining `legacy_password` as the default and limiting dual legacy bootstrap after two active verified users.
- Added forward-only auth schema v5, v6, and v7 changes plus transactional SQLite commands and PostgreSQL CTE command contracts. Immutable v6 is retained in history while v7 removes the obsolete durable throttle table. PostgreSQL invitation conflicts return and fingerprint the winning row, and status changes lock all active-user rows in deterministic order before evaluating the final-user invariant.
- Added the minimal mode-aware login, verification, signed-in actor/logout, and Users interfaces without roles or client permission arrays. Dual legacy sessions expose only the bounded invite capability, never a fabricated verified actor.
- Propagated the Task 3 principal through request-local `AsyncLocalStorage` so verified upload, review, supplier, duplicate/review/approval, learning/reset, Exact, and booking events inherit the verified actor, request ID, and opaque session correlation. Legacy requests retain the explicit shared actor.
- Bound real Exact OAuth state to signed safe user/session/repository identifiers only. The public callback ignores its cookie, re-resolves the current configured repository and mode, and requires the initiating session and user to remain current, unrevoked, unexpired, active, and verified before any Exact mutation.
- Preserved default legacy logout without requiring new origin configuration; verified and dual unsafe requests trust only explicit origins, `APP_URL`, or authenticated Vercel deployment configuration. `.env.example` documents the auth mode, invitation secret, trusted origins, and optional trusted source header.
- Sanitized general audit records to field identifiers, change classifications, and bounded scalar metadata; raw old/new document, evidence, and line values remain outside general audit.

## TDD evidence

- RED: focused credential/invitation tests initially failed on missing credential and invitation repository/service commands.
- GREEN: scrypt, invitation replay/conflict/consume concurrency, login lockout, safe-user/status CAS, handler-flow, PostgreSQL SQL-contract, and actor-context tests passed after implementation.
- RED: a direct cross-origin verified-login handler assertion initially returned the wrong status.
- GREEN: unsafe verified login now maps origin rejection to `403`; direct invitation/status boundary assertions also pass through the authoritative request wrapper.
- RED: review tests reproduced PostgreSQL cross-target final-user and invitation-key races, double-work unknown login, unknown-user throttle disclosure, global verification limiter coupling, legacy verified-flow access, unreachable bootstrap UI, unbound OAuth callback actor, raw audit values, cross-origin logout, and non-positive versions.
- GREEN: focused persistence/service/handler/UI/OAuth/audit contracts now cover each corrected behavior, including pre-scrypt rejection at limiter ceilings and verified callback actor/request/session attribution.
- RED: second-review tests reproduced unbounded verification keys and aggregate bypass, durable unknown-login growth, OAuth authorization surviving session/user/mode/repository changes, and default legacy logout failing without new origin configuration.
- GREEN: bounded limiter tests cover per-subject and aggregate ceilings, deterministic hard caps, expiry pruning, and preservation of an active scope at capacity; login tests prove identical known/unknown status and work sequences with zero unknown persistence; OAuth tests cover revoke, expiry, disable, mode cutover, repository identity switch, and pre-exchange rejection; logout tests cover legacy default and trusted server origins.

## Verification

- Focused auth/repository/route/UI/OAuth suite: 46 passed, 0 failed.
- Full `pnpm test`: 354 passed, 0 failed.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm run build`: passed; Next.js compiled, typechecked, generated all 22 static pages, and finalized route output.
- `git diff --check`: passed.

## Concerns

- PostgreSQL atomic commands have SQL-contract coverage only; no live PostgreSQL service was available in this workspace.
- Login and public-verification throttling are bounded and conservative but intentionally process-local. A shared limiter is required before relying on aggregate limits across multiple application instances.
- No email delivery, SSO, or auth vendor was added. Invitation links remain manual, and production stays on the legacy default until explicitly configured otherwise.
