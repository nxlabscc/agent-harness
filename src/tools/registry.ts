import type { ToolSet } from "ai";
import type { Tool, ToolContext, ToolEffect, ToolEntry, ToolMiddleware } from "./types";

export type ToolRegistryOptions<Extra> = {
  /** The catalog: a name to a tool, or a factory that builds one per session. */
  tools: Record<string, ToolEntry<Extra>>;
  /** Granted to every agent, whatever its allowlist (an escalation channel, say). */
  alwaysOn?: string[];
  /** What each tool does to the world. Unlisted is `ro`. */
  effects?: Record<string, ToolEffect>;
  /** Wraps every tool, in order: `guardResultSize`, `traceTool`. */
  middleware?: ToolMiddleware<Extra>[];
  /** Told when an allowlist names a tool the catalog does not have. */
  onUnknown?: (name: string) => void;
};

export type BuildOptions = {
  /**
   * Tools from outside the catalog, added before the allowlist: an MCP server's.
   * A catalog tool of the same name overrides one here.
   */
  extra?: ToolSet;
  /** Effects for the extra tools, so `effectOf` covers them: from a server's `readOnlyHint`. */
  extraEffects?: Record<string, ToolEffect>;
  /** The extra tools skip the allowlist (default true): what a server offers, the agent has. */
  extraBypassesAllowlist?: boolean;
};

export interface ToolRegistry<Extra> {
  /** The tool set for a session: the extra tools, the allowlisted catalog tools, the always-on set, all wrapped. */
  build(allowlist: readonly string[], ctx: ToolContext<Extra>, opts?: BuildOptions): ToolSet;
  /** What a tool does to the world. Unknown is `ro`: safer to miss an action fact than to invent one. */
  effectOf(name: string, extraEffects?: Record<string, ToolEffect>): ToolEffect;
  isMutating(name: string, extraEffects?: Record<string, ToolEffect>): boolean;
  /** The catalog's names, for listing what an agent could be granted. */
  names(): string[];
}

/**
 * The registry: it owns which tools exist, the per-agent allowlist, and the
 * middleware every tool passes through. It implements no tool itself; each one
 * is registered by the project, so a deployment that must not touch the file
 * system simply registers no file tool.
 */
export function createToolRegistry<Extra>(opts: ToolRegistryOptions<Extra>): ToolRegistry<Extra> {
  const { tools, alwaysOn = [], effects = {}, middleware = [], onUnknown } = opts;

  const instantiate = (entry: ToolEntry<Extra>, ctx: ToolContext<Extra>): Tool =>
    typeof entry === "function" ? entry(ctx) : entry;

  return {
    build(allowlist, ctx, build = {}) {
      const bypass = build.extraBypassesAllowlist ?? true;
      const out: Record<string, Tool> = { ...(build.extra ?? {}) };

      const add = (name: string) => {
        const entry = tools[name];
        if (entry === undefined) {
          // An extra tool the allowlist also names is already there; nothing is missing.
          if (!(name in out)) onUnknown?.(name);
          return;
        }
        out[name] = instantiate(entry, ctx);
      };

      // When the extra tools do NOT bypass the allowlist, only the named ones survive.
      if (!bypass) {
        const named = new Set(allowlist);
        for (const name of Object.keys(out)) if (!named.has(name)) delete out[name];
      }
      for (const name of allowlist) add(name);
      for (const name of alwaysOn) if (!(name in out)) add(name);

      for (const name of Object.keys(out)) {
        for (const mw of middleware) out[name] = mw(name, out[name]!, ctx);
      }
      return out;
    },

    effectOf(name, extraEffects = {}) {
      return effects[name] ?? extraEffects[name] ?? "ro";
    },
    isMutating(name, extraEffects = {}) {
      return (effects[name] ?? extraEffects[name] ?? "ro") === "rw";
    },
    names() {
      return Object.keys(tools);
    },
  };
}
