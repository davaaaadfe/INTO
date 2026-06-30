import { createId } from "../utils/id";

const supportedExtensions = new Set(["pdf", "jpg", "jpeg", "png", "xml", "ubl"]);

export type StoredFile = {
  storageKey: string;
  fileType: string;
  fileSize: number;
};

export type StoredInvoiceFile = StoredFile & {
  fileName: string;
  bytes: Uint8Array;
};

const globalFileStore = globalThis as typeof globalThis & {
  __INTO_FILE_STORE?: Map<string, StoredInvoiceFile>;
};

function fileStore() {
  if (!globalFileStore.__INTO_FILE_STORE) {
    globalFileStore.__INTO_FILE_STORE = new Map();
  }

  return globalFileStore.__INTO_FILE_STORE;
}

export function getFileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function isSupportedInvoiceFile(fileName: string) {
  return supportedExtensions.has(getFileExtension(fileName));
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

export async function storeInvoiceFile(file: File): Promise<StoredFile> {
  const storedFile: StoredInvoiceFile = {
    storageKey: `invoices/${createId("file")}/${file.name}`,
    fileName: file.name,
    fileType: contentTypeFor(file.name, file.type),
    fileSize: file.size,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };

  fileStore().set(storedFile.storageKey, storedFile);

  return {
    storageKey: storedFile.storageKey,
    fileType: storedFile.fileType,
    fileSize: storedFile.fileSize,
  };
}

export function storeMockInvoiceFile(input: {
  storageKey: string;
  fileName: string;
  fileType: string;
  content: string;
}) {
  const bytes = new TextEncoder().encode(input.content);
  const storedFile: StoredInvoiceFile = {
    storageKey: input.storageKey,
    fileName: input.fileName,
    fileType: contentTypeFor(input.fileName, input.fileType),
    fileSize: bytes.byteLength,
    bytes,
  };

  fileStore().set(input.storageKey, storedFile);
  return storedFile;
}

export function getStoredInvoiceFile(storageKey: string) {
  return fileStore().get(storageKey) ?? null;
}
