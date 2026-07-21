# INTO Supplier Self-Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explainable supplier-scoped learning workflow that improves extraction and booking suggestions without weakening Exact Online safeguards.

**Architecture:** Reuse INTO's deterministic extraction, correction, and booking intelligence. Store the growing learning corpus in explicit SQLite/PostgreSQL learning tables, with the revision-protected runtime snapshot as the mutation commit point and an idempotent normalized projection. Encrypt document-analysis artifacts, keep only their references in compact snapshots, and preserve generation/reset history.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Node test runner, SQLite/Neon runtime snapshots.

## Global Constraints

- Exact arithmetic, VAT, duplicate, attachment, master-data, and booking-line validation remain hard gates.
- Learn never calls Exact Online; single booking rejects `processingPurpose: "learning_only"` and bulk booking excludes it.
- New supplier reliability starts at 35%; High is 85+, Medium is 65–84, Low is below 65.
- Reset affects one Exact supplier only and preserves invoices, audit history, Exact master data, purchase history, and booking records.
- Exact reset copy and Learn confirmation copy must be used verbatim.
- External OCR is disabled by default and must have a deterministic local fallback.
- No embeddings, vector database, custom model training, or LLM extraction in this implementation.
- Follow TDD: add each focused test, observe the expected failure, then add minimum production code.

---

### Task 1: Learning domain and engine

**Files:**
- Modify: `lib/domain/invoice.ts`
- Create: `lib/services/supplier-learning.ts`
- Test: `tests/supplier-learning.test.ts`

**Produces:** `SupplierLearningProfile`, `SupplierLearningExample`, `SupplierLearningPattern`, `SupplierConfidenceBreakdown`, `supplierConfidence`, `learnSupplierInvoice`, `resetSupplierLearning`, and `formatFingerprint`.

- [x] Add failing tests for 35% baseline, gradual confidence, duplicate-example idempotency, supplier isolation, generation reset, and format drift.
- [x] Add the smallest domain types and pure functions needed to pass.
- [x] Add `Learned`, `processingPurpose`, learning metadata, revision, `train`, and `manage_learning` to shared types/defaults.
- [x] Run focused tests and the existing correction/intelligence tests.

### Task 2: Repository workflow, APIs, and booking safety

**Files:**
- Modify: `lib/repository/invoice-store.ts`, booking services/routes, and shared persistence normalization.
- Create: `app/api/invoices/[invoiceId]/learn/route.ts`, `app/api/suppliers/[accountId]/learning/reset/route.ts`, supplier-learning query route.
- Test: `tests/repository-learning.test.ts`, `tests/purchase-journal-intelligence.test.ts`, route/service tests.

**Consumes:** Task 1 learning types/functions.

- [x] Add failing tests proving Learn saves the live corrected invoice, is idempotent, returns `Learned`, and never books.
- [x] Add failing tests proving single booking rejects and bulk booking excludes learning-only invoices.
- [x] Add failing tests proving reset is generation-checked and preserves invoices/Exact history.
- [x] Implement repository operations, audit events, permissions, route validation, and hydration defaults.
- [x] Run focused tests and all repository/Exact tests.

### Task 3: Document analysis and supplier resolution V2

**Files:**
- Modify: `lib/services/invoice-document-text.ts`, `lib/services/invoice-extraction-service.ts`, `lib/services/purchase-journal-intelligence.ts`, `lib/services/correction-learning.ts`.
- Create: `lib/services/document-analysis.ts`, `lib/services/supplier-identity.ts`.
- Test: extraction, correction-learning, and purchase-journal intelligence tests.

**Produces:** provider-neutral pages/tokens/polygons, optional Azure adapter guarded by `DOCUMENT_INTELLIGENCE_ENABLED`, canonical identity normalization, evidence-fusion supplier resolver, and pending/trusted correction semantics.

- [x] Add failing tests for layout preservation, disabled/failing OCR fallback, hard-identifier conflicts, BIC as supporting evidence only, score/margin ambiguity, and correction promotion.
- [x] Implement the contracts and local analysis adapter without new dependencies.
- [x] Remove production filename-derived supplier identity; keep fixture behavior test-scoped where needed.
- [x] Stop emitting `Supplier Review Required`; use booking-intelligence review reason codes.
- [x] Run all extraction/correction/intelligence tests.

### Task 4: Learn and Supplier learning UI

**Files:**
- Modify: `components/into-workbench.tsx`, related styles/types, and `tests/review-ui.test.ts`.

**Consumes:** Learn/reset/query APIs and supplier learning summaries.

- [x] Add failing UI contract tests for Learn placement/copy, third view, confidence labels, contextual supplier chooser, and exact reset dialog copy/buttons.
- [x] Add Learn after Save and post the current draft atomically.
- [x] Add Supplier learning overview/detail and accessible reset dialog.
- [x] Show Supplier reliability separately from invoice match confidence.
- [x] Remove the persistent supplier warning card while retaining contextual candidate selection.
- [x] Run UI tests, typecheck, and focused service tests.

### Task 5: Integration, migration, and release verification

**Files:**
- Modify tests/config/documentation only as required by verified integration failures.

- [x] Add hydration/migration tests for legacy snapshots and Learned invoices.
- [x] Add required scenario coverage for zero/one/multiple examples, changed format, duplicate suppliers, corrections, Learn, reset, and future invoice reuse.
- [x] Review all changes for sensitive-data logging and accidental Exact calls.
- [x] Run `typecheck`, `lint`, the complete test suite, and production build.
- [x] Request a whole-branch code review and resolve Critical/Important findings.
