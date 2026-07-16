import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const activeReviewSource = readFileSync(
  new URL("../components/into-workbench.tsx", import.meta.url),
  "utf8"
);

test("renders unresolved supplier choices inside Required data", () => {
  const requiredData = activeReviewSource.indexOf(
    '<ReviewSection title="Required data">'
  );
  const supplierChoices = activeReviewSource.indexOf(
    "supplierResolution.candidates.map"
  );
  const intelligence = activeReviewSource.indexOf(
    "<span>Purchase Journal intelligence</span>"
  );

  assert.ok(requiredData >= 0);
  assert.ok(supplierChoices > requiredData);
  assert.ok(supplierChoices < intelligence);
});

test("uses one visible expense-description and invoice-total workflow", () => {
  assert.doesNotMatch(activeReviewSource, /label="Expense description"/);
  assert.match(activeReviewSource, />\s*Expense description\s*</);
  assert.doesNotMatch(activeReviewSource, /Calculated booking total/);
  assert.doesNotMatch(activeReviewSource, /label="Total Amount"/);
});

test("keeps removed preview controls out of the active component", () => {
  for (const label of [
    "Fit width",
    "Fit height",
    "Zoom in",
    "Zoom out",
    "Reset view",
    "Fullscreen preview",
  ]) {
    assert.equal(activeReviewSource.includes(label), false, label);
  }
});
