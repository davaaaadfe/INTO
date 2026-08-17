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
  readonly id?: string;
  readonly value: string | number | boolean | null;
  readonly rawValue?: string;
  readonly normalizedValue?: string | number | boolean | null;
  readonly field: string;
  readonly label?: string;
  readonly page?: number;
  readonly polygon: readonly NormalizedPoint[];
  readonly confidence: number;
  readonly source: string;
  readonly rule?: string;
  readonly model?: string;
  readonly supportingText?: string;
  readonly clusterContext?: {
    readonly supplierAccountId: string;
    readonly generation: number;
    readonly clusterId: string;
  };
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

export type DocumentProviderOutcome = {
  readonly status: "succeeded" | "failed" | "unavailable";
  readonly adapter: string;
  readonly reason?:
    | "no_extractable_content"
    | "ocr_unavailable"
    | "empty_result"
    | "provider_error"
    | "timeout";
};

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
  readonly providerOutcome: DocumentProviderOutcome;
  readonly sourceMode: DocumentAnalysisSourceMode;
};

export type PersistedDocumentAnalysis = Omit<
  DocumentAnalysis,
  "rawText" | "providerOutcome"
> & {
  readonly providerOutcome?: DocumentProviderOutcome;
};
