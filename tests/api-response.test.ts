import test from "node:test";
import assert from "node:assert/strict";

test("API response parsing never exposes an empty-body JSON syntax error", async () => {
  const modulePath = "../lib/utils/api-response.ts";
  const apiResponse = (await import(modulePath).catch(() => ({}))) as {
    readApiJson?: <T>(response: Response) => Promise<T>;
  };

  assert.equal(typeof apiResponse.readApiJson, "function");
  const payload = await apiResponse.readApiJson!<{ error?: string }>(
    new Response(null, { status: 500 })
  );

  assert.deepEqual(payload, {});
});

