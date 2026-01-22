import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const hasTauriInternals =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    "undefined";

export const canUseTauriApis = () => hasTauriInternals;

export type SafeFetchInit = RequestInit & { maxRedirections?: number };

export const safeFetch = (
  input: URL | Request | string,
  init?: SafeFetchInit
): Promise<Response> => {
  if (hasTauriInternals) {
    return tauriFetch(input, init);
  }

  if (typeof fetch === "undefined") {
    return Promise.reject(new Error("Fetch is not available in this environment"));
  }

  if (!init) return fetch(input);
  const { maxRedirections, ...rest } = init;
  void maxRedirections;
  return fetch(input, rest);
};
