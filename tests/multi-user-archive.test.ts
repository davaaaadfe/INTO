import test from "node:test";
import assert from "node:assert/strict";
import { SHARED_ACCESS_PERMISSIONS } from "../lib/domain/invoice";
import {
  createUploadedInvoice,
  disconnectExactConnection,
  getCompanyConnectionUserId,
  getCurrentUser,
  getExactConnection,
  listUsers,
  listAuditEvents,
  permissionsForUser,
  publicExactConnection,
  requirePermission,
  requireSystemOwner,
  searchInvoiceArchive,
  setExactConnection,
} from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";

test("uses one shared internal user with access to all INTO functions", () => {
  const user = getCurrentUser();

  assert.equal(user.id, "shared_user");
  assert.deepEqual(listUsers().map((item) => item.id), ["shared_user"]);
  assert.deepEqual(permissionsForUser(user), [...SHARED_ACCESS_PERMISSIONS]);
});

test("stores Exact credentials as a shared company connection", () => {
  const connectionOwnerId = getCompanyConnectionUserId();
  setExactConnection(createMockExactConnection(connectionOwnerId));

  assert.equal(getExactConnection()?.userId, connectionOwnerId);
  assert.equal(getExactConnection("another_user"), null);
});

test("does not expose encrypted OAuth token fields in public connection metadata", () => {
  const connectionOwnerId = getCompanyConnectionUserId();
  setExactConnection(createMockExactConnection(connectionOwnerId));

  const exact = publicExactConnection();

  assert.equal("accessTokenCiphertext" in (exact ?? {}), false);
  assert.equal("refreshTokenCiphertext" in (exact ?? {}), false);
});

test("disconnect removes stored company Exact connection", () => {
  const connectionOwnerId = getCompanyConnectionUserId();
  setExactConnection(createMockExactConnection(connectionOwnerId));

  disconnectExactConnection();

  assert.equal(publicExactConnection(), null);
});

test("shared access includes invoice and connection management permissions", () => {
  assert.doesNotThrow(() => requirePermission("book"));
  assert.doesNotThrow(() => requirePermission("upload"));
  assert.doesNotThrow(() => requirePermission("edit"));
  assert.doesNotThrow(() => requirePermission("search_archive"));
  assert.doesNotThrow(() => requireSystemOwner());
});

test("archive search can retrieve invoices uploaded by the shared user", () => {
  const result = searchInvoiceArchive({
    uploadedByUserId: "shared_user",
    keyword: "missing-due-date",
    pageSize: 20,
  });

  assert.equal(result.total >= 1, true);
  assert.equal(result.invoices[0]?.uploadedByUserId, "shared_user");
});

test("invoice creation records uploader metadata and audit event", () => {
  const invoice = createUploadedInvoice({
    source: "manual_upload",
    fileName: "audit-test.pdf",
    fileType: "application/pdf",
    fileSize: 999,
    checksum: "audit-test-checksum",
    storageKey: "tests/audit-test.pdf",
  });

  const auditEvents = listAuditEvents(invoice.id);

  assert.equal(invoice.uploadedByUserId, "shared_user");
  assert.equal(auditEvents[0]?.type, "invoice_uploaded");
  assert.match(auditEvents[0]?.message ?? "", /uploaded audit-test.pdf/);
});
