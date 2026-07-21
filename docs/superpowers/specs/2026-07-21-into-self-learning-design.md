# INTO Supplier Self-Learning Design

## Goal

INTO learns supplier-specific extraction and booking behavior from explicitly trusted invoices and corrections, while deterministic validation and Exact Online booking gates remain authoritative.

## Architecture

The implementation is a hybrid pipeline: document analysis produces text plus positional evidence; generic rules generate field candidates; Exact master data resolves the supplier; active supplier patterns re-rank candidates; arithmetic, VAT, duplicate, and booking validation decide whether user attention is required. External OCR is provider-neutral and disabled unless explicitly configured.

Learning is supplier-scoped and generation-based. Learn, review, and successful booking create trusted examples; ordinary saves create pending corrections. Reset increments one supplier's generation and stops earlier examples and patterns from applying without deleting invoices, audits, or Exact history.

## User workflow

- **Learn** appears after Save changes. It atomically saves the current draft as a trusted example, marks the invoice `Learned`, sets `processingPurpose` to `learning_only`, and returns “Learning saved for this supplier.”
- Learning-only invoices are rejected by every server booking path.
- **Supplier learning** is a third workbench view with supplier reliability, example count, last learned time, and supplier-scoped reset.
- Reset uses the exact confirmation: “Reset learning for this supplier? INTO will forget previous training patterns for this supplier. Existing invoices and Exact bookings will not be deleted.”
- Supplier selection is shown only for ambiguous or low-confidence matches; a unique safe match is automatic.

## Confidence

Supplier reliability starts at 35%. Let `V = n/(n+2)`, let each observed metric use Beta smoothing `(successes+1)/(attempts+2)`, and let `Q` be their weighted mean. The score is `round(100 * clamp(0.35 + 0.65 * V * Q - driftPenalty, 0, 1))`. Possible drift subtracts 10 points and confirmed drift 20. Bands are High at 85+, Medium at 65–84, and Low below 65.

## Safety and privacy

- One invoice content hash contributes at most one active example per supplier generation.
- Learned locators store labels, context, datatype, and relative position, never variable invoice literals.
- Pending corrections do not become trusted until Learn, review, or successful booking.
- Exact validation and posting payloads are unchanged.
- OCR/provider calls are off by default; document content is never logged.
- Reset is a soft generation change and is auditable.

## Approved scope

Implement the practical in-repository foundation, end-to-end Learn/reset/confidence workflow, document-analysis contract, safer supplier resolution, and tests. Embeddings, custom ML training, and LLM extraction remain future work until measured evidence justifies them.
