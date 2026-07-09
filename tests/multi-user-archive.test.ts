import test from "node:test";
import assert from "node:assert/strict";
import {
  createUploadedInvoice,
  disconnectExactConnection,
  getCompanyConnectionUserId,
  getExactConnection,
  listAuditEvents,
  publicExactConnection,
  requirePermission,
  requireSystemOwner,
  searchInvoiceArchive,
  switchCurrentUser,
  setExactConnection,
} from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";

test("stores Exact credentials as a shared company connection", () => {
  switchCurrentUser("user_admin");
  const connectionOwnerId = getCompanyConnectionUserId();
  setExactConnection(createMockExactConnection(connectionOwnerId));

  assert.equal(getExactConnection()?.userId, connectionOwnerId);
  assert.equal(getExactConnection("user_accountant"), null);

  switchCurrentUser("user_accountant");
});

test("does not expose encrypted OAuth token fields in public connection metadata", () => {
  switchCurrentUser("user_admin");
  const connectionOwnerId = getCompanyConnectionUserId();
  setExactConnection(createMockExactConnection(connectionOwnerId));

  const exact = publicExactConnection();

  assert.equal("accessTokenCiphertext" in (exact ?? {}), false);
  assert.equal("refreshTokenCiphertext" in (exact ?? {}), false);

  switchCurrentUser("user_accountant");
});

test("disconnect removes stored company Exact connection", () => {
  switchCurrentUser("user_admin");
  const connectionOwnerId = getCompanyConnectionUserId();
  setExactConnection(createMockExactConnection(connectionOwnerId));

  disconnectExactConnection();

  assert.equal(publicExactConnection(), null);

  switchCurrentUser("user_accountant");
});

test("verified users share invoice permissions and system owner manages connections", () => {
  switchCurrentUser("user_viewer");

  assert.doesNotThrow(() => requirePermission("book"));
  assert.doesNotThrow(() => requirePermission("upload"));
  assert.doesNotThrow(() => requirePermission("edit"));
  assert.doesNotThrow(() => requirePermission("search_archive"));

  switchCurrentUser("user_accountant");
  assert.doesNotThrow(() => requirePermission("book"));
  assert.throws(() => requireSystemOwner(), /not allowed to manage shared/);

  switchCurrentUser("user_admin");
  assert.doesNotThrow(() => requirePermission("book"));
  assert.doesNotThrow(() => requireSystemOwner());

  switchCurrentUser("user_accountant");
});

test("archive search can retrieve invoices uploaded by another user", () => {
  const result = searchInvoiceArchive({
    uploadedByUserId: "user_admin",
    keyword: "missing-due-date",
    pageSize: 20,
  });

  assert.equal(result.total >= 1, true);
  assert.equal(result.invoices[0]?.uploadedByUserId, "user_admin");
});

test("invoice creation records uploader metadata and audit event", () => {
  switchCurrentUser("user_admin");
  const invoice = createUploadedInvoice({
    source: "manual_upload",
    fileName: "audit-test.pdf",
    fileType: "application/pdf",
    fileSize: 999,
    checksum: "audit-test-checksum",
    storageKey: "tests/audit-test.pdf",
  });

  const auditEvents = listAuditEvents(invoice.id);

  assert.equal(invoice.uploadedByUserId, "user_admin");
  assert.equal(auditEvents[0]?.type, "invoice_uploaded");
  assert.match(auditEvents[0]?.message ?? "", /uploaded audit-test.pdf/);

  switchCurrentUser("user_accountant");
});
