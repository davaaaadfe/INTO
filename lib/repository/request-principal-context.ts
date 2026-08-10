import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestPrincipal } from "../services/verified-session-auth";

const requestPrincipalStorage = new AsyncLocalStorage<RequestPrincipal>();

export function withRequestPrincipalContext<T>(
  principal: RequestPrincipal,
  handler: () => Promise<T> | T
) {
  return requestPrincipalStorage.run(principal, handler);
}

export function currentRequestPrincipal() {
  return requestPrincipalStorage.getStore();
}
