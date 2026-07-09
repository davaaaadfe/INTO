import {
  flushStoreToPostgres,
  hydrateStoreFromPostgres,
} from "./invoice-store";

export async function withPersistentStore<T>(handler: () => Promise<T> | T) {
  await hydrateStoreFromPostgres();
  try {
    return await handler();
  } finally {
    await flushStoreToPostgres();
  }
}
