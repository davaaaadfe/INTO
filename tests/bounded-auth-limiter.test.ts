import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedAuthLimiter } from "../lib/services/bounded-auth-limiter";

test("auth limiter enforces subject and aggregate ceilings before pruning expired bounded scopes", () => {
  const limiter = createBoundedAuthLimiter({
    purpose: "test",
    windowMs: 100,
    subjectLimit: 2,
    aggregateLimit: 3,
    maxSubjectScopes: 2,
    maxAggregateScopes: 2,
  });

  assert.equal(limiter.allow("one", "source", 0), true);
  assert.equal(limiter.allow("one", "source", 1), true);
  assert.equal(limiter.allow("one", "source", 2), false);
  assert.equal(limiter.allow("two", "source", 3), true);
  assert.equal(limiter.allow("three", "source", 4), false);

  limiter.reset();
  assert.equal(limiter.allow("one", "source-one", 0), true);
  assert.equal(limiter.allow("two", "source-two", 0), true);
  assert.equal(limiter.allow("three", "source-three", 0), true);
  assert.deepEqual(limiter.stats(), { aggregateScopes: 2, subjectScopes: 2 });
  assert.equal(limiter.allow("fresh", "fresh-source", 200), true);
  assert.deepEqual(limiter.stats(), { aggregateScopes: 1, subjectScopes: 1 });
});

test("auth limiter never evicts the active scope when its maps are full", () => {
  const limiter = createBoundedAuthLimiter({
    purpose: "active-scope",
    windowMs: 100,
    subjectLimit: 2,
    aggregateLimit: 10,
    maxSubjectScopes: 2,
    maxAggregateScopes: 2,
  });
  assert.equal(limiter.allow("one", "source-one", 0), true);
  assert.equal(limiter.allow("two", "source-two", 1), true);
  assert.equal(limiter.allow("one", "source-one", 2), true);
  assert.equal(limiter.allow("one", "source-one", 3), false);
});
