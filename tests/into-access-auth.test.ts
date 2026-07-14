import test from "node:test";
import assert from "node:assert/strict";
import {
  createIntoAccessSession,
  isIntoAccessPasswordConfigured,
  verifyIntoAccessPassword,
  verifyIntoAccessSession,
} from "../lib/services/into-access-auth";

const originalPassword = process.env.INTO_ACCESS_PASSWORD;

test.afterEach(() => {
  if (originalPassword === undefined) {
    delete process.env.INTO_ACCESS_PASSWORD;
  } else {
    process.env.INTO_ACCESS_PASSWORD = originalPassword;
  }
});

test("blocks access when the INTO password is not configured", () => {
  delete process.env.INTO_ACCESS_PASSWORD;

  assert.equal(isIntoAccessPasswordConfigured(), false);
  assert.equal(verifyIntoAccessPassword("anything"), false);
  assert.equal(verifyIntoAccessSession("anything"), false);
});

test("accepts only the configured password", () => {
  process.env.INTO_ACCESS_PASSWORD = "correct-horse-battery-staple";

  assert.equal(verifyIntoAccessPassword("wrong password"), false);
  assert.equal(verifyIntoAccessPassword("correct-horse-battery-staple"), true);
});

test("creates a signed session that contains no raw password", () => {
  const password = "correct-horse-battery-staple";
  const now = Date.UTC(2026, 6, 14, 10, 0, 0);
  process.env.INTO_ACCESS_PASSWORD = password;

  const session = createIntoAccessSession(now);

  assert.equal(session.includes(password), false);
  assert.equal(verifyIntoAccessSession(session, now + 1_000), true);
  assert.equal(verifyIntoAccessSession(`${session}tampered`, now + 1_000), false);
  assert.equal(verifyIntoAccessSession(session, now + 24 * 60 * 60 * 1_000), false);
});
