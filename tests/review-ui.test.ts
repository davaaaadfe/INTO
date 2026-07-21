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

test("keeps deployment proof markers out of the production UI", () => {
  assert.doesNotMatch(activeReviewSource, /UI CHANGE PROOF/);
  assert.doesNotMatch(activeReviewSource, /DEPLOYMENT PROOF/);
});

test("places Learn between saving and approval and sends the live revision", () => {
  const save = activeReviewSource.indexOf('label: "Save changes"');
  const learn = activeReviewSource.indexOf('label: "Learn"');
  const review = activeReviewSource.indexOf('label: "Mark as reviewed"');

  assert.ok(save >= 0);
  assert.ok(learn > save);
  assert.ok(review > learn);
  assert.match(activeReviewSource, /expectedRevision:\s*selectedInvoice\.revision/);
  assert.match(activeReviewSource, /Learning saved for this supplier\./);
});

test("adds a Supplier learning view with separate reliability copy", () => {
  assert.match(
    activeReviewSource,
    /type ActiveView = "queue" \| "archive" \| "supplier-learning"/
  );
  assert.match(activeReviewSource, />\s*Supplier learning\s*</);
  assert.match(activeReviewSource, /Supplier reliability/);
  assert.match(activeReviewSource, /INTO usually reads this supplier correctly\./);
  assert.match(activeReviewSource, /Review recommended\./);
  assert.match(activeReviewSource, /More training invoices needed\./);
});

test("uses a contextual supplier chooser without the duplicated warning title", () => {
  assert.doesNotMatch(activeReviewSource, />\s*Supplier review required\s*</);
  assert.match(activeReviewSource, /supplierResolution\.reviewRequired/);
  assert.match(activeReviewSource, /supplierResolution\.candidates\.map/);
  assert.match(activeReviewSource, /Search all Exact suppliers/);
});

test("uses an accessible reset dialog with the approved destructive-action copy", () => {
  assert.match(activeReviewSource, /<dialog/);
  assert.match(activeReviewSource, /aria-labelledby="supplier-learning-reset-title"/);
  assert.match(
    activeReviewSource,
    /Reset learning for this supplier\? INTO will forget previous training patterns for this supplier\. Existing invoices and Exact bookings will not be deleted\./
  );
  assert.match(activeReviewSource, />\s*Cancel\s*</);
  assert.match(activeReviewSource, />\s*Reset learning\s*</);
});
