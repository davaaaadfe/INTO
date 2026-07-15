import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeSupplierOverviewWithExactSuppliers,
  normalizeSupplierOverviewRows,
} from "../lib/services/supplier-overview-import";
import { createMockExactMasterData } from "../lib/services/exact-master-data-service";
import {
  getExactMasterData,
  getStore,
  getSupplierOverviewImportStatus,
  replaceSupplierOverviewImport,
} from "../lib/repository/invoice-store";

test("normalizes only the requested supplier overview columns", () => {
  const suppliers = normalizeSupplierOverviewRows([
    ["Company: 101020 - InBody Europe B.V."],
    [
      "Code",
      "Name",
      "City",
      "Country",
      "Supplier",
      "Bank account",
      "BIC code",
      "Address",
      "VAT number",
    ],
    [
      " 001 ",
      "  ACME   B.V. ",
      " Amsterdam ",
      " The Netherlands ",
      " V ",
      " NL12 RABO 0123 4567 89 ",
      " RABO NL 2U ",
      " Main street 1 ,   Amsterdam ",
      "must-be-ignored",
    ],
    ["002", "Customer only", "Utrecht", "NL", "", "", "", "", "ignored"],
  ]);

  assert.deepEqual(suppliers, [
    {
      code: "001",
      name: "ACME B.V.",
      city: "Amsterdam",
      country: "NL",
      supplier: true,
      bankAccount: "NL12RABO0123456789",
      bicCode: "RABONL2U",
      address: "Main street 1, Amsterdam",
    },
  ]);
  assert.deepEqual(Object.keys(suppliers[0]), [
    "code",
    "name",
    "city",
    "country",
    "supplier",
    "bankAccount",
    "bicCode",
    "address",
  ]);
});

test("rejects a workbook that is missing a required supplier column", () => {
  assert.throws(
    () =>
      normalizeSupplierOverviewRows([
        ["Code", "Name", "City", "Country", "Supplier", "Bank account", "Address"],
      ]),
    /BIC code/
  );
});

test("re-import data preserves real Exact IDs and adds imported suppliers", () => {
  const existing = createMockExactMasterData().suppliers;
  const merged = mergeSupplierOverviewWithExactSuppliers(
    [
      {
        code: "70002",
        name: "Delta IT Services Europe",
        city: "Utrecht",
        country: "NL",
        supplier: true,
        bankAccount: "NL39RABO0300065264",
        bicCode: "RABONL2U",
        address: "Europalaan 21, Utrecht",
      },
      {
        code: "99999",
        name: "Imported Supplier",
        city: "Rotterdam",
        country: "NL",
        supplier: true,
        bankAccount: "NL91ABNA0417164300",
        bicCode: "ABNANL2A",
        address: "Coolsingel 1, Rotterdam",
      },
    ],
    existing
  );

  assert.equal(merged.find((supplier) => supplier.code === "70002")?.id, "supplier_delta_it");
  assert.equal(
    merged.find((supplier) => supplier.code === "70002")?.name,
    "Delta IT Services Europe"
  );
  assert.equal(
    merged.find((supplier) => supplier.code === "99999")?.id,
    "supplier-overview:99999"
  );
  assert.deepEqual(
    {
      city: merged.find((supplier) => supplier.code === "99999")?.city,
      bicCode: merged.find((supplier) => supplier.code === "99999")?.bicCode,
      isSupplier: merged.find((supplier) => supplier.code === "99999")?.isSupplier,
    },
    {
      city: "Rotterdam",
      bicCode: "ABNANL2A",
      isSupplier: true,
    }
  );
  assert.equal(merged.some((supplier) => supplier.code === "70001"), false);
});

test("re-import replaces the previous durable supplier overview snapshot", () => {
  getStore().supplierOverviewImport = null;
  const firstImportedAt = "2026-07-15T10:00:00.000Z";
  replaceSupplierOverviewImport({
    sourceFileName: "suppliers-first.xlsx",
    importedAt: firstImportedAt,
    suppliers: [
      {
        code: "99999",
        name: "First Imported Supplier",
        city: "Amsterdam",
        country: "NL",
        supplier: true,
        bankAccount: "",
        bicCode: "",
        address: "",
      },
    ],
  });

  assert.deepEqual(getSupplierOverviewImportStatus(), {
    sourceFileName: "suppliers-first.xlsx",
    importedAt: firstImportedAt,
    supplierCount: 1,
  });
  assert.equal(
    getExactMasterData()?.suppliers.some((supplier) => supplier.code === "99999"),
    true
  );

  replaceSupplierOverviewImport({
    sourceFileName: "suppliers-latest.xlsx",
    importedAt: "2026-07-15T11:00:00.000Z",
    suppliers: [
      {
        code: "88888",
        name: "Latest Imported Supplier",
        city: "Rotterdam",
        country: "NL",
        supplier: true,
        bankAccount: "",
        bicCode: "",
        address: "",
      },
    ],
  });

  assert.equal(
    getExactMasterData()?.suppliers.some((supplier) => supplier.code === "99999"),
    false
  );
  assert.equal(
    getExactMasterData()?.suppliers.some((supplier) => supplier.code === "88888"),
    true
  );
});
