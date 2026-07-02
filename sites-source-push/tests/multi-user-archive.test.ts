import test from "node:test";
import assert from "node:assert/strict";
import {
  createUploadedInvoice,
  disconnectExactConnection,
  disconnectOutlookConnection,
  getExactConnection,
  listAuditEvents,
  publicExactConnection,
  publicOutlookConnection,
  requirePermission,
  searchInvoiceArchive,
  switchCurrentUser,
  setExactConnection,
  setOutlookConnection,
} from "../lib/repository/invoice-store";
import { createMockExactConnection } from "../lib/services/exact-online-service";
import { createMockOutlookConnection } from "../lib/services/outlook-service";

test("keeps Exact Online credentials isolated per INTO user", () => {
  switchCurrentUser("user_admin");
  setExactConnection(createMockExactConnection("user_admin"));

  assert.equal(getExactConnection("user_admin")?.userId, "user_admin");
  assert.equal(getExactConnection("user_accountant"), null);

  switchCurrentUser("user_accountant");
});

test("does not expose encrypted OAuth token fields in public connection metadata", () => {
  switchCurrentUser("user_admin");
  setExactConnection(createMockExactConnection("user_admin"));
  setOutlookConnection(createMockOutlookConnection("user_admin"));

  const exact = publicExactConnection();
  const outlook = publicOutlookConnection();

  assert.equal("accessTokenCiphertext" in (exact ?? {}), false);
  assert.equal("refreshTokenCiphertext" in (exact ?? {}), false);
  assert.equal("accessTokenCiphertext" in (outlook ?? {}), false);
  assert.equal("refreshTokenCiphertext" in (outlook ?? {}), false);

  switchCurrentUser("user_accountant");
});

test("disconnect removes stored provider connection for the current user", () => {
  switchCurrentUser("user_admin");
  setExactConnection(createMockExactConnection("user_admin"));
  setOutlookConnection(createMockOutlookConnection("user_admin"));

  disconnectExactConnection();
  disconnectOutlookConnection();

  assert.equal(publicExactConnection(), null);
  assert.equal(publicOutlookConnection(), null);

  switchCurrentUser("user_accountant");
});

test("enforces role permissions for restricted actions", () => {
  switchCurrentUser("user_viewer");

  assert.throws(() => requirePermission("book"), /Viewer users are not allowed/);
  assert.doesNotThrow(() => requirePermission("search_archive"));

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
    source: "manual",
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
