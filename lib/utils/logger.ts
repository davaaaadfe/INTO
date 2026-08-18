type LogLevel = "info" | "warn" | "error";

const sensitiveLogKey = /^(?:message|description|error|fileName|sourceFileName|storageKey|contentHash|rawText|oldValue|newValue|evidence|iban|vat|supplierAccountId|supplierId)$/i;
const secretLogKey = /(?:cookie|password|secret|token)/i;

function safeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeLogValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      sensitiveLogKey.test(key) || secretLogKey.test(key)
        ? []
        : [[key, safeLogValue(nested)]]
    )
  );
}

function write(level: LogLevel, event: string, detail?: Record<string, unknown>) {
  const payload = {
    level,
    event,
    at: new Date().toISOString(),
    ...(safeLogValue(detail) as Record<string, unknown> | undefined),
  };

  if (level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}

export const logger = {
  info: (event: string, detail?: Record<string, unknown>) =>
    write("info", event, detail),
  warn: (event: string, detail?: Record<string, unknown>) =>
    write("warn", event, detail),
  error: (event: string, detail?: Record<string, unknown>) =>
    write("error", event, detail),
};
