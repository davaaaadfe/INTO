import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PATCH as patchInvoiceRoute } from "../app/api/invoices/[invoiceId]/route";
import {
  createUploadedInvoice,
  getInvoice,
  saveInvoiceReview,
} from "../lib/repository/invoice-store";
import { verifyIntoAccessSession } from "../lib/services/into-access-auth";

function createRouteInvoice(name: string) {
  return createUploadedInvoice({
    fileName: name,
    fileType: "application/pdf",
    fileSize: 1_024,
    storageKey: `storage/tmp-invoices/${name}`,
  });
}

test("PATCH rejects a stale ordinary invoice revision without changing reviewed values", async () => {
  const invoice = createRouteInvoice("stale-ordinary-patch.pdf");
  const staleRevision = invoice.revision!;
  const current = saveInvoiceReview(invoice.id, invoice.extractedData, [])!;
  const auditsBefore = structuredClone(getInvoice(invoice.id));

  const response = await patchInvoiceRoute(
    new Request(`http://localhost/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: staleRevision,
        extractedData: { expenseDescription: "Stale route edit" },
      }),
    }),
    { params: { invoiceId: invoice.id } }
  );
  const payload = (await response.json()) as {
    code?: string;
    currentInvoice?: ReturnType<typeof getInvoice>;
  };

  assert.equal(response.status, 409);
  assert.equal(payload.code, "invoice_revision_conflict");
  assert.equal(payload.currentInvoice?.revision, current.revision);
  assert.deepEqual(getInvoice(invoice.id), auditsBefore);
});

test("PATCH requires a positive integer expectedRevision", async () => {
  for (const expectedRevision of [undefined, 0, -1, 1.5, "1"] as const) {
    const invoice = createRouteInvoice(`invalid-revision-${String(expectedRevision)}.pdf`);
    const before = structuredClone(invoice);
    const response = await patchInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision,
          extractedData: { expenseDescription: "Must not save" },
        }),
      }),
      { params: { invoiceId: invoice.id } }
    );

    assert.equal(response.status, 422, String(expectedRevision));
    assert.deepEqual(getInvoice(invoice.id), before, String(expectedRevision));
  }
});

test("booking recompute cannot consume the command revision before Exact returns", () => {
  const source = readFileSync(
    new URL("../lib/repository/invoice-booking.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /recomputeInvoiceState\(invoice\.id,\s*\{\s*incrementRevision:\s*false\s*\}\)/
  );
});

test("direct invoice handler invocation requires a valid server-side session", async () => {
  const previousPassword = process.env.INTO_ACCESS_PASSWORD;
  process.env.INTO_ACCESS_PASSWORD = "direct-route-characterization-password";
  const invoice = createRouteInvoice("direct-route-auth-bypass.pdf");
  try {
    assert.equal(verifyIntoAccessSession(undefined), false);

    const direct = await patchInvoiceRoute(
      new Request(`http://localhost/api/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extractedData: { expenseDescription: "Direct route edit" } }),
      }),
      { params: { invoiceId: invoice.id } }
    );

    assert.equal(direct.status, 401);
    assert.equal(getInvoice(invoice.id)?.extractedData.expenseDescription, "");
  } finally {
    if (previousPassword === undefined) delete process.env.INTO_ACCESS_PASSWORD;
    else process.env.INTO_ACCESS_PASSWORD = previousPassword;
  }
});
