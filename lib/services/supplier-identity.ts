import type { ExtractedInvoiceData } from "../domain/invoice";

function compact(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function words(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeSupplierVat(value: string | null | undefined) {
  return compact(value);
}

export function normalizeSupplierIban(value: string | null | undefined) {
  return compact(value);
}

export function normalizeSupplierCode(value: string | null | undefined) {
  return compact(value);
}

export function normalizeSupplierBic(value: string | null | undefined) {
  return compact(value);
}

export function normalizeSupplierChamberOfCommerce(
  value: string | null | undefined
) {
  return compact(value);
}

export function normalizeSupplierName(value: string | null | undefined) {
  const legalSuffixes = new Set([
    "bv",
    "b",
    "v",
    "nv",
    "n",
    "ltd",
    "limited",
    "llc",
    "inc",
    "gmbh",
    "sa",
    "sarl",
  ]);
  return words(value)
    .split(" ")
    .filter((word) => word && !legalSuffixes.has(word))
    .join(" ");
}

export function normalizeSupplierAddress(value: string | null | undefined) {
  return words(value);
}

export function normalizeSupplierCountry(value: string | null | undefined) {
  const normalized = words(value).replace(/\s/g, "");
  const aliases: Record<string, string> = {
    belgium: "BE",
    belgie: "BE",
    belgique: "BE",
    deutschland: "DE",
    germany: "DE",
    france: "FR",
    nederland: "NL",
    netherlands: "NL",
    thenetherlands: "NL",
    unitedkingdom: "GB",
    uk: "GB",
    unitedstates: "US",
    unitedstatesofamerica: "US",
    usa: "US",
  };
  return normalized.length === 2
    ? normalized.toUpperCase()
    : aliases[normalized] ?? normalized.toUpperCase();
}

export function supplierIdentityKeys(
  data: Pick<
    ExtractedInvoiceData,
    | "supplierVatNumber"
    | "iban"
    | "supplierChamberOfCommerceNumber"
    | "supplierName"
    | "supplierAddress"
  > & { supplierCode?: string; bic?: string }
) {
  return [
    normalizeSupplierVat(data.supplierVatNumber)
      ? `vat:${normalizeSupplierVat(data.supplierVatNumber)}`
      : "",
    normalizeSupplierIban(data.iban)
      ? `iban:${normalizeSupplierIban(data.iban).toLowerCase()}`
      : "",
    normalizeSupplierCode(data.supplierCode)
      ? `code:${normalizeSupplierCode(data.supplierCode).toLowerCase()}`
      : "",
    normalizeSupplierBic(data.bic)
      ? `bic:${normalizeSupplierBic(data.bic).toLowerCase()}`
      : "",
    normalizeSupplierChamberOfCommerce(data.supplierChamberOfCommerceNumber)
      ? `coc:${normalizeSupplierChamberOfCommerce(
          data.supplierChamberOfCommerceNumber
        ).toLowerCase()}`
      : "",
    normalizeSupplierAddress(data.supplierAddress)
      ? `address:${normalizeSupplierAddress(data.supplierAddress)}`
      : "",
    normalizeSupplierName(data.supplierName)
      ? `name:${normalizeSupplierName(data.supplierName).replace(/\s/g, "-")}`
      : "",
  ].filter(Boolean);
}

export function supplierNameSimilarity(left: string, right: string) {
  const leftWords = normalizeSupplierName(left).split(" ").filter(Boolean);
  const rightWords = normalizeSupplierName(right).split(" ").filter(Boolean);
  if (!leftWords.length || !rightWords.length) return 0;
  if (leftWords.join(" ") === rightWords.join(" ")) return 1;
  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  const overlap = [...leftSet].filter((word) => rightSet.has(word)).length;
  return overlap / Math.max(leftSet.size, rightSet.size);
}

export function supplierAddressSimilarity(left: string, right: string) {
  const leftWords = new Set(normalizeSupplierAddress(left).split(" ").filter(Boolean));
  const rightWords = new Set(normalizeSupplierAddress(right).split(" ").filter(Boolean));
  if (leftWords.size < 2 || rightWords.size < 2) return 0;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / Math.min(leftWords.size, rightWords.size);
}
