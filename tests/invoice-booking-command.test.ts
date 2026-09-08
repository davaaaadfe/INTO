import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createUploadedInvoice, getInvoice, getStore, hydrateStoreFromPersistence,
  learnInvoice, recomputeInvoiceState, saveInvoiceReview,
  approveInvoiceIntelligence, markInvoiceReading, markInvoiceNeedsReview, markInvoiceBooked,
  replaceInvoiceExtractionFromReread, updateInvoiceExtraction, applyValidation, resolveDuplicateDecision,
  selectInvoiceSupplier, cleanupTemporaryInvoiceFiles,
} from "../lib/repository/invoice-store";
import { executeInvoiceBooking } from "../lib/repository/invoice-booking";
import { withPersistentStoreForTest, withRequestPrincipalContext } from "../lib/repository/persistent-request";
import { closeSqliteStore, loadSqliteStoreSnapshot, saveSqliteStoreSnapshot } from "../lib/repository/sqlite-store";
import { DatabaseSync } from "node:sqlite";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";

async function withBookingDatabase(run: (path: string) => Promise<void>) {
  const path = resolve("data/tmp-tests", `booking-${randomUUID()}.sqlite`);
  const keys = ["DATABASE_MODE", "LOCAL_DATABASE_PATH", "LEARNING_V2_ENABLED"];
  const previous = keys.map((key) => process.env[key]);
  process.env.DATABASE_MODE = "sqlite";
  process.env.LOCAL_DATABASE_PATH = path;
  process.env.LEARNING_V2_ENABLED = "false";
  try {
    await hydrateStoreFromPersistence(true);
    getStore().invoices = [];
    await run(path);
  } finally {
    closeSqliteStore();
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  }
}

function readyInvoice() {
  const store = getStore();
  store.exactConnections = [createMockExactConnection("company_connection")];
  store.exactMasterDataCaches = [{ userId: "company_connection", cache: createMockExactMasterData() }];
  const invoice = createUploadedInvoice({
    fileName: "booking-test.pdf", fileType: "application/pdf", fileSize: 10,
    storageKey: "missing-test-file", checksum: randomUUID(),
  });
  recomputeInvoiceState(invoice.id);
  invoice.status = "Ready to Book";
  return invoice;
}

test("booking commits its reservation before a provider write and replays successful requests", async () => {
  await withBookingDatabase(async (path) => {
    let writes = 0;
    const invoice = readyInvoice();
    const input = { invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "test-request" };
    const principal = { actorId: "verified-booker", actorName: "Test booker", accessLevel: "verified_user", verificationState: "verified", sessionCorrelationId: "opaque-session", requestId: "booking-request" } as const;
    const result = await withRequestPrincipalContext(principal, () => withPersistentStoreForTest(() => executeInvoiceBooking(input, async (_connection, selected, _masterData, hooks) => {
      await hooks!.beforeWrite();
      const durable = (await loadSqliteStoreSnapshot(path))!.invoices.find((item) => item.id === invoice.id)!;
      assert.equal(durable.bookingOperation?.state, "reserved");
      assert.equal(durable.bookingOperation?.inputRevision, input.expectedRevision);
      assert.equal(durable.bookingOperation?.actorId, principal.actorId);
      assert.equal(durable.bookingOperation?.sessionCorrelationId, principal.sessionCorrelationId);
      assert.equal(durable.bookingOperation?.requestId, principal.requestId);
      const before = structuredClone(getInvoice(invoice.id));
      assert.throws(() => saveInvoiceReview(invoice.id, selected.extractedData, []), /booking.*progress|reconciliation/i);
      assert.throws(() => learnInvoice(invoice.id, selected.extractedData, [], getInvoice(invoice.id)!.revision), /booking.*progress|reconciliation/i);
      for (const mutate of [
        () => approveInvoiceIntelligence(invoice.id),
        () => markInvoiceReading(invoice.id),
        () => markInvoiceNeedsReview(invoice.id),
        () => markInvoiceBooked(invoice.id, "must-not-finalize"),
        () => replaceInvoiceExtractionFromReread(invoice.id, selected.extractedData),
        () => updateInvoiceExtraction(invoice.id, selected.extractedData),
        () => applyValidation(invoice.id, []),
        () => selectInvoiceSupplier(invoice.id, getStore().exactMasterDataCaches[0]!.cache.suppliers[0]!.id),
      ]) assert.throws(mutate, /booking.*progress|reconciliation/i);
      await assert.rejects(resolveDuplicateDecision({ invoiceId: invoice.id, source: "manual_upload", fileName: "test.pdf", detectionOutcome: "possible_duplicate", decision: "cancel_upload", message: "cancel" }), /booking.*progress|reconciliation/i);
      recomputeInvoiceState(invoice.id);
      assert.deepEqual(getInvoice(invoice.id), before);
      assert.equal((await cleanupTemporaryInvoiceFiles(new Date("2099-01-01"))).deleted, 0);
      writes += 1;
      await hooks!.recordProgress({ exactDocumentId: "test-document" });
      return { exactBookingId: "test-entry", divisionCode: "123456", journal: "60", financialYear: 2026, period: 9, attachedFileKey: selected.storageKey, bookedAt: new Date().toISOString() };
    })));
    assert.ok(!(result instanceof Response));
    assert.equal(result.invoice.status, "Booked");
    const replay = await withPersistentStoreForTest(() => executeInvoiceBooking(input, async () => { throw new Error("must not call again"); }));
    assert.ok(!(replay instanceof Response));
    assert.equal(replay.replayed, true);
    assert.equal(writes, 1);
    const durable = (await loadSqliteStoreSnapshot(path))!.invoices.find((item) => item.id === invoice.id)!;
    assert.equal(durable.status, "Booked");
    assert.equal(durable.bookingOperation?.state, "completed");
    assert.equal(durable.bookingOperation?.exactDocumentId, "test-document");
    assert.doesNotMatch(JSON.stringify(durable.bookingOperation), /test-request/);
    const audits = (await loadSqliteStoreSnapshot(path))!.auditEvents.filter((event) => event.invoiceId === invoice.id && event.type === "invoice_booking_reserved");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.userId, principal.actorId);
  });
});

test("a competing snapshot commit prevents the losing booking from reaching Exact", async () => {
  await withBookingDatabase(async (path) => {
    const invoice = readyInvoice();
    let writes = 0;
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "losing-booking" }, async (_c, _i, _m, hooks) => {
        // Another process wins the CAS before this request can reserve.
        const other = (await loadSqliteStoreSnapshot(path))!;
        const winner = other.invoices.find((item) => item.id === invoice.id)!;
        winner.extractedData.expenseDescription = "concurrent edit";
        winner.revision += 1;
        await saveSqliteStoreSnapshot(other, path);
        await hooks!.beforeWrite();
        writes += 1;
        throw new Error("must not reach Exact");
      }), /state changed/i);
    });
    assert.equal(writes, 0);
    const durable = (await loadSqliteStoreSnapshot(path))!.invoices.find((item) => item.id === invoice.id)!;
    assert.equal(durable.extractedData.expenseDescription, "concurrent edit");
    assert.equal(durable.bookingOperation, undefined);
  });
});

test("a second connection changing state during Exact work retains the reservation and file", async () => {
  await withBookingDatabase(async (path) => {
    const invoice = readyInvoice();
    let writes = 0;
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "final-cas-loses" }, async (_c, selected, _m, hooks) => {
        await hooks!.beforeWrite();
        writes += 1;
        const concurrent = new DatabaseSync(path);
        try {
          const row = concurrent.prepare("SELECT payload, revision FROM into_runtime_store WHERE id='company'").get() as { payload: string; revision: number };
          const snapshot = JSON.parse(row.payload);
          snapshot.revision = row.revision + 1;
          concurrent.prepare("UPDATE into_runtime_store SET payload=?, revision=? WHERE id='company' AND revision=?")
            .run(JSON.stringify(snapshot), snapshot.revision, row.revision);
        } finally { concurrent.close(); }
        return { exactBookingId: "remote-success", divisionCode: "123456", journal: "60", financialYear: 2026, period: 9, attachedFileKey: selected.storageKey, bookedAt: new Date().toISOString() };
      }), /reconciliation/i);
    });
    assert.equal(writes, 1);
    const durable = (await loadSqliteStoreSnapshot(path))!.invoices.find((item) => item.id === invoice.id)!;
    assert.equal(durable.bookingOperation?.state, "reserved");
    assert.notEqual(durable.status, "Booked");
    assert.equal(durable.localFileStatus, "available");
    await hydrateStoreFromPersistence(true);
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: getInvoice(invoice.id)!.revision, requestKey: "retry-other-key" }), /reconciliation/i);
    });
    assert.equal(writes, 1);
  });
});

test("a provider timeout keeps a durable reconciliation lock across restart and different retry keys", async () => {
  await withBookingDatabase(async (path) => {
    const invoice = readyInvoice();
    const input = { invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "uncertain-request" };
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking(input, async (_connection, _selected, _masterData, hooks) => {
        await hooks!.beforeWrite();
        await hooks!.recordProgress({ exactDocumentId: "partial-document" });
        throw new Error("provider timeout with sensitive content");
      }), /reconciliation/i);
    });
    await hydrateStoreFromPersistence(true);
    const restored = getInvoice(invoice.id)!;
    assert.equal(restored.bookingOperation?.state, "uncertain");
    assert.equal(restored.bookingOperation?.exactDocumentId, "partial-document");
    assert.doesNotMatch(JSON.stringify(await loadSqliteStoreSnapshot(path)), /sensitive content/);
    await withPersistentStoreForTest(async () => {
      for (const requestKey of [input.requestKey, "different-key"]) {
        await assert.rejects(executeInvoiceBooking({ ...input, requestKey, expectedRevision: restored.revision }), /reconciliation|request.*conflict/i);
      }
    });
  });
});

test("an exception after a durable reservation cannot restore a pre-reservation checkpoint", async () => {
  await withBookingDatabase(async () => {
    const invoice = readyInvoice();
    const response = await withPersistentStoreForTest(() => executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "checkpoint-request" }, async (_c, _i, _m, hooks) => {
      await hooks!.beforeWrite();
      throw new Error("timeout");
    }));
    assert.ok(response instanceof Response);
    assert.equal(getInvoice(invoice.id)?.bookingOperation?.state, "uncertain");
  });
});

test("memory-only configuration refuses provider writes and restores the unreserved invoice", async () => {
  const previous = process.env.DATABASE_MODE;
  process.env.DATABASE_MODE = "memory";
  try {
    const invoice = readyInvoice();
    const before = structuredClone(invoice);
    let writes = 0;
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "no-durable-storage" }, async (_c, _i, _m, hooks) => {
        await hooks!.beforeWrite();
        writes += 1;
        throw new Error("must not write");
      }), /durable storage is unavailable/i);
    });
    assert.equal(writes, 0);
    assert.deepEqual(getInvoice(invoice.id), before);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previous;
  }
});

test("local finalization failure discards partial success records but preserves remote progress", async () => {
  await withBookingDatabase(async () => {
    const invoice = readyInvoice();
    await withPersistentStoreForTest(async () => {
      await assert.rejects(executeInvoiceBooking({ invoiceId: invoice.id, expectedRevision: invoice.revision, requestKey: "finalize-failure" }, async (_c, selected, _m, hooks) => {
        await hooks!.beforeWrite();
        await hooks!.recordProgress({ exactBookingId: "remote-entry" });
        let reads = 0;
        return {
          get exactBookingId() {
            if (++reads === 3) throw new Error("local finalization failure");
            return "remote-entry";
          },
          divisionCode: "123456", journal: "60", financialYear: 2026, period: 9,
          attachedFileKey: selected.storageKey, bookedAt: new Date().toISOString(),
        };
      }), /reconciliation/i);
    });
    await hydrateStoreFromPersistence(true);
    const restored = getInvoice(invoice.id)!;
    assert.equal(restored.bookingOperation?.state, "uncertain");
    assert.equal(restored.bookingOperation?.exactBookingId, "remote-entry");
    assert.notEqual(restored.status, "Booked");
    assert.equal(restored.bookingAttempts.length, 1);
    assert.equal(restored.bookingAttempts[0]?.status, "failed");
  });
});
