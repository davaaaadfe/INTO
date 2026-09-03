import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as cleanupStorage } from "../app/api/storage/cleanup/route";
import { listAuditEvents } from "../lib/repository/invoice-store";
import { proxy } from "../proxy";

test("the secured cleanup route supports Vercel's scheduled GET request", async () => {
  const previousMode = process.env.DATABASE_MODE;
  const previousAuthMode = process.env.AUTH_MODE;
  const previousToken = process.env.INTO_STORAGE_CLEANUP_TOKEN;
  process.env.DATABASE_MODE = "memory";
  process.env.AUTH_MODE = "verified_user";
  process.env.INTO_STORAGE_CLEANUP_TOKEN = "correct-machine-token-that-is-at-least-32-characters";

  try {
    const route = (await import("../app/api/storage/cleanup/route")) as Record<
      string,
      unknown
    >;
    assert.equal(typeof route.GET, "function");
    const response = await (route.GET as (request: Request) => Promise<Response>)(
      new Request("http://localhost/api/storage/cleanup", {
        method: "GET",
        headers: {
          authorization:
            "Bearer correct-machine-token-that-is-at-least-32-characters",
        },
      })
    );

    assert.equal(response.status, 200);
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    if (previousToken === undefined) delete process.env.INTO_STORAGE_CLEANUP_TOKEN;
    else process.env.INTO_STORAGE_CLEANUP_TOKEN = previousToken;
  }
});

test("the API proxy delegates storage cleanup authentication to the machine route", () => {
  const previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "verified_user";

  try {
    const response = proxy(
      new NextRequest("http://localhost/api/storage/cleanup", {
        method: "POST",
        headers: { authorization: "Bearer scheduler-credential" },
      })
    );

    assert.equal(response.headers.get("x-middleware-next"), "1");
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
  }
});

test("storage cleanup is unavailable without a configured machine token", async () => {
  const previousMode = process.env.DATABASE_MODE;
  const previousToken = process.env.INTO_STORAGE_CLEANUP_TOKEN;
  process.env.DATABASE_MODE = "memory";
  delete process.env.INTO_STORAGE_CLEANUP_TOKEN;

  try {
    const response = await cleanupStorage(
      new Request("http://localhost/api/storage/cleanup", { method: "POST" })
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Storage cleanup is not configured.",
    });
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousToken === undefined) delete process.env.INTO_STORAGE_CLEANUP_TOKEN;
    else process.env.INTO_STORAGE_CLEANUP_TOKEN = previousToken;
  }
});

test("storage cleanup rejects missing and incorrect machine credentials", async () => {
  const previousMode = process.env.DATABASE_MODE;
  const previousToken = process.env.INTO_STORAGE_CLEANUP_TOKEN;
  process.env.DATABASE_MODE = "memory";
  process.env.INTO_STORAGE_CLEANUP_TOKEN = "correct-machine-token-that-is-at-least-32-characters";

  try {
    for (const authorization of [undefined, "Bearer incorrect-machine-token"]) {
      const headers = authorization ? { authorization } : undefined;
      const response = await cleanupStorage(
        new Request("http://localhost/api/storage/cleanup", {
          method: "POST",
          headers,
        })
      );

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: "Machine authentication required.",
      });
    }
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousToken === undefined) delete process.env.INTO_STORAGE_CLEANUP_TOKEN;
    else process.env.INTO_STORAGE_CLEANUP_TOKEN = previousToken;
  }
});

test("a valid machine token runs cleanup without a browser session and returns counts only", async () => {
  const previousMode = process.env.DATABASE_MODE;
  const previousAuthMode = process.env.AUTH_MODE;
  const previousToken = process.env.INTO_STORAGE_CLEANUP_TOKEN;
  process.env.DATABASE_MODE = "memory";
  process.env.AUTH_MODE = "verified_user";
  process.env.INTO_STORAGE_CLEANUP_TOKEN = "correct-machine-token-that-is-at-least-32-characters";

  try {
    const response = await cleanupStorage(
      new Request("http://localhost/api/storage/cleanup", {
        method: "POST",
        headers: {
          authorization:
            "Bearer correct-machine-token-that-is-at-least-32-characters",
          "idempotency-key": "cleanup-request-123",
        },
      })
    );
    const payload = (await response.json()) as {
      cleanup?: Record<string, unknown>;
      invoices?: unknown;
    };

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload.cleanup ?? {}).sort(), [
      "checked",
      "deleted",
      "learningArtifactsPruned",
    ]);
    assert.equal("invoices" in payload, false);
    const audit = listAuditEvents().find(
      (event) => event.metadata?.requestId === "cleanup-request-123"
    );
    assert.equal(String(audit?.type), "storage_cleanup_completed");
    assert.equal(audit?.userId, "system_storage_cleanup");
    assert.equal(audit?.userName, "Storage cleanup service");
    assert.equal(audit?.metadata?.sessionCorrelationId, "machine_storage_cleanup");
    assert.equal(typeof audit?.metadata?.checked, "number");
    assert.equal(typeof audit?.metadata?.deleted, "number");
  } finally {
    if (previousMode === undefined) delete process.env.DATABASE_MODE;
    else process.env.DATABASE_MODE = previousMode;
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    if (previousToken === undefined) delete process.env.INTO_STORAGE_CLEANUP_TOKEN;
    else process.env.INTO_STORAGE_CLEANUP_TOKEN = previousToken;
  }
});
