import test from "node:test";
import assert from "node:assert/strict";
import { movePreviewPan, resetPreviewPan } from "../lib/services/preview-pan";

test("moves invoice preview pan by drag delta", () => {
  assert.deepEqual(movePreviewPan({ x: 12, y: -8 }, { x: 25, y: 14 }), {
    x: 37,
    y: 6,
  });
});

test("resets invoice preview pan to origin", () => {
  assert.deepEqual(resetPreviewPan(), { x: 0, y: 0 });
});
