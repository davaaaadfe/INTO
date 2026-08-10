# INTO Supplier Learning, Document Intelligence, and Verified-User Hardening

## Global constraints

- Work directly in the current checkout on `main`, as explicitly approved by the user.
- Preserve the existing Exact booking payload contract.
- Keep managed OCR and learned auto-selection disabled by default in production.
- Never allow `Learned` or `learning_only` invoices to reach Exact, regardless of flags.
- First unfamiliar supplier or document format always requires user-driven Exact supplier search; never show proactive ranked candidates.
- Later auto-selection requires prior explicit supplier/format confirmation, confidence at least `0.90`, margin at least `0.12`, no hard-identifier conflict, and either one unique hard identifier or two independent soft-signal families. BIC is support only.
- All authenticated people use the single `verified_user` access level. Deny unauthenticated, unverified, or disabled people server-side. Never persist a raw cookie/token/password.
- Learning patterns are evidence and may not bypass deterministic accounting, VAT, duplicate, Exact-account, required-field, or line-balance validation.
- Use existing SQLite/PostgreSQL drivers and existing normalized learning tables; do not make Drizzle authoritative.
- The durable runtime snapshot must remain compact. Important writes are idempotent, optimistic-concurrency-safe, and atomic across snapshot/core learning state.
- Preserve audit history and historical `shared_user` attribution; new operations carry verified actor, request, and opaque session correlation.
- Follow strict TDD: add a focused failing test, verify the expected failure, then implement the minimum passing production change.
- Production-only decisions that still require human approval remain safely disabled behind configuration.

## Tasks

### Task 1: Failure characterization and evaluation policy

Add focused red tests for the post-snapshot-CAS learning projection failure, additive pattern replay, stale PATCH, direct-route authorization, and manual-first resolver policy. Correct evaluation semantics so first supplier/format decisions are manual and shadow/manual/automatic outcomes are separate. No production behavior change beyond the minimum seams needed to make fault injection testable.

### Task 2: Auth schema and legacy-role migration

Add explicit SQLite/PostgreSQL auth migrations and a repository for users, credentials, invitations, sessions, and auth events. Idempotently map legacy Admin, Accountant, Reviewer, and Viewer values to `verified_user`; preserve `shared_user` as historical-only and deny unknown roles.

### Task 3: Verified sessions and request principal

Add versioned opaque revocable sessions, token digests, verified-principal resolution, origin checks for unsafe methods, and a central verified persistent-request wrapper. Support `legacy_password|dual|verified_user` rollout modes with legacy default.

### Task 4: Invitation, verification, users UI, and actor propagation

Add login/verification/session/logout and user invitation/status APIs, bootstrap support in dual mode, minimal UI, and explicit actor/request/session propagation through important operations. Prevent last-active-user lockout.

### Task 5: Snapshot schema v3 and invoice revision CAS

Make processing purpose, learning state, and invoice revision required through an idempotent snapshot migration. Require expected revision on every material invoice mutation and return current state on conflict.

### Task 6: Learning repository contract and schema v2

Export one SQLite/PostgreSQL learning repository contract. Introduce explicit numbered migrations, normalized corrections, migration ledger, evidence revisions, observation states, supersession support, and real PostgreSQL contract coverage.

### Task 7: Atomic Review, confirmation, Learn, and Reset commands

Replace the staged two-CAS projector with high-level transactional commands that atomically commit the compact snapshot and normalized core rows/events. Pattern derivation is rebuildable and tracked by evidence revisions.

### Task 8: Generation-zero migration and normalized read cutover

Migrate legacy supplier choices, corrections, and mappings as inactive generation-zero evidence with weight `0.35`. Keep only corroborated explicit Learn examples trusted. Cut reads over to normalized rows and ensure no active/pending corpus is serialized.

### Task 9: Canonical document-analysis contracts

Consolidate duplicated document types into one provider-neutral domain contract preserving pages, dimensions, tokens, polygons, confidence, languages, tables, raw text, source mode, provider/model, and provider outcome. Preserve compatibility with existing artifacts.

### Task 10: Provider-neutral OCR hardening

Formalize local, Azure, and deterministic test adapters. Keep external processing off by default. Preserve explicit unavailable/fallback outcomes instead of silently representing failed OCR as successful local extraction.

### Task 11: Generic candidates and immutable original prediction

Convert deterministic multilingual extraction rules into candidate producers, merge local/provider candidates with complete evidence, persist the immutable generic prediction, and remove filename patterns as production activation evidence.

### Task 12: Learn lifecycle and terminal Learned behavior

Route Learn through the atomic command with request idempotency, canonical Exact identity, observation states, supersession, exact response text, and unchanged-on-failure semantics. Centralize terminal Learned action policy across server and UI.

### Task 13: Structural clusters and pattern derivation

Add versioned structural format fingerprints, deterministic distance, multiple valid clusters, and absolute/idempotent pattern rebuilds scoped to the active generation.

### Task 14: Pattern evidence and correction outcomes

Replace direct learned overwrites with generation/cluster-scoped candidate emission or re-ranking. Persist application, acceptance, correction, rejection, and validation outcomes; deterministic validation remains authoritative.

### Task 15: Supplier-learning detail/reset API and UI

Add paginated overview/detail contracts, complete reliability/cluster/drift summaries, idempotent reset replay, canonical account checks, and accessible reset UI using the exact approved copy.

### Task 16: Reliability and drift consolidation

Make `supplierReliability` the only formula, derive outcomes from normalized evidence, and add versioned observe-first drift behavior with exact 10/20 point penalties and approved UI copy.

### Task 17: Exact search and manual-first resolver

Restore an accessible user-initiated Exact supplier combobox using synchronized canonical accounts. Remove proactive candidate buttons, add explicit manual reason codes, enforce prior supplier/format confirmation, and prevent BIC-primary matching.

### Task 18: Resolver shadow telemetry and held-out evaluation

Record sanitized shadow outcomes and update evaluation to use supplier/format holdouts, eligible-decision denominators, empirical precision, confidence bounds, coverage, overrides, and policy violations.

### Task 19: Supplier-scoped learned auto-selection

Add an off-by-default supplier/percentage rollout control. Enable automatic selection only when all fixed gates and the approved evaluation threshold are satisfied. Preserve explanation and override.

### Task 20: Remove shared permission/runtime-user behavior

After verified-mode compatibility is proven, remove role/permission branching, `train`, `manage_learning`, `requireSystemOwner` for human workflows, shared permission arrays, and destructive current-user coercion.

### Task 21: Retire legacy learning compatibility

After soak, remove the staged projector, old reason aliases, filename activation, direct learned overwrites, and completed runtime status compatibility while preserving migration fixtures and stored history.

### Task 22: Final QA, review, monitoring, and rollback verification

Run the full typecheck, test, lint, and build gates; SQLite and real PostgreSQL suites; privacy/security checks; held-out evaluation; Exact contract tests; feature rollback drills; and whole-branch review. Do not enable managed OCR or learned auto-selection in production without the outstanding approvals.
