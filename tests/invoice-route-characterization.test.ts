import assert from "node:assert/strict";
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

test("undesirable: a stale ordinary invoice PATCH is accepted without an expectedRevision guard", async () => {
  const invoice = createRouteInvoice("stale-ordinary-patch.pdf");
  const staleRevision = invoice.revision!;
  const current = saveInvoiceReview(invoice.id, invoice.extractedData, [])!;
  const currentRevision = current.revision!;

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
    invoice?: ReturnType<typeof getInvoice>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.invoice?.revision, currentRevision + 1);
  assert.equal(payload.invoice?.extractedData.expenseDescription, "Stale route edit");
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
