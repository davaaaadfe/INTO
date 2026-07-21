import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSupplierAddress,
  normalizeSupplierBic,
  normalizeSupplierChamberOfCommerce,
  normalizeSupplierCode,
  normalizeSupplierIban,
  normalizeSupplierName,
  normalizeSupplierVat,
  supplierIdentityKeys,
} from "../lib/services/supplier-identity";

test("supplier identity normalizers produce canonical provider-independent values", () => {
  assert.equal(normalizeSupplierVat(" nl 123.456.789 b01 "), "NL123456789B01");
  assert.equal(normalizeSupplierIban("NL91 ABNA 0417 1643 00"), "NL91ABNA0417164300");
  assert.equal(normalizeSupplierCode(" sup-001 "), "SUP001");
  assert.equal(normalizeSupplierBic("rabo nl 2u"), "RABONL2U");
  assert.equal(normalizeSupplierChamberOfCommerce("12.34.56.78"), "12345678");
  assert.equal(normalizeSupplierName("Example Services B.V."), "example services");
  assert.equal(
    normalizeSupplierAddress("Coolsingel 88, 3011 AD Rotterdam"),
    "coolsingel 88 3011 ad rotterdam"
  );
  assert.deepEqual(
    supplierIdentityKeys({
      supplierVatNumber: "NL 123456789 B01",
      iban: "NL91 ABNA 0417 1643 00",
      supplierChamberOfCommerceNumber: "12345678",
      supplierName: "Example Services B.V.",
      supplierAddress: "Coolsingel 88, Rotterdam",
      supplierCode: "SUP-001",
      bic: "RABO NL 2U",
    }),
    [
      "vat:NL123456789B01",
      "iban:nl91abna0417164300",
      "code:sup001",
      "bic:rabonl2u",
      "coc:12345678",
      "address:coolsingel 88 rotterdam",
      "name:example-services",
    ]
  );
});
