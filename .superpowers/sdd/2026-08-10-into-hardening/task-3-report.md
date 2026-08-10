# Task 3 report — verified sessions and request principal

Status: DONE_WITH_CONCERNS

## Delivered

- Added `AUTH_MODE` parsing with a safe `legacy_password` default.
- Added versioned opaque verified-session tokens, digest-only persistence, revocation, bounded last-seen updates, and explicit verified/legacy principals.
- Added auth schema migration v4 plus SQLite and PostgreSQL session lifecycle methods.
- Added the authoritative protected-request wrapper and wired it through persistent protected API routes; `proxy.ts` is now early rejection only.
- Added dual/verified unsafe-method origin validation using explicit exact trusted origins; forwarded headers never establish trust.
- Kept auth-repository cache loads identity-aware and preserved the resolved principal's request/session context through persistence and route authorization.

## TDD evidence

- RED: `tests/verified-session-auth.test.ts` initially failed because `lib/services/verified-session-auth.ts` did not exist.
- GREEN: focused auth/session tests passed after the minimal implementation.

## Verification

- Focused auth/session suite: 27 passed, 0 failed.
- Full `pnpm test`: 336 passed, 0 failed.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.

## Concerns

- PostgreSQL has SQL-contract coverage only; no live PostgreSQL service was available in this workspace.
- The existing Node test harness receives an explicit test-only legacy principal when no shared password is configured. Production continues to fail closed with `503` in that condition.
