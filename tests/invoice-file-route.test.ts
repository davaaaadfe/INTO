import test from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import {
  GET as getInvoiceFile,
  HEAD as headInvoiceFile,
} from "../app/api/invoices/[invoiceId]/file/route";
import { POST as uploadInvoices } from "../app/api/invoices/route";
import { createUploadedInvoice } from "../lib/repository/invoice-store";
import {
  deleteStoredInvoiceFile,
  storeInvoiceFile,
} from "../lib/services/storage-service";

const storagePath = `storage/tmp-tests/file-route-${Date.now()}-${Math.random()
  .toString(16)
  .slice(2)}`;

test("serves original PDF, image, and XML invoice bytes for preview and download", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousPath = process.env.TEMP_INVOICE_STORAGE_PATH;
  const previousNodeEnv = process.env.NODE_ENV;
  environment["NODE_ENV"] = "test";
  process.env.TEMP_INVOICE_STORAGE_PATH = storagePath;

  const cases = [
    {
      name: "invoice.pdf",
      type: "application/pdf",
      expectedType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\nINTO test invoice"),
    },
    {
      name: "invoice.jpg",
      type: "image/jpeg",
      expectedType: "image/jpeg",
      bytes: new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]),
    },
    {
      name: "invoice.png",
      type: "image/png",
      expectedType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
    },
    {
      name: "invoice.xml",
      type: "application/xml",
      expectedType: "application/xml",
      bytes: new TextEncoder().encode("<Invoice><ID>INV-001</ID></Invoice>"),
    },
    {
      name: "invoice.ubl",
      type: "",
      expectedType: "application/xml",
      bytes: new TextEncoder().encode("<Invoice><ID>UBL-001</ID></Invoice>"),
    },
  ];

  try {
    for (const fixture of cases) {
      const stored = await storeInvoiceFile(
        new File([fixture.bytes], fixture.name, { type: fixture.type })
      );
      const invoice = createUploadedInvoice({
        source: "manual_upload",
        fileName: fixture.name,
        fileType: stored.fileType,
        fileSize: stored.fileSize,
        checksum: stored.checksum,
        storageKey: stored.storageKey,
      });
      const context = { params: { invoiceId: invoice.id } };
      const previewUrl = `http://localhost/api/invoices/${invoice.id}/file`;

      const headResponse = await headInvoiceFile(
        new Request(previewUrl, { method: "HEAD" }),
        context
      );
      assert.equal(headResponse.status, 200);
      assert.equal(headResponse.headers.get("content-type"), fixture.expectedType);

      const previewResponse = await getInvoiceFile(new Request(previewUrl), context);
      assert.equal(previewResponse.status, 200);
      assert.equal(previewResponse.headers.get("content-type"), fixture.expectedType);
      assert.deepEqual(
        new Uint8Array(await previewResponse.arrayBuffer()),
        fixture.bytes
      );

      const downloadResponse = await getInvoiceFile(
        new Request(`${previewUrl}?download=1`),
        context
      );
      assert.equal(downloadResponse.status, 200);
      assert.match(
        downloadResponse.headers.get("content-disposition") ?? "",
        new RegExp(`^attachment; filename="${fixture.name}"$`)
      );
      assert.deepEqual(
        new Uint8Array(await downloadResponse.arrayBuffer()),
        fixture.bytes
      );

      await deleteStoredInvoiceFile(stored.storageKey);
    }

    const missingResponse = await getInvoiceFile(
      new Request("http://localhost/api/invoices/missing/file"),
      { params: { invoiceId: "missing" } }
    );
    assert.equal(missingResponse.status, 404);
    assert.match(missingResponse.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(
      await missingResponse.text(),
      "Original invoice file could not be found. Please re-upload or re-read this invoice."
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.TEMP_INVOICE_STORAGE_PATH;
    } else {
      process.env.TEMP_INVOICE_STORAGE_PATH = previousPath;
    }
    if (previousNodeEnv === undefined) {
      delete environment["NODE_ENV"];
    } else {
      environment["NODE_ENV"] = previousNodeEnv;
    }
    await rm(storagePath, { recursive: true, force: true });
  }
});

test("a newly uploaded invoice can be previewed and downloaded", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousPath = process.env.TEMP_INVOICE_STORAGE_PATH;
  const previousNodeEnv = process.env.NODE_ENV;
  const uploadStoragePath = `${storagePath}-upload`;
  environment["NODE_ENV"] = "test";
  process.env.TEMP_INVOICE_STORAGE_PATH = uploadStoragePath;
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\nInvoice number: PREVIEW-001\nTotal: EUR 121.00"
  );
  const fileName = `new-upload-${Date.now()}.pdf`;

  try {
    const formData = new FormData();
    formData.append("files", new File([bytes], fileName, { type: "application/pdf" }));
    const uploadResponse = await uploadInvoices(
      new Request("http://localhost/api/invoices", {
        method: "POST",
        body: formData,
      })
    );
    assert.equal(uploadResponse.status, 201);
    const payload = await uploadResponse.json();
    const invoice = payload.processed[0];

    assert.ok(invoice.id);
    assert.equal(invoice.fileName, fileName);
    assert.equal(invoice.fileType, "application/pdf");
    assert.equal(invoice.fileSize, bytes.byteLength);
    assert.match(invoice.checksum, /^[a-f0-9]{64}$/);
    assert.ok(invoice.storageKey);
    assert.equal(invoice.localFileStatus, "available");

    const fileUrl = `http://localhost/api/invoices/${invoice.id}/file`;
    const previewResponse = await getInvoiceFile(new Request(fileUrl), {
      params: { invoiceId: invoice.id },
    });
    assert.equal(previewResponse.status, 200);
    assert.deepEqual(new Uint8Array(await previewResponse.arrayBuffer()), bytes);

    const downloadResponse = await getInvoiceFile(
      new Request(`${fileUrl}?download=1`),
      { params: { invoiceId: invoice.id } }
    );
    assert.equal(downloadResponse.status, 200);
    assert.match(
      downloadResponse.headers.get("content-disposition") ?? "",
      new RegExp(`^attachment; filename="${fileName}"$`)
    );

    await deleteStoredInvoiceFile(invoice.storageKey);
  } finally {
    if (previousPath === undefined) {
      delete process.env.TEMP_INVOICE_STORAGE_PATH;
    } else {
      process.env.TEMP_INVOICE_STORAGE_PATH = previousPath;
    }
    if (previousNodeEnv === undefined) {
      delete environment["NODE_ENV"];
    } else {
      environment["NODE_ENV"] = previousNodeEnv;
    }
    await rm(uploadStoragePath, { recursive: true, force: true });
  }
});

test("an unsupported upload is rejected before any local file is written", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousPath = process.env.TEMP_INVOICE_STORAGE_PATH;
  const previousNodeEnv = process.env.NODE_ENV;
  const uploadStoragePath = `${storagePath}-unsupported`;
  environment["NODE_ENV"] = "test";
  process.env.TEMP_INVOICE_STORAGE_PATH = uploadStoragePath;

  try {
    const formData = new FormData();
    formData.append("files", new File(["not an invoice"], "notes.txt"));
    const response = await uploadInvoices(
      new Request("http://localhost/api/invoices", { method: "POST", body: formData })
    );
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(payload.processed.length, 0);
    assert.equal(payload.rejected[0]?.fileName, "notes.txt");
    await assert.rejects(readdir(uploadStoragePath), /ENOENT/);
  } finally {
    if (previousPath === undefined) delete process.env.TEMP_INVOICE_STORAGE_PATH;
    else process.env.TEMP_INVOICE_STORAGE_PATH = previousPath;
    if (previousNodeEnv === undefined) delete environment["NODE_ENV"];
    else environment["NODE_ENV"] = previousNodeEnv;
    await rm(uploadStoragePath, { recursive: true, force: true });
  }
});
