import {
  flushStoreToPersistence,
  hydrateStoreForPersistentRequest,
  setLearningPersistenceContext,
} from "./invoice-store";
import { randomUUID } from "node:crypto";
import { withVerifiedPersistentRequest, type RequestPrincipal } from "../services/verified-session-auth";
import { logger } from "../utils/logger";

const runtime = globalThis as typeof globalThis & {
  __INTO_PERSISTENT_REQUEST_TAIL?: Promise<void>;
};

export async function withPersistentStore<T>(
  handler: (principal: RequestPrincipal) => Promise<T> | T,
  request: Request,
  principal?: RequestPrincipal
): Promise<T | Response> {
  if (!principal) {
    return withVerifiedPersistentRequest(request, (resolved) =>
      withPersistentStore(handler, request, resolved)
    );
  }
  return runPersistent(() => handler(principal), {
    requestId: principal.requestId,
    sessionCorrelationId: principal.sessionCorrelationId,
  });
}

/** Test-only persistence seam for repository behavior that is not an HTTP request. */
export async function withPersistentStoreForTest<T>(handler: () => Promise<T> | T) {
  return runPersistent(handler, {
    requestId: randomUUID(),
    sessionCorrelationId: "test_session",
  });
}

export async function withPublicPersistentStore<T>(
  handler: () => Promise<T> | T,
  request: Request
): Promise<T | Response> {
  return runPersistent(handler, {
    requestId: request.headers.get("idempotency-key")?.trim() || randomUUID(),
    sessionCorrelationId: "oauth_callback",
  });
}

async function runPersistent<T>(
  handler: () => Promise<T> | T,
  context: { requestId: string; sessionCorrelationId: string }
): Promise<T | Response> {
  const previous = runtime.__INTO_PERSISTENT_REQUEST_TAIL ?? Promise.resolve();
  let release!: () => void;
  runtime.__INTO_PERSISTENT_REQUEST_TAIL = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  setLearningPersistenceContext(context);
  try {
    await hydrateStoreForPersistentRequest();
    try {
      return await handler();
    } finally {
      await flushStoreToPersistence(context);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const learningStorageIsNotConfigured = message.includes(
      "LEARNING_ARTIFACT_ENCRYPTION_KEY"
    );
    logger.error("persistent_store.request_failed", { message });
    return Response.json(
      {
        error: learningStorageIsNotConfigured
          ? "Supplier learning storage is not configured. Add LEARNING_ARTIFACT_ENCRYPTION_KEY and redeploy."
          : "INTO could not complete the request. Please try again.",
      },
      { status: learningStorageIsNotConfigured ? 503 : 500 }
    );
  } finally {
    setLearningPersistenceContext(undefined);
    release();
  }
}
