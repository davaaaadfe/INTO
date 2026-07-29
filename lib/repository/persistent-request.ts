import {
  flushStoreToPersistence,
  hydrateStoreFromPersistence,
  setLearningPersistenceContext,
} from "./invoice-store";
import { randomUUID } from "node:crypto";
import { sessionCorrelationIdFromRequest } from "../services/into-access-auth";
import { logger } from "../utils/logger";

const runtime = globalThis as typeof globalThis & {
  __INTO_PERSISTENT_REQUEST_TAIL?: Promise<void>;
};

export async function withPersistentStore<T>(
  handler: () => Promise<T> | T,
  request?: Request
): Promise<T | Response> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  let stage = "lock";
  const previous = runtime.__INTO_PERSISTENT_REQUEST_TAIL ?? Promise.resolve();
  let release!: () => void;
  runtime.__INTO_PERSISTENT_REQUEST_TAIL = new Promise<void>((resolve) => {
    release = resolve;
  });
  logger.info("persistent_store.lock_wait_started", { traceId });
  await previous;
  logger.info("persistent_store.lock_acquired", {
    traceId,
    elapsedMs: Date.now() - startedAt,
  });
  const context = {
    requestId:
      request?.headers.get("idempotency-key")?.trim() || randomUUID(),
    sessionCorrelationId: request
      ? sessionCorrelationIdFromRequest(request) || "session_unavailable"
      : "session_unavailable",
  };
  setLearningPersistenceContext(context);
  try {
    stage = "hydrate";
    logger.info("persistent_store.hydration_started", { traceId });
    await hydrateStoreFromPersistence(true);
    logger.info("persistent_store.hydration_completed", {
      traceId,
      elapsedMs: Date.now() - startedAt,
    });
    try {
      stage = "handler";
      return await handler();
    } finally {
      stage = "flush";
      logger.info("persistent_store.flush_started", { traceId });
      await flushStoreToPersistence(context);
      logger.info("persistent_store.flush_completed", {
        traceId,
        elapsedMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const learningStorageIsNotConfigured = message.includes(
      "LEARNING_ARTIFACT_ENCRYPTION_KEY"
    );
    logger.error("persistent_store.request_failed", {
      traceId,
      stage,
      elapsedMs: Date.now() - startedAt,
      message,
    });
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
