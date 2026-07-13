import test from "node:test";
import assert from "node:assert/strict";
import {
  clampPreviewPan,
  movePreviewPan,
  resetPreviewPan,
} from "../lib/services/preview-pan";

test("moves invoice preview pan by drag delta", () => {
  assert.deepEqual(movePreviewPan({ x: 12, y: -8 }, { x: 25, y: 14 }), {
    x: 37,
    y: 6,
  });
});

test("resets invoice preview pan to origin", () => {
  assert.deepEqual(resetPreviewPan(), { x: 0, y: 0 });
});

test("clamps pan so the invoice stays inside the preview area", () => {
  assert.deepEqual(
    clampPreviewPan(
      { x: 700, y: -500 },
      {
        viewportWidth: 800,
        viewportHeight: 600,
        contentWidth: 1200,
        contentHeight: 900,
      }
    ),
    { x: 200, y: -150 }
  );
});

test("centers pan when the invoice is smaller than the preview area", () => {
  assert.deepEqual(
    clampPreviewPan(
      { x: 40, y: 30 },
      {
        viewportWidth: 1000,
        viewportHeight: 800,
        contentWidth: 700,
        contentHeight: 500,
      }
    ),
    { x: 0, y: 0 }
  );
});
