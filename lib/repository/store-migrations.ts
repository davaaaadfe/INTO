import type { IntoStore } from "./invoice-store";

export const CURRENT_STORE_SCHEMA_VERSION = 2;

type VersionedStore = IntoStore & {
  schemaVersion?: number;
  revision?: number;
  legacyLearningRollback?: unknown;
};

type MutableRecord = Record<string, unknown>;

export function migrateStoreSnapshot(snapshot: IntoStore): IntoStore {
  const migrated = structuredClone(snapshot) as VersionedStore;
  const sourceVersion = migrated.schemaVersion ?? 0;
  if (sourceVersion > CURRENT_STORE_SCHEMA_VERSION) {
    throw new Error(
      `INTO snapshot schema ${sourceVersion} is newer than supported schema ${CURRENT_STORE_SCHEMA_VERSION}.`
    );
  }

  const migratingLegacyLearning = sourceVersion < CURRENT_STORE_SCHEMA_VERSION;
  if (
    migratingLegacyLearning &&
    !migrated.legacyLearningRollback &&
    migrated.learning
  ) {
    migrated.legacyLearningRollback = structuredClone(migrated.learning);
  }

  const learning = migrated.learning as unknown as MutableRecord | undefined;
  const corrections = Array.isArray(learning?.corrections)
    ? (learning.corrections as MutableRecord[])
    : [];
  if (migratingLegacyLearning) {
    for (const correction of corrections) {
      correction.trustState ??= "legacy";
      correction.generation ??= 0;
      correction.confidence = Math.min(Number(correction.confidence ?? 0.5), 0.6);
      correction.metadata = {
        ...((correction.metadata as MutableRecord | undefined) ?? {}),
        migratedLegacyEvidence: true,
      };
    }
  }

  for (const invoice of migrated.invoices) {
    const mutableInvoice = invoice as unknown as MutableRecord;
    if (invoice.status === "Supplier Review Required") {
      mutableInvoice.status = "Booking Intelligence Review Required";
      const purchaseJournal = mutableInvoice.purchaseJournal as
        | MutableRecord
        | null
        | undefined;
      const resolution = purchaseJournal?.supplierResolution as
        | MutableRecord
        | undefined;
      if (resolution) {
        const reasons = Array.isArray(resolution.reasoning)
          ? resolution.reasoning.map(String)
          : [];
        resolution.reasonCode = reasons.some((reason) =>
          /multiple|ambiguous|duplicate/i.test(reason)
        )
          ? "supplier_ambiguous"
          : "supplier_low_confidence";
      }
    }
    if (invoice.status === "Learned") {
      mutableInvoice.processingPurpose = "learning_only";
      mutableInvoice.learningState = "saved";
      mutableInvoice.exactBookingStatus = "not_booked";
    }
    mutableInvoice.revision ??= 1;
  }

  migrated.schemaVersion = CURRENT_STORE_SCHEMA_VERSION;
  migrated.revision ??= 0;
  return migrated;
}
