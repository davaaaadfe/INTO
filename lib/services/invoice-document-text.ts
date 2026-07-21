import type { DocumentTextMode } from "../domain/invoice";
import {
  analyzeDocument,
  type DocumentAnalysisInput,
} from "./document-analysis";

export type DocumentTextPage = {
  pageNumber: number;
  text: string;
};

export type DocumentTextResult = {
  mode: DocumentTextMode;
  pages: DocumentTextPage[];
  text: string;
};

export type DocumentTextInput = DocumentAnalysisInput;

export async function extractDocumentText(
  input: DocumentTextInput
): Promise<DocumentTextResult> {
  const analysis = await analyzeDocument(input);
  const mode: DocumentTextMode =
    analysis.sourceMode === "ocr" ? "plain_text" : analysis.sourceMode;
  return {
    mode,
    pages: analysis.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
    })),
    text: analysis.rawText,
  };
}
