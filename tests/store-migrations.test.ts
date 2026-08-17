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

test("schema v3 backfills durable invoice lifecycle fields and normalizes transient learning state", () => {
  const snapshot = legacySnapshot();
  snapshot.schemaVersion = 2;
  const ordinary = snapshot.invoices[0] as Record<string, unknown>;
  ordinary.learningState = "saving";
  ordinary.processingPurpose = "invalid";
  ordinary.revision = 0;
  ordinary.intelligenceApprovedAt = "2026-08-10T12:00:00.000Z";
  const learned = snapshot.invoices[1] as Record<string, unknown>;
  learned.learningState = "failed";
  learned.processingPurpose = "booking";
  learned.revision = -3;
  learned.intelligenceApprovedAt = "2026-08-10T12:00:00.000Z";

  const migrated = migrateStoreSnapshot(snapshot);
  const [migratedOrdinary, migratedLearned] = migrated.invoices;

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migratedOrdinary?.processingPurpose, "booking");
  assert.equal(migratedOrdinary?.learningState, "not_saved");
  assert.equal(migratedOrdinary?.revision, 1);
  assert.equal(migratedLearned?.processingPurpose, "learning_only");
  assert.equal(migratedLearned?.learningState, "saved");
  assert.equal(migratedLearned?.revision, 1);
  assert.equal(migratedLearned?.exactBookingStatus, "not_booked");
  assert.equal(migratedLearned?.intelligenceApprovedAt, undefined);
  assert.deepEqual(migrateStoreSnapshot(structuredClone(migrated)), migrated);
});

test("schema v3 ignores malformed legacy migration issues while quarantining Learned metadata", () => {
  const snapshot = legacySnapshot();
  snapshot.schemaVersion = 2;
  const learned = snapshot.invoices[1] as Record<string, unknown>;
  learned.migrationIssues = [null, "legacy-noise", { code: "existing_issue" }];

  const migrated = migrateStoreSnapshot(snapshot);
  const issues = migrated.invoices[1]?.migrationIssues ?? [];

  assert.deepEqual(issues, [
    {
      code: "learning_metadata_unrecoverable",
      message:
        "Legacy Learned invoice needs manual review because its learning evidence cannot be reconstructed safely.",
    },
  ]);
});

test("schema v3 does not downgrade learning evidence already migrated by schema v2", () => {
  const snapshot = legacySnapshot();
  snapshot.schemaVersion = 2;
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

test("schema v3 reserves learning_only and saved lifecycle state for Learned invoices", () => {
  const snapshot = legacySnapshot();
  snapshot.schemaVersion = 2;
  const ordinary = snapshot.invoices[0] as Record<string, unknown>;
  ordinary.processingPurpose = "learning_only";
  ordinary.learningState = "saved";

  const migrated = migrateStoreSnapshot(snapshot);

  assert.equal(migrated.invoices[0]?.processingPurpose, "booking");
  assert.equal(migrated.invoices[0]?.learningState, "not_saved");
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
