import type { ToolSet } from "ai";
import type { Scope } from "@nxlabscc/agent-context";
import type { AgentDefinition } from "../agents/types";

export type { Scope };

/** A tool as the `ai` SDK describes it: a description, an input schema, an execute. */
export type Tool = ToolSet[string];

/** What a tool is built with: the session it runs in, and whatever else the project threads through. */
export type ToolContext<Extra = unknown> = { scope: Scope; sessionId: string; agent: AgentDefinition } & Extra;

/** A tool, or a function that builds one for a session. */
export type ToolEntry<Extra = unknown> = Tool | ((ctx: ToolContext<Extra>) => Tool);

/** A function that builds a tool for a session. */
export type ToolFactory<Extra = unknown> = (ctx: ToolContext<Extra>) => Tool;

/** Wraps every tool in the set: the result guard, a trace span. */
export type ToolMiddleware<Extra = unknown> = (name: string, tool: Tool, ctx: ToolContext<Extra>) => Tool;

/** What a tool does to the world: `ro` observes, `rw` changes. The memory reads this to know if an action leaves a fact. */
export type ToolEffect = "ro" | "rw";
