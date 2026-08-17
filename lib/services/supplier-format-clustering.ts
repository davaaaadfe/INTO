import { createHash } from "node:crypto";

export const SUPPLIER_FORMAT_MODEL_VERSION = "structural-layout-v1";
export const SUPPLIER_FORMAT_MATCH_DISTANCE = 0.25;

const stableLabel = new RegExp(
  "^(invoice number|invoice date|document reference|amount due|due date|" +
    "net amount|vat amount|tax amount|invoice|reference|date|issued|" +
    "description|total|net|vat|tax|supplier|customer|iban|bic|currency)\\b"
);
const numericCell = /^(?:(?:[$€£¥]|eur|usd|gbp|chf|cad|aud|jpy|cny|sek|nok|dkk|pln)\s*)?[+-]?\d[\d\s.,'/-]*(?:\s*(?:%|x|pcs?|pieces?|units?|hours?|days?|[$€£¥]|eur|usd|gbp|chf|cad|aud|jpy|cny|sek|nok|dkk|pln))?$/i;

function structuralLine(rawLine: string) {
  const line = rawLine.normalize("NFKC").trim().toLowerCase();
  const field = line.match(/^([^:=]{1,80})([:=]).+$/);
  if (field) return `${field[1].trim().replace(/\s+/g, " ")}${field[2]}<value>`;
  if (/[|\t]/.test(line)) {
    const columns = line.split(/[|\t]/).map((column) => column.trim());
    return columns.some((column) => numericCell.test(column))
      ? `<row>${columns.map((column) => numericCell.test(column) ? "<number>" : "<text>").join("|")}`
      : columns.join("|");
  }
  const label = line.match(stableLabel)?.[0];
  if (label) return line === label ? label : `${label}:<value>`;
  return line ? "<text>" : "";
}

export function structuralFormat(documentText: string) {
  const lines = documentText
    .split(/\r?\n/)
    .slice(0, 256)
    .map(structuralLine)
    .filter(Boolean)
    .filter((line, index, all) => !line.startsWith("<row>") || line !== all[index - 1]);
  const signature = lines.join("\n");
  return {
    signature,
    fingerprint: createHash("sha256").update(signature).digest("hex").slice(0, 16),
    version: SUPPLIER_FORMAT_MODEL_VERSION,
  };
}

function editDistance(left: string[], right: string[]) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function formatDistance(left: string, right: string) {
  const leftLines = left ? left.split("\n") : [];
  const rightLines = right ? right.split("\n") : [];
  const size = Math.max(leftLines.length, rightLines.length, 1);
  return editDistance(leftLines, rightLines) / size;
}

export function assignFormatCluster(
  signature: string,
  clusters: Array<{ id: string; signature: string }>
) {
  const closest = clusters
    .map((cluster) => ({ ...cluster, distance: formatDistance(signature, cluster.signature) }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))[0];
  if (closest && closest.distance <= SUPPLIER_FORMAT_MATCH_DISTANCE) {
    return { clusterId: closest.id, distance: closest.distance, recognized: true };
  }
  return {
    clusterId: `cluster_${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`,
    distance: closest?.distance ?? 1,
    recognized: false,
  };
}
