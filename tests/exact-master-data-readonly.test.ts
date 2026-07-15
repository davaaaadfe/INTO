import test from "node:test";
import assert from "node:assert/strict";
import { assertExactMasterDataReadOnlyRequest } from "../lib/services/exact-api-client";

const masterDataPaths = [
  "/api/v1/123456/crm/Accounts?$top=1",
  "/api/v1/123456/cashflow/PaymentConditions?$top=1",
  "/api/v1/123456/financial/Journals?$top=1",
  "/api/v1/123456/financial/GLAccounts?$top=1",
  "/api/v1/123456/hrm/Costcenters?$top=1",
  "/api/v1/123456/financial/Costcenters?$top=1",
  "/api/v1/123456/hrm/Costunits?$top=1",
  "/api/v1/123456/financial/Costunits?$top=1",
  "/api/v1/123456/vat/VATCodes?$top=1",
  "/api/v1/123456/financial/VATCodes?$top=1",
];

test("allows read-only Exact master-data requests", () => {
  for (const path of masterDataPaths) {
    assert.doesNotThrow(() => assertExactMasterDataReadOnlyRequest("GET", path));
    assert.doesNotThrow(() => assertExactMasterDataReadOnlyRequest("HEAD", path));
  }
});

test("blocks write requests to Exact master-data resources", () => {
  for (const path of masterDataPaths) {
    for (const method of ["POST", "PUT", "PATCH", "MERGE", "DELETE"]) {
      assert.throws(
        () => assertExactMasterDataReadOnlyRequest(method, path),
        /INTO is read-only for Exact master data/
      );
    }
  }
});

test("does not treat OAuth token requests as Exact master-data writes", () => {
  assert.doesNotThrow(() =>
    assertExactMasterDataReadOnlyRequest("POST", "/api/oauth2/token")
  );
});
