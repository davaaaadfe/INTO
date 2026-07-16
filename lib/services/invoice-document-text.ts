import type { DocumentTextMode } from "../domain/invoice";

export type DocumentTextPage = {
  pageNumber: number;
  text: string;
};

export type DocumentTextResult = {
  mode: DocumentTextMode;
  pages: DocumentTextPage[];
  text: string;
};

export type DocumentTextInput = {
  name: string;
  type: string;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

function unavailable(): DocumentTextResult {
  return { mode: "unavailable", pages: [], text: "" };
}

function pagesFromText(text: string) {
  return text
    .replace(/\r/g, "")
    .split(/\f/)
    .map((page, index) => ({ pageNumber: index + 1, text: page.trim() }))
    .filter((page) => page.text);
}

function resultFromText(text: string, mode: DocumentTextMode) {
  const pages = pagesFromText(text);
  return {
    mode: pages.length ? mode : "unavailable",
    pages,
    text: pages.map((page) => page.text).join("\f"),
  } satisfies DocumentTextResult;
}

async function readSuppliedText(input: DocumentTextInput) {
  if (!input.text) {
    return "";
  }
  try {
    return await input.text();
  } catch {
    return "";
  }
}

async function readPdfText(input: DocumentTextInput) {
  if (!input.arrayBuffer) {
    return resultFromText(await readSuppliedText(input), "plain_text");
  }

  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await input.arrayBuffer());
    const document = await pdfjs.getDocument({ data, disableFontFace: true }).promise;
    const pages: DocumentTextPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const rows = new Map<number, Array<{ x: number; text: string }>>();

      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) {
          continue;
        }
        const y = Math.round(item.transform[5]);
        const row = rows.get(y) ?? [];
        row.push({ x: item.transform[4], text: item.str.trim() });
        rows.set(y, row);
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
      pages.push({ pageNumber, text });
    }

    return {
      mode: pages.some((page) => page.text.trim())
        ? "embedded_pdf_text"
        : "unavailable",
      pages: pages.filter((page) => page.text.trim()),
      text: pages.map((page) => page.text.trim()).filter(Boolean).join("\f"),
    } satisfies DocumentTextResult;
  } catch {
    return unavailable();
  }
}

export async function extractDocumentText(
  input: DocumentTextInput
): Promise<DocumentTextResult> {
  const type = input.type.toLowerCase();
  const extension = input.name.toLowerCase().split(".").pop();

  if (type === "application/pdf" || extension === "pdf") {
    return readPdfText(input);
  }
  if (
    type.includes("xml") ||
    extension === "xml" ||
    extension === "ubl"
  ) {
    return resultFromText(await readSuppliedText(input), "xml_text");
  }
  if (input.text && !type.startsWith("image/")) {
    return resultFromText(await readSuppliedText(input), "plain_text");
  }
  return unavailable();
}
