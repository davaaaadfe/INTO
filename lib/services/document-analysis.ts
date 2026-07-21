export type DocumentAnalysisInput = {
  readonly name: string;
  readonly type: string;
  readonly text?: () => Promise<string>;
  readonly arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type NormalizedPoint = {
  readonly x: number;
  readonly y: number;
};

export type DocumentToken = {
  readonly text: string;
  readonly polygon: readonly NormalizedPoint[];
  readonly confidence: number;
};

export type DocumentTableCell = {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly text: string;
  readonly polygon: readonly NormalizedPoint[];
  readonly confidence: number;
};

export type DocumentTable = {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cells: readonly DocumentTableCell[];
};

export type FieldCandidate = {
  readonly value: string | number | boolean | null;
  readonly field: string;
  readonly label?: string;
  readonly page?: number;
  readonly polygon: readonly NormalizedPoint[];
  readonly confidence: number;
  readonly source: string;
};

export type DocumentAnalysisPage = {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly unit: "pixel" | "inch" | "normalized";
  readonly text: string;
  readonly tokens: readonly DocumentToken[];
  readonly language?: string;
  readonly tables: readonly DocumentTable[];
};

export type DocumentAnalysisSourceMode =
  | "embedded_pdf_text"
  | "xml_text"
  | "plain_text"
  | "ocr"
  | "unavailable";

export type DocumentAnalysis = {
  readonly pages: readonly DocumentAnalysisPage[];
  readonly fieldCandidates: readonly FieldCandidate[];
  readonly rawText: string;
  readonly confidence: number;
  readonly language?: string;
  readonly provider: {
    readonly name: string;
    readonly model?: string;
    readonly modelVersion?: string;
  };
  readonly sourceMode: DocumentAnalysisSourceMode;
};

export type DocumentAnalysisProviderConfig = {
  readonly endpoint: string;
  readonly key: string;
  readonly modelId: string;
  readonly fetch: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export type DocumentAnalysisProvider = (
  input: DocumentAnalysisInput,
  config: DocumentAnalysisProviderConfig
) => Promise<DocumentAnalysis>;

export type DocumentAnalysisOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  readonly provider?: DocumentAnalysisProvider;
};

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function rectangle(left: number, top: number, right: number, bottom: number) {
  return [
    { x: clamp(left), y: clamp(top) },
    { x: clamp(right), y: clamp(top) },
    { x: clamp(right), y: clamp(bottom) },
    { x: clamp(left), y: clamp(bottom) },
  ];
}

function unavailable(): DocumentAnalysis {
  return {
    pages: [],
    fieldCandidates: [],
    rawText: "",
    confidence: 0,
    provider: { name: "local", model: "deterministic-layout" },
    sourceMode: "unavailable",
  };
}

async function suppliedText(input: DocumentAnalysisInput) {
  if (!input.text) return "";
  try {
    return await input.text();
  } catch {
    return "";
  }
}

function syntheticPage(text: string, pageNumber: number): DocumentAnalysisPage {
  const lines = text.replace(/\r/g, "").split("\n");
  const lineHeight = 1 / Math.max(lines.length, 1);
  const tokens = lines.flatMap((line, lineIndex) => {
    const words = [...line.matchAll(/\S+/g)];
    const width = Math.max(line.length, 1);
    return words.map((word) => {
      const start = word.index ?? 0;
      return {
        text: word[0],
        polygon: rectangle(
          start / width,
          lineIndex * lineHeight,
          (start + word[0].length) / width,
          (lineIndex + 1) * lineHeight
        ),
        confidence: 1,
      };
    });
  });
  return {
    pageNumber,
    width: 1,
    height: 1,
    unit: "normalized",
    text: text.trim(),
    tokens,
    tables: [],
  };
}

function analysisFromText(
  text: string,
  sourceMode: "xml_text" | "plain_text"
): DocumentAnalysis {
  const pages = text
    .replace(/\r/g, "")
    .split(/\f/)
    .map((page, index) => syntheticPage(page, index + 1))
    .filter((page) => page.text);
  return pages.length
      ? {
        pages,
        fieldCandidates: [],
        rawText: pages.map((page) => page.text).join("\f"),
        confidence: 1,
        provider: { name: "local", model: "deterministic-layout" },
        sourceMode,
      }
    : unavailable();
}

function pdfTokens(
  text: string,
  x: number,
  y: number,
  itemWidth: number,
  itemHeight: number,
  pageWidth: number,
  pageHeight: number
) {
  const matches = [...text.matchAll(/\S+/g)];
  const length = Math.max(text.length, 1);
  return matches.map((match) => {
    const startRatio = (match.index ?? 0) / length;
    const endRatio = ((match.index ?? 0) + match[0].length) / length;
    const left = (x + itemWidth * startRatio) / pageWidth;
    const right = (x + itemWidth * endRatio) / pageWidth;
    const top = 1 - (y + Math.max(itemHeight, 1)) / pageHeight;
    const bottom = 1 - y / pageHeight;
    return {
      text: match[0],
      polygon: rectangle(left, top, right, bottom),
      confidence: 1,
    };
  });
}

async function localPdfAnalysis(input: DocumentAnalysisInput) {
  if (!input.arrayBuffer) {
    return analysisFromText(await suppliedText(input), "plain_text");
  }
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await input.arrayBuffer());
    const document = await pdfjs.getDocument({ data, disableFontFace: true }).promise;
    const pages: DocumentAnalysisPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const rows = new Map<number, Array<{ x: number; text: string }>>();
      const tokens: DocumentToken[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        const height = Math.abs(item.height || item.transform[3] || 1);
        const rowKey = Math.round(y);
        const row = rows.get(rowKey) ?? [];
        row.push({ x, text: item.str.trim() });
        rows.set(rowKey, row);
        tokens.push(
          ...pdfTokens(
            item.str,
            x,
            y,
            Math.abs(item.width || item.str.length * height * 0.5),
            height,
            viewport.width,
            viewport.height
          )
        );
      }
      const text = [...rows.entries()]
        .sort((left, right) => right[0] - left[0])
        .map(([, row]) =>
          row
            .sort((left, right) => left.x - right.x)
            .map((item) => item.text)
            .join(" ")
        )
        .join("\n");
      if (text.trim()) {
        pages.push({
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          unit: "pixel",
          text,
          tokens,
          tables: [],
        });
      }
    }
    return pages.length
      ? {
          pages,
          fieldCandidates: [],
          rawText: pages.map((page) => page.text).join("\f"),
          confidence: 1,
          provider: { name: "local", model: "pdfjs-layout" },
          sourceMode: "embedded_pdf_text" as const,
        }
      : unavailable();
  } catch {
    return unavailable();
  }
}

async function localAnalysis(input: DocumentAnalysisInput) {
  const type = input.type.toLowerCase();
  const extension = input.name.toLowerCase().split(".").pop();
  if (type === "application/pdf" || extension === "pdf") {
    return localPdfAnalysis(input);
  }
  if (type.includes("xml") || extension === "xml" || extension === "ubl") {
    return analysisFromText(await suppliedText(input), "xml_text");
  }
  if (input.text && !type.startsWith("image/")) {
    return analysisFromText(await suppliedText(input), "plain_text");
  }
  return unavailable();
}

function azurePolygon(
  polygon: number[] | undefined,
  width: number,
  height: number
) {
  if (!polygon?.length || !width || !height) return [];
  const points: NormalizedPoint[] = [];
  for (let index = 0; index < polygon.length - 1; index += 2) {
    points.push({ x: clamp(polygon[index] / width), y: clamp(polygon[index + 1] / height) });
  }
  return points;
}

const invoiceFieldNames: Record<string, string> = {
  VendorName: "supplierName",
  VendorTaxId: "supplierVatNumber",
  VendorAddress: "supplierAddress",
  CustomerTaxId: "companyVatNumber",
  InvoiceId: "invoiceNumber",
  InvoiceDate: "invoiceDate",
  DueDate: "dueDate",
  InvoiceTotal: "grossAmount",
  SubTotal: "netAmount",
  TotalTax: "vatAmount",
  PaymentTerm: "paymentTerms",
  PaymentTerms: "paymentTerms",
  CurrencyCode: "currency",
};

function azureFieldValue(field: Record<string, unknown>) {
  for (const key of [
    "valueString",
    "valueDate",
    "valueTime",
    "valuePhoneNumber",
    "valueCountryRegion",
    "valueNumber",
    "valueInteger",
    "valueBoolean",
  ]) {
    const value = field[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
  }
  const currency = field.valueCurrency as Record<string, unknown> | undefined;
  if (currency && typeof currency.amount === "number") return currency.amount;
  return typeof field.content === "string" ? field.content : null;
}

function azureFieldCandidates(
  result: Record<string, unknown>,
  pages: readonly DocumentAnalysisPage[]
) {
  const documents = Array.isArray(result.documents) ? result.documents : [];
  return documents.flatMap((rawDocument) => {
    const document = rawDocument as Record<string, unknown>;
    const fields = document.fields as Record<string, unknown> | undefined;
    if (!fields) return [];
    return Object.entries(fields).flatMap(([label, rawField]) => {
      if (!rawField || typeof rawField !== "object") return [];
      const field = rawField as Record<string, unknown>;
      const regions = Array.isArray(field.boundingRegions) ? field.boundingRegions : [];
      const region = regions[0] as Record<string, unknown> | undefined;
      const page = Number(region?.pageNumber) || undefined;
      const dimensions = pages.find((item) => item.pageNumber === page);
      return [{
        value: azureFieldValue(field),
        field: invoiceFieldNames[label] ?? label,
        label,
        page,
        polygon: dimensions
          ? azurePolygon(
              region?.polygon as number[] | undefined,
              dimensions.width,
              dimensions.height
            )
          : [],
        confidence: Number(field.confidence) || 0,
        source: "azure-document-intelligence",
      } satisfies FieldCandidate];
    });
  });
}

function azureAnalysis(payload: Record<string, unknown>): DocumentAnalysis {
  const result = (payload.analyzeResult ?? payload) as Record<string, unknown>;
  const rawPages = Array.isArray(result.pages) ? result.pages : [];
  const tables = Array.isArray(result.tables) ? result.tables : [];
  const pages = rawPages.map((rawPage, pageIndex) => {
    const page = rawPage as Record<string, unknown>;
    const width = Number(page.width) || 1;
    const height = Number(page.height) || 1;
    const words = Array.isArray(page.words) ? page.words : [];
    const lines = Array.isArray(page.lines) ? page.lines : [];
    const pageNumber = Number(page.pageNumber) || pageIndex + 1;
    const pageTables = tables.flatMap((rawTable) => {
      const table = rawTable as Record<string, unknown>;
      const cells = (Array.isArray(table.cells) ? table.cells : []).flatMap((rawCell) => {
        const cell = rawCell as Record<string, unknown>;
        const regions = Array.isArray(cell.boundingRegions) ? cell.boundingRegions : [];
        const region = regions.find(
          (candidate) => Number((candidate as Record<string, unknown>).pageNumber) === pageNumber
        ) as Record<string, unknown> | undefined;
        if (!region) return [];
        return [{
          rowIndex: Number(cell.rowIndex) || 0,
          columnIndex: Number(cell.columnIndex) || 0,
          rowSpan: Number(cell.rowSpan) || 1,
          columnSpan: Number(cell.columnSpan) || 1,
          text: String(cell.content ?? ""),
          polygon: azurePolygon(region.polygon as number[] | undefined, width, height),
          confidence: Number(cell.confidence) || 1,
        }];
      });
      return cells.length
        ? [{
            rowCount: Number(table.rowCount) || 0,
            columnCount: Number(table.columnCount) || 0,
            cells,
          }]
        : [];
    });
    return {
      pageNumber,
      width,
      height,
      unit: page.unit === "inch" ? "inch" as const : "pixel" as const,
      text: lines.map((line) => String((line as Record<string, unknown>).content ?? "")).join("\n"),
      tokens: words.map((word) => {
        const value = word as Record<string, unknown>;
        return {
          text: String(value.content ?? ""),
          polygon: azurePolygon(value.polygon as number[] | undefined, width, height),
          confidence: Number(value.confidence) || 0,
        };
      }),
      language: typeof page.language === "string" ? page.language : undefined,
      tables: pageTables,
    };
  });
  return {
    pages,
    fieldCandidates: azureFieldCandidates(result, pages),
    rawText: typeof result.content === "string"
      ? result.content
      : pages.map((page) => page.text).join("\f"),
    confidence: pages.length
      ? pages.flatMap((page) => page.tokens).reduce((sum, token) => sum + token.confidence, 0) /
        Math.max(pages.flatMap((page) => page.tokens).length, 1)
      : 0,
    language: typeof result.language === "string" ? result.language : undefined,
    provider: {
      name: "azure-document-intelligence",
      model: String(result.modelId ?? "prebuilt-layout"),
      modelVersion: typeof result.apiVersion === "string" ? result.apiVersion : undefined,
    },
    sourceMode: pages.length ? "ocr" : "unavailable",
  };
}

export const azureDocumentIntelligenceProvider: DocumentAnalysisProvider = async (
  input,
  config
) => {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const modelId = encodeURIComponent(config.modelId);
  const url = `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?_overload=analyzeDocument&api-version=2024-11-30`;
  const bytes = input.arrayBuffer
    ? new Uint8Array(await input.arrayBuffer())
    : new TextEncoder().encode(await suppliedText(input));
  const response = await config.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Ocp-Apim-Subscription-Key": config.key,
    },
    body: JSON.stringify({ base64Source: Buffer.from(bytes).toString("base64") }),
  });
  if (!response.ok) throw new Error("Document intelligence request failed.");
  if (response.status !== 202) {
    return azureAnalysis((await response.json()) as Record<string, unknown>);
  }
  const operation = response.headers.get("operation-location");
  if (!operation) throw new Error("Document intelligence operation was not returned.");
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = config.pollIntervalMs ?? 1_000;
  const deadline = now() + (config.pollTimeoutMs ?? 30_000);
  const retryAfter = (current: Response) => {
    const seconds = Number(current.headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0
      ? seconds * 1_000
      : pollIntervalMs;
  };
  let delay = retryAfter(response);
  while (now() < deadline) {
    await sleep(Math.min(delay, Math.max(1, deadline - now())));
    const poll = await config.fetch(operation, {
      headers: { "Ocp-Apim-Subscription-Key": config.key },
    });
    if (!poll.ok) throw new Error("Document intelligence polling failed.");
    const payload = (await poll.json()) as Record<string, unknown>;
    if (payload.status === "succeeded") return azureAnalysis(payload);
    if (payload.status === "failed") throw new Error("Document intelligence analysis failed.");
    delay = retryAfter(poll);
  }
  throw new Error("Document intelligence analysis timed out.");
};

function shouldUseManagedAnalysis(
  input: DocumentAnalysisInput,
  local: DocumentAnalysis
) {
  if (input.type.toLowerCase().startsWith("image/")) return true;
  const extension = input.name.toLowerCase().split(".").pop();
  if (input.type.toLowerCase() !== "application/pdf" && extension !== "pdf") {
    return false;
  }
  const tokenCount = local.pages.reduce((sum, page) => sum + page.tokens.length, 0);
  const characterCount = local.rawText.replace(/\s/g, "").length;
  return !(
    local.sourceMode === "embedded_pdf_text" &&
    tokenCount >= 10 &&
    characterCount >= 80
  );
}

export async function analyzeDocument(
  input: DocumentAnalysisInput,
  options: DocumentAnalysisOptions = {}
) {
  const local = await localAnalysis(input);
  const env = options.env ?? process.env;
  const enabled =
    env.AZURE_DOCUMENT_INTELLIGENCE_ENABLED ??
    env.DOCUMENT_INTELLIGENCE_ENABLED;
  const endpoint = (
    env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ??
    env.DOCUMENT_INTELLIGENCE_ENDPOINT
  )?.trim();
  const key = (
    env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY ??
    env.DOCUMENT_INTELLIGENCE_KEY
  )?.trim();
  const modelId =
    env.AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID?.trim() || "prebuilt-invoice";
  const configuredTimeout = Number(
    env.AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS ??
      env.DOCUMENT_INTELLIGENCE_TIMEOUT_MS
  );
  if (
    enabled !== "true" ||
    !endpoint ||
    !key ||
    !shouldUseManagedAnalysis(input, local)
  ) {
    return local;
  }
  try {
    const managed = await (options.provider ?? azureDocumentIntelligenceProvider)(input, {
      endpoint,
      key,
      modelId,
      fetch: options.fetch ?? fetch,
      pollTimeoutMs:
        Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? configuredTimeout
          : undefined,
    });
    return managed.pages.length || managed.fieldCandidates.length || managed.rawText.trim()
      ? managed
      : local;
  } catch {
    return local;
  }
}
