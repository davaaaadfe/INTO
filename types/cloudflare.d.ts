type Fetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type D1Result<T = unknown> = {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
  error?: string;
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
  raw<T = unknown>(): Promise<T[]>;
};

type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};

type R2Bucket = {
  get(key: string): Promise<unknown>;
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<unknown>;
  delete(key: string): Promise<void>;
};

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    INVOICE_FILES?: R2Bucket;
    ASSETS?: Fetcher;
    IMAGES?: unknown;
    [key: string]: unknown;
  };
}
