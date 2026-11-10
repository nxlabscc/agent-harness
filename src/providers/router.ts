import { TIERS, parseModelRef, priceOf, refString, type Catalog, type ModelRef, type Tier } from "./catalog";

// With which model a request is answered. Two halves, kept apart because they
// have different lifetimes: what a person can use (their credentials, once per
// session) and which of those answers this request (a policy, every turn).
// The router knows requests and candidates; it knows no tokens, tenants or
// keys beyond the `apiKey` a candidate carries.

/** A provider someone can use, and with which key. */
export type Credential = {
  provider: string;
  apiKey: string;
  /** The key is the system's, not the person's: only models that cost nothing may run on it. */
  system: boolean;
};

export const CAPABILITIES = ["vision"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** A model that can run, with what it takes to compare it. */
export type Candidate = ModelRef & {
  apiKey: string;
  /** False when it runs on the system's key. */
  own: boolean;
  tiers: Tier[];
  /** The three prices added, to sort by. */
  price: number;
  capabilities: Capability[];
};

export type Available = {
  /** What answers: the person's own if they loaded any key, the free ones if not. */
  candidates: Candidate[];
  /** The system's branch, apart: where a named model whose provider the person lacks falls. */
  free: Candidate[];
  credentials: Credential[];
};

/**
 * What can run, given a catalog and credentials. Pure.
 *
 * With a key of their own, the free models are out of the candidates: "the
 * cheapest that serves" would always pick what costs zero, and nobody would
 * use their own key.
 */
export function available(catalog: Catalog, credentials: Credential[]): Available {
  const runnable = (c: Credential): Candidate[] =>
    Object.entries(catalog[c.provider]?.models ?? {})
      .map(([model, m]) => ({
        provider: c.provider,
        model,
        apiKey: c.apiKey,
        own: !c.system,
        tiers: m.tiers ?? [],
        price: m.cacheHitInput + m.cacheMissInput + m.output,
        capabilities: CAPABILITIES.filter((cap) => m[cap] === true),
      }))
      // On the system's key, only what costs nothing: a paid call on it is paid by the system.
      .filter((cand) => !c.system || cand.price === 0);

  const own = credentials.filter((c) => !c.system).flatMap(runnable);
  const free = credentials.filter((c) => c.system).flatMap(runnable);
  return { candidates: own.length > 0 ? own : free, free, credentials };
}

/** What a policy needs to know of the request. */
export type RouteRequest = {
  /** The agent's `model:`, as written, or null. */
  model: string | null;
  /** The agent's `tier:`, or null for the default. */
  tier: Tier | null;
  /**
   * Models the person chose per tier, as `provider/model`. A set, not an order:
   * it narrows the candidates the usual rule runs over. An absent tier is all.
   */
  elected?: Partial<Record<Tier, string[]>>;
  /** The new message and what came with it, for a policy that reads them. */
  message?: string;
  attachments?: { mime: string }[];
  /** What this session has been answered with, for a policy that avoids switching. */
  history?: { last: ModelRef | null; trimmed: boolean };
};

export type Decision = {
  candidate: Candidate;
  /** Why: the policy's own account, for telemetry. */
  trace: { policy: string } & Record<string, unknown>;
};

export interface Router {
  readonly name: string;
  /** Null when nothing can answer: the caller stops before creating anything. */
  choose(request: RouteRequest, available: Available, catalog: Catalog): Decision | null;
}

/**
 * Only the candidates the person chose for that tier.
 *
 * A set, not an order: the usual rule still applies inside it. With nothing
 * chosen, or nothing chosen available (a key removed, a catalog changed),
 * everything is back: the preference survives the key, and applying it
 * without a check would leave the person with nothing to answer with.
 */
export function onlyElected(candidates: Candidate[], elected: string[] | undefined): Candidate[] {
  if (elected === undefined || elected.length === 0) return candidates;
  const narrowed = candidates.filter((c) => elected.includes(refString(c)));
  return narrowed.length > 0 ? narrowed : candidates;
}

const cheapest = (candidates: Candidate[]): Candidate | null =>
  [...candidates].sort((a, b) => a.price - b.price)[0] ?? null;

export type ByTierOptions = {
  /** The provider a bare model name belongs to. */
  defaultProvider?: string;
  /** The tier an agent that declares none asks for. Default `balanced`. */
  defaultTier?: Tier;
};

/**
 * The policy where the agent declares the tier.
 *
 * An explicit `model:` wins: someone chose it on purpose. It runs on the
 * person's key for that provider; without one it falls to the free branch,
 * never to another paid model of theirs. A tier is a floor: the cheapest that
 * reaches it, climbing when none does, never descending. With nothing
 * classified, the cheapest of whatever there is.
 */
export function byTier(opts: ByTierOptions = {}): Router {
  const defaultTier = opts.defaultTier ?? "balanced";
  return {
    name: "byTier",
    choose(request, d, catalog) {
      if (request.model !== null) {
        const named = parseModelRef(request.model, opts.defaultProvider);
        const credential = d.credentials.find((c) => c.provider === named.provider && !c.system);
        const trace = { policy: "byTier", reason: "named-model", tier: null };
        if (credential !== undefined) {
          const candidate: Candidate = {
            ...named,
            apiKey: credential.apiKey,
            own: true,
            tiers: [],
            price: priceOf(catalog, named),
            capabilities: [],
          };
          return { candidate, trace };
        }
        const free = cheapest(d.free);
        return free === null ? null : { candidate: free, trace };
      }

      const tier = request.tier ?? defaultTier;
      for (const step of TIERS.slice(Math.max(0, TIERS.indexOf(tier)))) {
        const chosen = cheapest(onlyElected(d.candidates.filter((c) => c.tiers.includes(step)), request.elected?.[step]));
        if (chosen !== null) return { candidate: chosen, trace: { policy: "byTier", reason: "tier", tier: step } };
      }
      const any = cheapest(d.candidates);
      return any === null ? null : { candidate: any, trace: { policy: "byTier", reason: "no-tier", tier } };
    },
  };
}

/**
 * What answers background work: extraction, summaries, titles. `fast` of the
 * same tree as the chat, climbing if there is none. It does not go through the
 * active policy: a summary is nobody's request, with no complexity to measure
 * and no conversation to cache.
 */
export function sideModel(d: Available, catalog: Catalog, elected?: RouteRequest["elected"]): Candidate | null {
  return byTier().choose({ model: null, tier: "fast", elected }, d, catalog)?.candidate ?? null;
}
