import {
  flushStoreToPersistence,
  hydrateStoreFromPersistence,
  setLearningPersistenceContext,
} from "./invoice-store";
import { randomUUID } from "node:crypto";
import { sessionCorrelationIdFromRequest } from "../services/into-access-auth";

const runtime = globalThis as typeof globalThis & {
  __INTO_PERSISTENT_REQUEST_TAIL?: Promise<void>;
};

export async function withPersistentStore<T>(
  handler: () => Promise<T> | T,
  request?: Request
) {
  const previous = runtime.__INTO_PERSISTENT_REQUEST_TAIL ?? Promise.resolve();
  let release!: () => void;
  runtime.__INTO_PERSISTENT_REQUEST_TAIL = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const context = {
    requestId:
      request?.headers.get("idempotency-key")?.trim() || randomUUID(),
    sessionCorrelationId: request
      ? sessionCorrelationIdFromRequest(request) || "session_unavailable"
      : "session_unavailable",
  };
  setLearningPersistenceContext(context);
  try {
    await hydrateStoreFromPersistence(true);
    return await handler();
  } finally {
    try {
      await flushStoreToPersistence(context);
    } finally {
      setLearningPersistenceContext(undefined);
      release();
    }
  }
}
