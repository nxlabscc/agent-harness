import type { Tool, ToolContext, ToolMiddleware } from "./types";

/** How much of a spilled result the model sees inline, as a head preview. */
export const PREVIEW_CHARS = 2_000;

export type SpillRequest = {
  sessionId: string;
  toolName: string;
  /** The whole result, serialized as it would reach the model. */
  serialized: string;
};

/** Where a project put a spilled result, and how to tell the model to read it back. */
export type SpillResult = { savedTo: string; hint?: string };

export type GuardOptions = {
  /** The size, in characters, past which a result spills. */
  maxChars: number;
  /**
   * Persist an oversized result and say where it went. Without it, the model
   * gets the preview and the notice, and the rest is dropped. How the project
   * reads the file back is the project's tool.
   */
  spill?: (req: SpillRequest) => SpillResult | null;
  /** Tools whose result is instruction, loaded to act on, so it passes whole: `load_skill`. */
  skip?: (name: string) => boolean;
  previewChars?: number;
};

/** How a result's size is measured: the same string that would reach the model. */
function serialize(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

export function overflowPointer(serialized: string, maxChars: number, spilled: SpillResult | null, previewChars: number): Record<string, unknown> {
  const base = {
    truncated: true,
    reason: `tool result was ${serialized.length} chars (cap ${maxChars})`,
    preview: serialized.slice(0, previewChars),
  };
  if (spilled === null) return base;
  return {
    ...base,
    saved_to: spilled.savedTo,
    hint: spilled.hint ?? "Full result saved to the path above. Read a slice of it rather than running the tool again.",
  };
}

/**
 * A middleware so an oversized result never reaches the model.
 *
 * When the serialized result passes `maxChars`, the model gets a small pointer
 * with a head preview instead; with a `spill` the whole result is persisted
 * first and the pointer says where. A single huge result can otherwise push
 * the transcript past the window and hard-error the turn.
 *
 * This measures a result the tool already built in memory, so it suits tools
 * that return in one piece. A tool that streams writes its own spill as the
 * bytes arrive and hands back a pointer small enough to pass straight through.
 */
export function guardResultSize<Extra>(opts: GuardOptions): ToolMiddleware<Extra> {
  const previewChars = opts.previewChars ?? PREVIEW_CHARS;
  return (name, toolDef, ctx: ToolContext<Extra>): Tool => {
    if (opts.skip?.(name)) return toolDef;
    const original = (toolDef as { execute?: unknown }).execute;
    if (typeof original !== "function") return toolDef;

    const execute = async (input: unknown, options: unknown): Promise<unknown> => {
      const result = await (original as (i: unknown, o: unknown) => Promise<unknown>)(input, options);
      const serialized = serialize(result);
      if (serialized.length <= opts.maxChars) return result;
      const spilled = opts.spill?.({ sessionId: ctx.sessionId, toolName: name, serialized }) ?? null;
      return overflowPointer(serialized, opts.maxChars, spilled, previewChars);
    };

    // A fresh object so a shared tool instance is never mutated.
    return { ...toolDef, execute } as Tool;
  };
}
