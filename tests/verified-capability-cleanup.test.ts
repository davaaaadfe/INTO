import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(entry.name)
        ? [path]
        : [];
  });
}

test("live code does not branch on human roles or permissions", () => {
  for (const file of ["app", "components", "lib"].flatMap(sourceFiles)) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /\b(?:PermissionAction|SHARED_ACCESS_PERMISSIONS|requirePermission|requireSystemOwner)\b/,
      file
    );
  }
});

test("structured telemetry does not attach raw document or supplier identifiers", () => {
  for (const file of ["app", "lib"].flatMap(sourceFiles)) {
    const source = readFileSync(file, "utf8");
    const calls = source.match(/logger\.(?:info|warn|error)\([\s\S]*?\);/g) ?? [];
    for (const call of calls) {
      assert.doesNotMatch(
        call,
        /\b(?:fileName|sourceFileName|storageKey|contentHash|supplierAccountId)\s*:/,
        file
      );
    }
  }
});
