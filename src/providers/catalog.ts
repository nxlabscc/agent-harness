// The catalog of model providers: who can answer, over which protocol, at
// what price. It is a file, read by the project and handed here as data, so
// adding a provider that speaks the OpenAI protocol is editing JSON, and a
// price change is editing JSON. Keys that start with `_` are comments.

/** The four tiers, smallest first. Asking for one asks for a floor: if none serves, the next up does. */
export const TIERS = ["fast", "balanced", "quality", "reasoning"] as const;
export type Tier = (typeof TIERS)[number];

export const PROTOCOLS = ["deepseek", "anthropic", "openai"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** What is known of a model: what it is for and what it costs, in USD per million tokens. */
export type Model = {
  /** Absent: it is no automatic candidate, but it can be asked for by name. */
  tiers?: Tier[];
  /** It can be shown an image. Per model: a provider has both kinds. */
  vision?: boolean;
  /** It accepts a reasoning effort setting. */
  effort?: boolean;
  /** Tokens of context it accepts. Absent: unknown, and the conservative default applies. */
  context?: number;
  cacheHitInput: number;
  cacheMissInput: number;
  output: number;
};

export type ProviderDef = {
  protocol: Protocol;
  /** Written out even when the SDK has a default, so where a call goes is in the file. */
  baseURL?: string;
  models: Record<string, Model>;
};

export type Catalog = Record<string, ProviderDef>;

/** `provider/model`: the two names a turn is billed and routed by. */
export type ModelRef = { provider: string; model: string };

export const refString = (ref: ModelRef): string => `${ref.provider}/${ref.model}`;

/**
 * `anthropic/claude-sonnet-5` into its two parts. Without a slash, the default
 * provider when there is one; otherwise an error, since a model with no
 * provider cannot be called or billed.
 */
export function parseModelRef(declared: string, defaultProvider?: string): ModelRef {
  const i = declared.indexOf("/");
  if (i > 0) return { provider: declared.slice(0, i), model: declared.slice(i + 1) };
  if (defaultProvider === undefined) throw new Error(`model '${declared}' names no provider and there is no default`);
  return { provider: defaultProvider, model: declared };
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The catalog, checked. What breaks a turn is checked here, with the entry
 * named: a protocol the harness does not speak, a model without its three
 * prices, a tier that does not exist. An entry without a protocol is skipped:
 * the file may hold other things (a voice section, say).
 */
export function loadCatalog(json: unknown): Catalog {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("the provider catalog must be a JSON object keyed by provider");
  }
  const out: Catalog = {};
  for (const [name, value] of Object.entries(json as Record<string, unknown>)) {
    if (name.startsWith("_") || typeof value !== "object" || value === null) continue;
    const def = value as Record<string, unknown>;
    if (def.protocol === undefined) continue;
    if (!(PROTOCOLS as readonly unknown[]).includes(def.protocol)) {
      throw new Error(`provider '${name}' speaks protocol '${String(def.protocol)}'; known: ${PROTOCOLS.join(", ")}`);
    }
    if (def.baseURL !== undefined && typeof def.baseURL !== "string") {
      throw new Error(`provider '${name}' has a baseURL that is not a string`);
    }
    const models: Record<string, Model> = {};
    const rawModels = (def.models ?? {}) as Record<string, unknown>;
    if (typeof rawModels !== "object" || rawModels === null) throw new Error(`provider '${name}' has models that are not an object`);
    for (const [id, m] of Object.entries(rawModels)) {
      if (id.startsWith("_")) continue;
      if (typeof m !== "object" || m === null) throw new Error(`model '${name}/${id}' is not an object`);
      const model = m as Record<string, unknown>;
      for (const price of ["cacheHitInput", "cacheMissInput", "output"] as const) {
        if (!isNumber(model[price]) || (model[price] as number) < 0) {
          throw new Error(`model '${name}/${id}' has no ${price} price`);
        }
      }
      const tiers = model.tiers;
      if (tiers !== undefined) {
        if (!Array.isArray(tiers) || tiers.some((t) => !(TIERS as readonly unknown[]).includes(t))) {
          throw new Error(`model '${name}/${id}' declares a tier that does not exist; known: ${TIERS.join(", ")}`);
        }
      }
      if (model.context !== undefined && (!isNumber(model.context) || model.context <= 0)) {
        throw new Error(`model '${name}/${id}' has a context that is not a positive number`);
      }
      models[id] = {
        ...(tiers !== undefined ? { tiers: tiers as Tier[] } : {}),
        ...(model.vision === true ? { vision: true } : {}),
        ...(model.effort === true ? { effort: true } : {}),
        ...(model.context !== undefined ? { context: model.context as number } : {}),
        cacheHitInput: model.cacheHitInput as number,
        cacheMissInput: model.cacheMissInput as number,
        output: model.output as number,
      };
    }
    out[name] = {
      protocol: def.protocol as Protocol,
      ...(typeof def.baseURL === "string" ? { baseURL: def.baseURL } : {}),
      models,
    };
  }
  return out;
}

/**
 * The same catalog with some base URLs replaced: how a test sends a real
 * provider to a stub without keeping a copy of the file per environment. A
 * provider named here that the catalog lacks is added, speaking OpenAI.
 */
export function withBaseUrls(catalog: Catalog, overrides: Record<string, string>): Catalog {
  const out: Catalog = { ...catalog };
  for (const [name, baseURL] of Object.entries(overrides)) {
    const prev = out[name];
    out[name] = { protocol: prev?.protocol ?? "openai", baseURL, models: prev?.models ?? {} };
  }
  return out;
}

export const modelOf = (catalog: Catalog, ref: ModelRef): Model | undefined => catalog[ref.provider]?.models[ref.model];

/** The three prices added up, as one number to sort by. Unknown: infinite. */
export function priceOf(catalog: Catalog, ref: ModelRef): number {
  const m = modelOf(catalog, ref);
  return m === undefined ? Infinity : m.cacheHitInput + m.cacheMissInput + m.output;
}

/**
 * Tokens of context the model accepts. A model that does not say gets a
 * deliberately small default: falling short trims early and the conversation
 * goes on, overshooting breaks the turn at the provider.
 */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

export function contextWindowOf(catalog: Catalog, ref: ModelRef, fallback = DEFAULT_CONTEXT_WINDOW): number {
  return modelOf(catalog, ref)?.context ?? fallback;
}

export const seesImages = (catalog: Catalog, ref: ModelRef): boolean => modelOf(catalog, ref)?.vision === true;
