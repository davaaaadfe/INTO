import type { DocumentTextMode } from "../domain/invoice";
import {
  analyzeDocument,
  type DocumentAnalysisOptions,
  type DocumentAnalysisInput,
  type DocumentAnalysis,
  type DocumentToken,
  type FieldCandidate,
} from "./document-analysis";

export type DocumentTextPage = {
  readonly pageNumber: number;
  readonly text: string;
  readonly tokens: readonly DocumentToken[];
};

export type DocumentTextResult = {
  readonly mode: DocumentTextMode;
  readonly pages: readonly DocumentTextPage[];
  readonly text: string;
  readonly fieldCandidates: readonly FieldCandidate[];
  readonly analysis: DocumentAnalysis;
};

export type DocumentTextInput = DocumentAnalysisInput;

export async function extractDocumentText(
  input: DocumentTextInput,
  options: DocumentAnalysisOptions = {}
): Promise<DocumentTextResult> {
  const analysis = await analyzeDocument(input, options);
  const mode: DocumentTextMode =
    analysis.sourceMode === "ocr" ? "plain_text" : analysis.sourceMode;
  return {
    mode,
    pages: analysis.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
      tokens: page.tokens,
    })),
    text: analysis.rawText,
    fieldCandidates: analysis.fieldCandidates,
    analysis,
  };
}
