import {
  flushStoreToPersistence,
  hydrateStoreFromPersistence,
} from "./invoice-store";

export async function withPersistentStore<T>(handler: () => Promise<T> | T) {
  await hydrateStoreFromPersistence();
  try {
    return await handler();
  } finally {
    await flushStoreToPersistence();
  }
}
