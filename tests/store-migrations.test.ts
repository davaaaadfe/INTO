import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_STORE_SCHEMA_VERSION,
  migrateStoreSnapshot,
} from "../lib/repository/store-migrations";
import type { IntoStore } from "../lib/repository/invoice-store";

function legacySnapshot() {
  return {
    users: [],
    currentUserId: "shared_user",
    invoices: [
      {
        id: "legacy-supplier-review",
        status: "Supplier Review Required",
        exactBookingStatus: "not_booked",
        purchaseJournal: {
          supplierResolution: {
            reviewRequired: true,
            reasoning: ["Multiple Exact suppliers match this identity."],
          },
        },
      },
      {
        id: "legacy-learned",
        status: "Learned",
        processingPurpose: "booking",
        learningState: "none",
        exactBookingStatus: "booked",
      },
    ],
    exactConnections: [],
    exactMasterDataCaches: [],
    supplierOverviewImport: null,
    duplicateLogs: [],
    auditEvents: [],
    learning: {
      corrections: [
        {
          id: "legacy-correction",
          confidence: 0.99,
          supplierAccountId: "supplier-a",
        },
      ],
      supplierSelections: [],
      glAccountSelections: [],
      vatCodeSelections: [],
      costCentreSelections: [],
      costUnitSelections: [],
    },
  } as unknown as IntoStore;
}

test("legacy snapshots migrate idempotently with reduced-trust evidence", () => {
  const migrated = migrateStoreSnapshot(legacySnapshot());
  const migratedAgain = migrateStoreSnapshot(structuredClone(migrated));
  const versioned = migrated as IntoStore & {
    schemaVersion: number;
    legacyLearningRollback: unknown;
  };
  const legacyCorrection = migrated.learning.corrections[0] as unknown as {
    trustState: string;
    confidence: number;
    generation: number;
  };

  assert.equal(versioned.schemaVersion, CURRENT_STORE_SCHEMA_VERSION);
  assert.ok(versioned.legacyLearningRollback);
  assert.equal(legacyCorrection.trustState, "legacy");
  assert.equal(legacyCorrection.generation, 0);
  assert.equal(legacyCorrection.confidence <= 0.6, true);
  assert.equal(migrated.invoices[0]?.status, "Booking Intelligence Review Required");
  assert.equal(
    migrated.invoices[0]?.purchaseJournal?.supplierResolution.reasonCode,
    "supplier_ambiguous"
  );
  assert.equal(migrated.invoices[1]?.processingPurpose, "learning_only");
  assert.equal(migrated.invoices[1]?.learningState, "saved");
  assert.equal(migrated.invoices[1]?.exactBookingStatus, "not_booked");
  assert.deepEqual(migratedAgain, migrated);
});

test("snapshot migration rejects data from a newer release", () => {
  const snapshot = Object.assign(legacySnapshot(), {
    schemaVersion: CURRENT_STORE_SCHEMA_VERSION + 1,
  });
  assert.throws(() => migrateStoreSnapshot(snapshot), /newer than supported/);
});

test("current snapshots preserve trusted correction confidence", () => {
  const snapshot = Object.assign(legacySnapshot(), {
    schemaVersion: CURRENT_STORE_SCHEMA_VERSION,
  });
  const correction = snapshot.learning.corrections[0] as unknown as {
    trustState: string;
    confidence: number;
    generation: number;
    metadata?: Record<string, unknown>;
  };
  correction.trustState = "trusted";
  correction.confidence = 0.99;
  correction.generation = 4;

  const migrated = migrateStoreSnapshot(snapshot);
  const preserved = migrated.learning.corrections[0] as unknown as typeof correction;

  assert.equal(preserved.trustState, "trusted");
  assert.equal(preserved.confidence, 0.99);
  assert.equal(preserved.generation, 4);
  assert.equal(preserved.metadata?.migratedLegacyEvidence, undefined);
});
