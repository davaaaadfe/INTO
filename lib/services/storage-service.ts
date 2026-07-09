import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createId } from "../utils/id";

const supportedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "xml", "ubl"]);

export type StoredFile = {
  storageKey: string;
  fileType: string;
  fileSize: number;
  checksum: string;
};

export type StoredInvoiceFile = StoredFile & {
  fileName: string;
  bytes: Uint8Array;
};

type StorageProvider = "local_temp";

export function getFileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function isSupportedInvoiceFile(fileName: string) {
  return supportedExtensions.has(getFileExtension(fileName));
}

export function supportedInvoiceFileExtensions() {
  return [...supportedExtensions];
}

function envValue(key: string) {
  return process.env[key]?.trim() ?? "";
}

export function invoiceStorageProvider(): StorageProvider {
  return "local_temp";
}

export function temporaryInvoiceStoragePath() {
  const configuredPath = envValue("TEMP_INVOICE_STORAGE_PATH");
  if (!configuredPath) {
    return path.join(
      /*turbopackIgnore: true*/ process.cwd(),
      "storage",
      "tmp-invoices"
    );
  }

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), configuredPath);
}

export function temporaryInvoiceRetentionDays() {
  const parsed = Number.parseInt(envValue("TEMP_INVOICE_RETENTION_DAYS"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function contentTypeFor(fileName: string, fileType = "") {
  if (fileType && fileType !== "application/octet-stream") {
    return fileType;
  }

  const extension = getFileExtension(fileName);
  if (extension === "pdf") {
    return "application/pdf";
  }
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "xml" || extension === "ubl") {
    return "application/xml";
  }

  return "application/octet-stream";
}

function checksumFor(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFileName(fileName: string) {
  const baseName = path.basename(fileName).replace(/[^\w.-]+/g, "_");
  return baseName || "invoice";
}

function fileNameFromStorageKey(storageKey: string) {
  return path.basename(storageKey).replace(/^file_[\w-]+__/, "");
}

function localStorageKey(fileName: string) {
  return path.join(
    temporaryInvoiceStoragePath(),
    `${createId("file")}__${safeFileName(fileName)}`
  );
}

export async function storeInvoiceFile(file: File): Promise<StoredFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const storageKey = localStorageKey(file.name);
  await mkdir(path.dirname(storageKey), { recursive: true });
  await writeFile(storageKey, bytes);

  return {
    storageKey,
    fileType: contentTypeFor(file.name, file.type),
    fileSize: bytes.byteLength,
    checksum: checksumFor(bytes),
  };
}

export function storeMockInvoiceFile(input: {
  storageKey?: string;
  fileName: string;
  fileType: string;
  content: string;
}) {
  const bytes = new TextEncoder().encode(input.content);
  const storageKey = input.storageKey
    ? path.resolve(/*turbopackIgnore: true*/ process.cwd(), input.storageKey)
    : localStorageKey(input.fileName);
  mkdirSync(path.dirname(storageKey), { recursive: true });
  writeFileSync(storageKey, bytes);

  return {
    storageKey,
    fileName: input.fileName,
    fileType: contentTypeFor(input.fileName, input.fileType),
    fileSize: bytes.byteLength,
    checksum: checksumFor(bytes),
    bytes,
  };
}

export async function getStoredInvoiceFile(
  storageKey: string,
  fallback?: { fileName?: string; fileType?: string }
) {
  try {
    const bytes = await readFile(storageKey);
    const metadata = await stat(storageKey);
    const fileName = fallback?.fileName || fileNameFromStorageKey(storageKey);
    const fileType = fallback?.fileType || contentTypeFor(fileName);

    return {
      storageKey,
      fileName,
      fileType,
      fileSize: metadata.size,
      checksum: checksumFor(bytes),
      bytes,
    };
  } catch {
    return null;
  }
}

export async function deleteStoredInvoiceFile(storageKey: string) {
  try {
    await unlink(storageKey);
    return true;
  } catch {
    return false;
  }
}

export function deleteStoredInvoiceFileSync(storageKey: string) {
  try {
    unlinkSync(storageKey);
    return true;
  } catch {
    return false;
  }
}

export async function verifyInvoiceStorageWorks() {
  const content = "INTO storage readiness check";
  const stored = await storeInvoiceFile(
    new File([content], "storage-check.txt", { type: "text/plain" })
  );
  const storedAgain = await getStoredInvoiceFile(stored.storageKey, {
    fileName: "storage-check.txt",
    fileType: "text/plain",
  });
  await deleteStoredInvoiceFile(stored.storageKey);

  return Boolean(
    storedAgain &&
      storedAgain.fileSize === content.length &&
      new TextDecoder().decode(storedAgain.bytes) === content
  );
}
