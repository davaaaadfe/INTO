import readXlsxFile from "read-excel-file/node";
import type {
  ExactSupplierAccount,
  SupplierOverviewRecord,
} from "../domain/invoice";

const requiredColumns = [
  "Code",
  "Name",
  "City",
  "Country",
  "Supplier",
  "Bank account",
  "BIC code",
  "Address",
] as const;

const countryAliases = new Map<string, string>([
  ["THE NETHERLANDS", "NL"],
  ["NETHERLANDS", "NL"],
  ["NEDERLAND", "NL"],
  ["NLD", "NL"],
  ["NETHERLANDS ANTILLES", "AN"],
  ["BELGIUM", "BE"],
  ["BELGIE", "BE"],
  ["BEL", "BE"],
  ["GERMANY", "DE"],
  ["DEUTSCHLAND", "DE"],
  ["DUITSLAND", "DE"],
  ["DEU", "DE"],
  ["FRANCE", "FR"],
  ["FRANKRIJK", "FR"],
  ["FRA", "FR"],
  ["IRELAND", "IE"],
  ["IERLAND", "IE"],
  ["IRL", "IE"],
  ["UNITED KINGDOM", "GB"],
  ["GREAT BRITAIN", "GB"],
  ["UK", "GB"],
  ["GBR", "GB"],
  ["SPAIN", "ES"],
  ["SPANJE", "ES"],
  ["ESP", "ES"],
  ["ITALY", "IT"],
  ["ITALIE", "IT"],
  ["ITA", "IT"],
  ["ARGENTINA", "AR"],
  ["AUSTRIA", "AT"],
  ["CHINA", "CN"],
  ["DENMARK", "DK"],
  ["ESTONIA", "EE"],
  ["FINLAND", "FI"],
  ["GREECE", "GR"],
  ["HUNGARY", "HU"],
  ["INDIA", "IN"],
  ["ISRAEL", "IL"],
  ["JAPAN", "JP"],
  ["LITHUANIA", "LT"],
  ["LUXEMBOURG", "LU"],
  ["MEXICO", "MX"],
  ["MOROCCO", "MA"],
  ["POLAND", "PL"],
  ["PORTUGAL", "PT"],
  ["REPUBLIC OF KOREA", "KR"],
  ["ROMANIA", "RO"],
  ["SINGAPORE", "SG"],
  ["SLOVAKIA", "SK"],
  ["SLOVENIA", "SI"],
  ["SOUTH AFRICA", "ZA"],
  ["SWEDEN", "SE"],
  ["SWITZERLAND", "CH"],
  ["TURKIYE", "TR"],
  ["TURKEY", "TR"],
  ["UNITED STATES OF AMERICA", "US"],
  ["UNITED STATES", "US"],
  ["USA", "US"],
]);

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function normalizedHeader(value: unknown) {
  return text(value).toLocaleLowerCase("en-US");
}

function normalizeCountry(value: unknown) {
  const cleaned = text(value);
  if (!cleaned) return "";
  const upper = cleaned
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleUpperCase("en-US");
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return countryAliases.get(upper) ?? cleaned;
}

function compactUpper(value: unknown) {
  return text(value).replace(/\s+/g, "").toLocaleUpperCase("en-US");
}

function normalizeAddress(value: unknown) {
  return text(value).replace(/\s*,\s*/g, ", ");
}

function isSupplierMarker(value: unknown) {
  const marker = compactUpper(value);
  return ["V", "YES", "JA", "TRUE", "1", "X"].includes(marker);
}

export function normalizeSupplierOverviewRows(
  rows: ReadonlyArray<ReadonlyArray<unknown>>
): SupplierOverviewRecord[] {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = new Set(row.map(normalizedHeader));
    return requiredColumns.every((column) => headers.has(normalizedHeader(column)));
  });

  if (headerRowIndex < 0) {
    const availableHeaders = new Set(rows.flatMap((row) => row.map(normalizedHeader)));
    const missing = requiredColumns.filter(
      (column) => !availableHeaders.has(normalizedHeader(column))
    );
    throw new Error(
      `Supplier overview is missing required column(s): ${missing.join(", ") || requiredColumns.join(", ")}.`
    );
  }

  const headerRow = rows[headerRowIndex];
  const indexes = Object.fromEntries(
    requiredColumns.map((column) => [
      column,
      headerRow.findIndex(
        (header) => normalizedHeader(header) === normalizedHeader(column)
      ),
    ])
  ) as Record<(typeof requiredColumns)[number], number>;
  const byCode = new Map<string, SupplierOverviewRecord>();

  for (const row of rows.slice(headerRowIndex + 1)) {
    const code = compactUpper(row[indexes.Code]);
    const name = text(row[indexes.Name]);
    const supplier = isSupplierMarker(row[indexes.Supplier]);
    if (!supplier || !code || !name) continue;

    byCode.set(code, {
      code,
      name,
      city: text(row[indexes.City]),
      country: normalizeCountry(row[indexes.Country]),
      supplier,
      bankAccount: compactUpper(row[indexes["Bank account"]]),
      bicCode: compactUpper(row[indexes["BIC code"]]),
      address: normalizeAddress(row[indexes.Address]),
    });
  }

  if (byCode.size === 0) {
    throw new Error("Supplier overview contains no supplier records.");
  }

  return [...byCode.values()];
}

export async function parseSupplierOverviewWorkbook(bytes: Buffer) {
  const sheets = await readXlsxFile(bytes);
  if (!sheets.length) {
    throw new Error("Supplier overview workbook contains no worksheets.");
  }

  for (const sheet of sheets) {
    try {
      return normalizeSupplierOverviewRows(sheet.data);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("Supplier overview is missing required column")
      ) {
        throw error;
      }
    }
  }

  throw new Error(
    `Supplier overview is missing required column(s): ${requiredColumns.join(", ")}.`
  );
}

export function mergeSupplierOverviewWithExactSuppliers(
  imported: SupplierOverviewRecord[],
  exactSuppliers: ExactSupplierAccount[]
) {
  const exactByCode = new Map(
    exactSuppliers.map((supplier) => [compactUpper(supplier.code), supplier])
  );
  const importedAccounts = imported.map((supplier): ExactSupplierAccount => {
    const exact = exactByCode.get(supplier.code);
    return {
      id: exact?.id ?? `supplier-overview:${supplier.code}`,
      code: supplier.code,
      name: supplier.name,
      vatNumber: exact?.vatNumber ?? "",
      iban: supplier.bankAccount || exact?.iban || "",
      bicCode: supplier.bicCode || exact?.bicCode || "",
      chamberOfCommerceNumber: exact?.chamberOfCommerceNumber ?? "",
      address: supplier.address || exact?.address || "",
      city: supplier.city || exact?.city || "",
      country: supplier.country || exact?.country || "",
      isSupplier: supplier.supplier,
      paymentConditionCode: exact?.paymentConditionCode ?? "",
      paymentConditionLabel: exact?.paymentConditionLabel ?? "",
      defaultGlAccount: exact?.defaultGlAccount ?? "",
      defaultGlAccountName: exact?.defaultGlAccountName ?? "",
      defaultCostCentre: exact?.defaultCostCentre,
      defaultCostUnit: exact?.defaultCostUnit,
      isInBodyEntity: exact?.isInBodyEntity ?? /inbody/i.test(supplier.name),
    };
  });

  return importedAccounts;
}
