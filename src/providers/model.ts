import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

/** A model object of the specification the SDK runs today, as opposed to the gateway string it also accepts. */
export type ModelInstance = Parameters<typeof wrapLanguageModel>[0]["model"];
import { isUnparseable } from "./failure";
import type { Catalog, ModelRef } from "./catalog";

/** An attempt that starts after the one before it failed, and why that one failed. */
export type RetryNotice = { attempt: number; reason: string };

type Fetch = typeof fetch;

/**
 * A `fetch` that reports the provider's retries.
 *
 * The SDK retries on its own and in silence: from outside it is ten seconds of
 * nothing, and the person cannot tell a model thinking from a provider
 * bouncing. Every attempt is a new HTTP request, so this sees them all. A
 * request after one that succeeded is the next step of the turn, so what is
 * counted is consecutive failures, and a success resets the count.
 */
export function fetchWithRetryNotice(notify: (r: RetryNotice) => void, base: Fetch = fetch): Fetch {
  let failures = 0;
  let reason = "";
  const wrapped = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    if (failures > 0) notify({ attempt: failures + 1, reason });
    try {
      const res = await base(input, init);
      if (res.ok) failures = 0;
      else {
        failures++;
        reason = `HTTP ${res.status}`;
      }
      return res;
    } catch (error) {
      failures++;
      reason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  // Bun hangs `preconnect` on the global fetch and the SDKs ask for that whole type; they call the function alone.
  return wrapped as unknown as Fetch;
}

export type RetryUnparseableOptions = {
  /** How many times the call is repeated. Default 2. */
  retries?: number;
  /** Told about each unparseable body, with the attempt number. */
  onRetry?: (info: { modelId: string; attempt: number; message: string; status: number | undefined; body: string }) => void;
  /** Wait between attempts, in ms, by attempt index. Default 1s, 2s, 4s… */
  waitMs?: (attempt: number) => number;
};

/**
 * Repeat a model call whose response body did not parse.
 *
 * The SDK's own retry fires for 408/409/429/5xx, and a body that fails to
 * parse always arrives on a 2xx, so by construction it is never retried and
 * the turn dies on the first occurrence. This wraps the model call, not the
 * turn: repeating the turn would replay every step, tool calls that already
 * acted included. Only the failing call is repeated.
 */
export function retryUnparseable(opts: RetryUnparseableOptions = {}): LanguageModelMiddleware {
  const retries = opts.retries ?? 2;
  const waitMs = opts.waitMs ?? ((attempt: number) => 1000 * 2 ** attempt);
  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, model }) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await doGenerate();
        } catch (err) {
          if (!isUnparseable(err)) throw err;
          lastError = err;
          opts.onRetry?.({
            modelId: model.modelId,
            attempt: attempt + 1,
            message: err.message,
            status: err.statusCode,
            body: String(err.responseBody ?? "").slice(0, 500),
          });
          if (attempt < retries) await new Promise((r) => setTimeout(r, waitMs(attempt)));
        }
      }
      throw lastError;
    },
  };
}

export type ModelOptions = {
  apiKey: string;
  /** The `fetch` the SDK calls with: where retries are seen and a fallback reroutes. */
  fetch?: Fetch;
  /** Middleware around the model call. `retryUnparseable()` is one. */
  middleware?: LanguageModelMiddleware | LanguageModelMiddleware[];
};

/**
 * The model, ready to call, with the key of whoever asks.
 *
 * Throws when the provider is not in the catalog: answering with another
 * would be a model nobody chose, billed somewhere else. The SDK for the
 * protocol is loaded when first needed, so a project installs only the ones
 * its catalog names.
 */
export async function modelFor(catalog: Catalog, ref: ModelRef, opts: ModelOptions): Promise<ModelInstance> {
  const def = catalog[ref.provider];
  if (def === undefined) {
    throw new Error(`provider '${ref.provider}' is not in the catalog; known: ${Object.keys(catalog).sort().join(", ")}`);
  }
  const common = { apiKey: opts.apiKey, baseURL: def.baseURL, fetch: opts.fetch };
  // The SDKs type their models by the specification version they were built against, and `ai`
  // adapts an older one when it resolves the model. The cast says only that this is a model object.
  let model: ModelInstance;
  if (def.protocol === "deepseek") {
    const { createDeepSeek } = await sdk<typeof import("@ai-sdk/deepseek")>("@ai-sdk/deepseek");
    model = createDeepSeek(common)(ref.model) as unknown as ModelInstance;
  } else if (def.protocol === "anthropic") {
    const { createAnthropic } = await sdk<typeof import("@ai-sdk/anthropic")>("@ai-sdk/anthropic");
    model = createAnthropic(common)(ref.model) as unknown as ModelInstance;
  } else {
    const { createOpenAICompatible } = await sdk<typeof import("@ai-sdk/openai-compatible")>("@ai-sdk/openai-compatible");
    if (def.baseURL === undefined) throw new Error(`provider '${ref.provider}' speaks openai and needs a baseURL`);
    model = createOpenAICompatible({ name: ref.provider, baseURL: def.baseURL, apiKey: opts.apiKey, fetch: opts.fetch })(ref.model) as unknown as ModelInstance;
  }
  if (opts.middleware === undefined) return model;
  return wrapLanguageModel({ model, middleware: opts.middleware });
}

async function sdk<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (error) {
    throw new Error(`the catalog names a provider that needs '${name}'; install it: ${(error as Error).message}`);
  }
}
