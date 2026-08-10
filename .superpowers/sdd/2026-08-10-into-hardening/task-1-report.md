# Task 1 report: failure characterization and evaluation policy

## Files changed

- `lib/repository/invoice-store.ts`
  - Added the minimal, non-exported fault-injection hook immediately after a
    successful snapshot CAS and before normalized-learning projection.
- `lib/services/learning-evaluation.ts`
  - Added explicit manual, shadow, eligible-automatic, and override outcomes.
  - Counts auto precision/recall only for eligible automatic decisions.
  - Added the disabled production gate: precision `0.995`, 95% lower bound
    `0.99`, zero policy violations, 500 eligible decisions, and 50 suppliers.
- `tests/fixtures/ml-golden-corpus.json`
  - Records manual evaluation outcomes for first unfamiliar supplier/format
    cases; only established decisions are eligible automatic selections.
- `tests/learning-evaluation.test.ts`
  - Covers the four selection outcomes and disabled production gate.
- `tests/learning-persistence-integration.test.ts`
  - Characterizes the post-CAS projection-failure window with real SQLite
    persistence.
- `tests/sqlite-learning-repository.test.ts`
  - Characterizes duplicate counter increments from separate repository
    writers replaying the same pattern projection.
- `tests/invoice-route-characterization.test.ts`
  - Characterizes stale ordinary PATCH acceptance and direct-handler session
    authorization bypass.

## Red/green evidence

1. Evaluation semantics (production behavior):
   - RED: `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/learning-evaluation.test.ts`
   - Observed failure: the new outcome test received four auto selections and
     had none of the required outcome/policy metrics.
   - GREEN: the same command passed all 4 tests after the minimal evaluation
     change and fixture provenance updates.
   - Review follow-up RED: the 559/560 precision boundary incorrectly passed
     after its 95% Wilson lower bound rounded from `0.989954...` to `0.99`.
   - Review follow-up GREEN: the raw bound now controls the gate while the
     rounded value remains reporting-only; 5/5 focused evaluation tests pass.
2. Post-CAS fault seam (production behavior):
   - RED: `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/learning-persistence-integration.test.ts`
   - Observed failure: `Missing expected rejection` because no hook executed
     between the successful snapshot CAS and learning projection.
   - GREEN: the same command passed all 9 tests once the one internal hook was
     invoked at that boundary.
3. Characterization-only tests:
   - Independent writer replay, stale PATCH, and direct-handler bypass tests
     intentionally pass while naming the undesirable current behavior. They
     are safety-net expectations for later Tasks 5, 7, and 17-19.

## Verification

- `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/learning-evaluation.test.ts` — 5/5 passed.
- `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/learning-persistence-integration.test.ts` — 9/9 passed.
- `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/sqlite-learning-repository.test.ts` — 12/12 passed.
- `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/invoice-route-characterization.test.ts` — 2/2 passed.
- `node ./node_modules/typescript/bin/tsc --noEmit` — passed.
- `node ./node_modules/eslint/bin/eslint.js lib/repository/invoice-store.ts lib/services/learning-evaluation.ts tests/learning-evaluation.test.ts tests/learning-persistence-integration.test.ts tests/sqlite-learning-repository.test.ts tests/invoice-route-characterization.test.ts` — passed.
- `node --experimental-strip-types --loader ./tests/ts-extension-loader.mjs --test tests/*.test.ts` — 309/309 passed, 0 failures.
- `git diff --check` — passed.

The repository has no `npm` executable on PATH in this environment, so the
equivalent project test command used the bundled Node 24 executable directly.

## Self-review

- The Exact payload, authentication implementation, database schema, and UI
  were not changed.
- The resolver's existing `0.90` confidence, `0.12` margin, one-hard/two-soft
  evidence gate, and BIC-support-only behavior remain unchanged.
- The evaluation gate is data-only and explicitly disabled; it cannot enable
  production auto-selection.
- A post-implementation read-only review identified a confidence-bound
  rounding error; the raw Wilson bound now controls gate eligibility.
- The fault hook is private to the module's global runtime state, executes
  only when explicitly installed, and exercises actual snapshot and normalized
  repository writes around the intended boundary.
- The unrelated untracked hardening plan was preserved.

## Concerns

- The route characterization proves a configured password with no valid
  session still permits a direct handler call. The Node test runner cannot
  import `proxy.ts` itself because its `next/server` import is bundler-resolved;
  the test therefore checks the same invalid-session condition through
  `verifyIntoAccessSession` and invokes the actual route handler directly.
- The failing projection and replay behavior are deliberately left in place;
  follow-on hardening tasks must replace these undesirable expectations.
