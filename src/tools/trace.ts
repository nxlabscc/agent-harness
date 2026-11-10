import type { Tool, ToolContext, ToolMiddleware } from "./types";

/** Runs `fn` inside a span named for the tool. A no-op tracer just calls `fn`. */
export type ToolTracer = (name: string, attributes: Record<string, string | number | boolean>, fn: () => Promise<unknown>) => Promise<unknown>;

/**
 * A middleware that runs every tool's execute inside a span.
 *
 * The tracer is the project's: an app passes its OTLP span opener, a deployment
 * with no telemetry passes one that just calls through. The span carries the
 * tool's name and the session, so a slow turn says which tool it was.
 */
export function traceTool<Extra>(tracer: ToolTracer): ToolMiddleware<Extra> {
  return (name, toolDef, ctx: ToolContext<Extra>): Tool => {
    const original = (toolDef as { execute?: unknown }).execute;
    if (typeof original !== "function") return toolDef;
    const execute = (input: unknown, options: unknown): Promise<unknown> =>
      tracer(`execute_tool ${name}`, { tool: name, session_id: ctx.sessionId, tenant_id: ctx.scope.tenantId }, () =>
        (original as (i: unknown, o: unknown) => Promise<unknown>)(input, options),
      );
    return { ...toolDef, execute } as Tool;
  };
}
