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
  assert.match(activeReviewSource, /extractedData:\s*draft/);
  assert.match(activeReviewSource, /bookingLines:\s*bookingLinePayloads/);
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
  assert.match(activeReviewSource, /score:\s*35/);
  assert.match(
    activeReviewSource,
    /activeSupplierGeneration > invoice\.learningMetadata\.generation/
  );
});

test("uses a contextual supplier chooser without the duplicated warning title", () => {
  assert.doesNotMatch(activeReviewSource, />\s*Supplier review required\s*</);
  assert.match(activeReviewSource, /supplierResolution\.reviewRequired/);
  assert.match(activeReviewSource, /supplierResolution\.candidates\.map/);
  assert.match(activeReviewSource, /Search all Exact suppliers/);
  assert.match(activeReviewSource, /contextualSupplierReviewVisible/);
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
  assert.match(activeReviewSource, /ref=\{resetLearningCancelRef\}/);
  assert.match(
    activeReviewSource,
    /expectedGeneration:\s*learningResetTarget\.generation/
  );
});

test("does not turn committed mutations or failed summary reads into false training state", () => {
  assert.match(activeReviewSource, /if \(!learningStateLoaded\)/);
  assert.match(activeReviewSource, /supplierLearningLoaded:\s*false/);
  assert.match(activeReviewSource, /state\.supplierLearningLoaded\s*\?/);
  assert.match(activeReviewSource, /profile\?: SupplierLearningProfile/);
  assert.match(activeReviewSource, /applyResetProfile/);
  assert.match(activeReviewSource, /lastLearnedAt:\s*profile\.lastLearnedAt/);
  assert.match(activeReviewSource, /formatFingerprint:\s*profile\.formatFingerprint/);
  assert.match(activeReviewSource, /Supplier learning was saved, but its summary could not be refreshed\./);
  assert.match(activeReviewSource, /Supplier learning was reset, but its summary could not be refreshed\./);
  assert.match(activeReviewSource, /busy === `reset-learning-\$\{learningResetTarget\.supplierAccountId\}`/);
});

test("hides every supplier-learning surface behind the public enabled state", () => {
  assert.match(activeReviewSource, /supplierLearningEnabled:\s*boolean/);
  assert.match(activeReviewSource, /supplierLearningEnabled:\s*false/);
  assert.match(
    activeReviewSource,
    /const availableViews:\s*ActiveView\[\]\s*=\s*state\.supplierLearningEnabled/
  );
  assert.match(
    activeReviewSource,
    /\.\.\.\(state\.supplierLearningEnabled\s*\?\s*\[\s*\{\s*key:\s*"learn"/
  );
  assert.match(
    activeReviewSource,
    /state\.supplierLearningEnabled\s*&&\s*activeView === "supplier-learning"/
  );
  assert.match(
    activeReviewSource,
    /state\.supplierLearningEnabled\s*&&\s*selectedSupplierLearning/
  );
  assert.match(
    activeReviewSource,
    /state\.supplierLearningEnabled\s*\?\s*\(\s*<dialog/
  );
});
