import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDocument,
  azureDocumentIntelligenceProvider,
  type DocumentAnalysis,
  type DocumentAnalysisProvider,
} from "../lib/services/document-analysis";
import { extractDocumentText } from "../lib/services/invoice-document-text";
import type { DocumentAnalysis as CanonicalDocumentAnalysis } from "../lib/domain/document-analysis";
import type { DocumentAnalysisArtifact } from "../lib/domain/invoice";

function assertReadonlyAnalysisContract(analysis: DocumentAnalysis) {
  const canonical: CanonicalDocumentAnalysis = analysis;
  const artifact: DocumentAnalysisArtifact = {
    pages: canonical.pages,
    fieldCandidates: canonical.fieldCandidates,
    confidence: canonical.confidence,
    language: canonical.language,
    provider: canonical.provider,
    sourceMode: canonical.sourceMode,
  };
  void artifact;
  if (false) {
    // @ts-expect-error Document analysis pages are immutable after creation.
    analysis.pages.push(analysis.pages[0]);
    // @ts-expect-error Token geometry is immutable after creation.
    analysis.pages[0].tokens[0].polygon[0].x = 0;
    // @ts-expect-error Field candidates are immutable after creation.
    analysis.fieldCandidates[0].confidence = 0;
  }
}

function pdfBytesWithText(lines: string[]) {
  const content = [
    "BT",
    "/F1 12 Tf",
    "14 TL",
    "72 740 Td",
    ...lines.flatMap((line, index) => [
      index ? "T*" : "",
      `(${line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")}) Tj`,
    ]).filter(Boolean),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, "ascii");
}

test("local document analysis preserves pages and normalized token geometry", async () => {
  const analysis = await analyzeDocument({
    name: "layout.xml",
    type: "application/xml",
    text: async () => "Supplier: Example BV\nInvoice number: EX-100\fTotal: 121.00",
  });

  assert.equal(analysis.sourceMode, "xml_text");
  assert.equal(analysis.rawText, "Supplier: Example BV\nInvoice number: EX-100\fTotal: 121.00");
  assert.equal(analysis.pages.length, 2);
  assert.equal(analysis.pages[0].width, 1);
  assert.equal(analysis.pages[0].height, 1);
  assertReadonlyAnalysisContract(analysis);
  assert.equal(analysis.pages[0].tokens.map((token) => token.text).join(" "), "Supplier: Example BV Invoice number: EX-100");
  for (const token of analysis.pages.flatMap((page) => page.tokens)) {
    assert.equal(token.polygon.length, 4);
    assert.ok(
      token.polygon.every(
        (point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
      )
    );
    assert.equal(token.confidence, 1);
  }
});

test("document text keeps managed field candidates and token geometry", async () => {
  const polygon = [
    { x: 0.1, y: 0.2 },
    { x: 0.4, y: 0.2 },
    { x: 0.4, y: 0.3 },
    { x: 0.1, y: 0.3 },
  ];
  const provider: DocumentAnalysisProvider = async () => ({
    pages: [{
      pageNumber: 1,
      width: 1,
      height: 1,
      unit: "normalized",
      text: "Structured Supplier BV",
      tokens: [{ text: "Structured", polygon, confidence: 0.99 }],
      tables: [],
    }],
    fieldCandidates: [{
      field: "supplierName",
      label: "VendorName",
      value: "Structured Supplier BV",
      page: 1,
      polygon,
      confidence: 0.98,
      source: "test-provider",
    }],
    rawText: "Structured Supplier BV",
    confidence: 0.99,
    provider: { name: "test-provider" },
    providerOutcome: { status: "succeeded", adapter: "test-provider" },
    sourceMode: "ocr",
  });

  const document = await extractDocumentText(
    {
      name: "scan.png",
      type: "image/png",
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    },
    {
      env: {
        AZURE_DOCUMENT_INTELLIGENCE_ENABLED: "yes",
        AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.invalid",
        AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "secret",
      },
      provider,
    }
  );

  assert.deepEqual(document.fieldCandidates[0], {
    field: "supplierName",
    label: "VendorName",
    value: "Structured Supplier BV",
    page: 1,
    polygon,
    confidence: 0.98,
    source: "test-provider",
  });
  assert.deepEqual(document.pages[0].tokens[0].polygon, polygon);
  assert.equal(document.mode, "ocr");
});

test("document intelligence stays offline unless enabled and fully configured", async () => {
  let calls = 0;
  const provider: DocumentAnalysisProvider = async () => {
    calls += 1;
    throw new Error("must not be called");
  };

  const analysis = await analyzeDocument(
    {
      name: "offline.xml",
      type: "application/xml",
      text: async () => "Invoice number: OFFLINE-1",
    },
    {
      env: {
        AZURE_DOCUMENT_INTELLIGENCE_ENABLED: "false",
        AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.invalid",
        AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "secret",
      },
      provider,
    }
  );

  assert.equal(calls, 0);
  assert.equal(analysis.provider.name, "local");
  assert.equal(analysis.rawText, "Invoice number: OFFLINE-1");
  assert.deepEqual(analysis.providerOutcome, {
    status: "succeeded",
    adapter: "local",
  });
});

test("scanned input reports OCR unavailable without calling an external provider", async () => {
  let calls = 0;
  const analysis = await analyzeDocument(
    {
      name: "offline-scan.png",
      type: "image/png",
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    },
    {
      env: { DOCUMENT_INTELLIGENCE_ENABLED: "false" },
      provider: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    }
  );

  assert.equal(calls, 0);
  assert.equal(analysis.sourceMode, "unavailable");
  assert.deepEqual(analysis.providerOutcome, {
    status: "unavailable",
    adapter: "local",
    reason: "ocr_unavailable",
  });
});

test("a configured provider failure returns deterministic local analysis", async () => {
  let calls = 0;
  const provider: DocumentAnalysisProvider = async () => {
    calls += 1;
    throw new Error("provider unavailable");
  };
  const input = {
    name: "fallback.png",
    type: "image/png",
    arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
  };

  const local = await analyzeDocument(input);
  const fallback = await analyzeDocument(input, {
    env: {
      AZURE_DOCUMENT_INTELLIGENCE_ENABLED: "true",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.invalid",
      AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "secret",
    },
    provider,
  });

  assert.equal(calls, 1);
  assert.deepEqual(
    { ...fallback, providerOutcome: undefined },
    { ...local, providerOutcome: undefined }
  );
  assert.deepEqual(fallback.providerOutcome, {
    status: "failed",
    adapter: "managed-document-analysis",
    reason: "provider_error",
  });
});

test("managed OCR timeout is classified without exposing provider error text", async () => {
  const analysis = await analyzeDocument(
    {
      name: "timeout-scan.png",
      type: "image/png",
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    },
    {
      env: {
        DOCUMENT_INTELLIGENCE_ENABLED: "true",
        DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.invalid",
        DOCUMENT_INTELLIGENCE_KEY: "secret",
      },
      provider: async () => {
        throw new Error("Document intelligence analysis timed out: sensitive detail");
      },
    }
  );

  assert.deepEqual(analysis.providerOutcome, {
    status: "failed",
    adapter: "managed-document-analysis",
    reason: "timeout",
  });
  assert.doesNotMatch(JSON.stringify(analysis.providerOutcome), /sensitive/i);
});

test("text-rich embedded PDFs stay local when managed OCR is enabled", async () => {
  const bytes = pdfBytesWithText([
    "Supplier Example Office Supplies BV VAT NL812345678B01",
    "Invoice number EXAMPLE-2026-100 dated 2026-07-21",
    "Subtotal EUR 100.00 VAT EUR 21.00 Invoice total EUR 121.00",
  ]);
  let calls = 0;
  const analysis = await analyzeDocument(
    {
      name: "embedded.pdf",
      type: "application/pdf",
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer,
    },
    {
      env: {
        AZURE_DOCUMENT_INTELLIGENCE_ENABLED: "true",
        AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.invalid",
        AZURE_DOCUMENT_INTELLIGENCE_API_KEY: "secret",
      },
      provider: async () => {
        calls += 1;
        throw new Error("must stay local");
      },
    }
  );

  assert.equal(calls, 0);
  assert.equal(analysis.sourceMode, "embedded_pdf_text");
  assert.match(analysis.rawText, /EXAMPLE-2026-100/);
});

test("Azure v4 uses base64 JSON, bounded polling, and normalized invoice fields", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let clock = 0;
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return new Response(null, {
        status: 202,
        headers: {
          "operation-location": "https://example.invalid/operations/result-1",
          "retry-after": "1",
        },
      });
    }
    return Response.json({
      status: "succeeded",
      analyzeResult: {
        modelId: "prebuilt-invoice",
        apiVersion: "2024-11-30",
        content: "Example Office Supplies BV\nInvoice total 121.00",
        pages: [{
          pageNumber: 1,
          width: 100,
          height: 200,
          unit: "pixel",
          lines: [{ content: "Example Office Supplies BV" }],
          words: [{
            content: "Example",
            polygon: [0, 0, 20, 0, 20, 10, 0, 10],
            confidence: 0.99,
          }],
        }],
        tables: [],
        documents: [{
          fields: {
            VendorName: {
              content: "Example Office Supplies BV",
              confidence: 0.98,
              boundingRegions: [{
                pageNumber: 1,
                polygon: [0, 0, 50, 0, 50, 20, 0, 20],
              }],
            },
            InvoiceTotal: {
              valueCurrency: { amount: 121, currencyCode: "EUR" },
              confidence: 0.97,
              boundingRegions: [{
                pageNumber: 1,
                polygon: [50, 100, 90, 100, 90, 120, 50, 120],
              }],
            },
          },
        }],
      },
    });
  }) as typeof fetch;

  const analysis = await azureDocumentIntelligenceProvider(
    {
      name: "scan.png",
      type: "image/png",
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    },
    {
      endpoint: "https://example.invalid",
      key: "secret",
      modelId: "prebuilt-invoice",
      fetch: fetchMock,
      pollTimeoutMs: 5_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    }
  );

  assert.match(calls[0].url, /documentModels\/prebuilt-invoice:analyze/);
  assert.match(calls[0].url, /api-version=2024-11-30/);
  assert.equal(calls[0].init?.headers && (calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { base64Source: "AQID" });
  assert.equal(clock, 1_000);
  assert.equal(calls[1].url, "https://example.invalid/operations/result-1");
  assert.equal(analysis.provider.model, "prebuilt-invoice");
  assert.deepEqual(analysis.providerOutcome, {
    status: "succeeded",
    adapter: "azure-document-intelligence",
  });
  assert.deepEqual(
    analysis.fieldCandidates.map(({ field, value, page, confidence, source }) => ({
      field,
      value,
      page,
      confidence,
      source,
    })),
    [
      {
        field: "supplierName",
        value: "Example Office Supplies BV",
        page: 1,
        confidence: 0.98,
        source: "azure-document-intelligence",
      },
      {
        field: "grossAmount",
        value: 121,
        page: 1,
        confidence: 0.97,
        source: "azure-document-intelligence",
      },
    ]
  );
  assert.deepEqual(analysis.fieldCandidates[0].polygon[2], { x: 0.5, y: 0.1 });
});
