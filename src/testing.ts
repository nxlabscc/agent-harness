// Test doubles: a stub language model that needs no network and no key, and a
// couple of static sources. The stub reads the last user message for a
// directive, so a test drives a whole turn
// without a provider.
//
//   TOOLCALL <tool> <json>   emit one call to <tool> with <json> as its input
//   ERROR <status>           fail as the provider would with that HTTP status
//   REASON                   reply with reasoning only, no text and no call (a cut reply)
//   anything else            answer with the text, prefixed `echo: `
//
// After a tool result comes back, the next step answers with text, so a
// TOOLCALL turn runs two steps and ends on text.

import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { AgentDefinition, AgentSource } from "./agents/types";
import type { SkillSource, SkillSpec } from "./tools/skills";
import { skillSpecFrom } from "./tools/skills";

type Prompt = { role: string; content: unknown }[];

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p) => (p as { text?: string }).text ?? "").join("");
  }
  return "";
}

const lastIsToolResult = (prompt: Prompt): boolean => prompt[prompt.length - 1]?.role === "tool";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };
type Content = ContentPart[];

function decide(prompt: Prompt): { content: Content; finishReason: "stop" | "tool-calls" } | { error: number } {
  if (lastIsToolResult(prompt)) return { content: [{ type: "text", text: "done" }], finishReason: "stop" };
  const text = lastUserText(prompt).trim();
  const tool = text.match(/^TOOLCALL\s+(\S+)\s+(.*)$/s);
  if (tool) return { content: [{ type: "tool-call", toolCallId: `call-${tool[1]}`, toolName: tool[1]!, input: tool[2]! }], finishReason: "tool-calls" };
  const err = text.match(/^ERROR\s+(\d+)/);
  if (err) return { error: Number(err[1]) };
  if (text === "REASON") return { content: [{ type: "reasoning", text: "thinking, but never acting" }], finishReason: "stop" };
  return { content: [{ type: "text", text: `echo: ${text}` }], finishReason: "stop" };
}

// The raw V3 provider usage shape, which generateText flattens into its public one.
const usage = (prompt: Prompt) => {
  const n = Math.ceil(JSON.stringify(prompt).length / 4);
  return {
    inputTokens: { total: n, noCache: n, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 4, text: 4, reasoning: undefined },
    raw: { totalTokens: n + 4 },
  };
};

// The raw V3 finishReason shape: a unified value and the provider's own.
const finish = (reason: string) => ({ unified: reason, raw: reason });

function fail(status: number): never {
  throw new APICallError({ message: `stub error ${status}`, url: "http://stub", requestBodyValues: {}, statusCode: status });
}

type Ctor = ConstructorParameters<typeof MockLanguageModelV3>[0];

/** A language model that answers from the last user message's directive. */
export function stubModel(modelId = "stub"): MockLanguageModelV3 {
  const args: Ctor = {
    modelId,
    doGenerate: async ({ prompt }: { prompt: unknown }) => {
      const d = decide(prompt as Prompt);
      if ("error" in d) fail(d.error);
      return { content: d.content, finishReason: finish(d.finishReason), usage: usage(prompt as Prompt), warnings: [] };
    },
    doStream: async ({ prompt }: { prompt: unknown }) => {
      const d = decide(prompt as Prompt);
      if ("error" in d) fail(d.error);
      const parts: Record<string, unknown>[] = [{ type: "stream-start", warnings: [] }];
      for (const c of d.content) {
        if (c.type === "text") {
          const id = "t0";
          parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: c.text }, { type: "text-end", id });
        } else if (c.type === "reasoning") {
          const id = "r0";
          parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: c.text }, { type: "reasoning-end", id });
        } else {
          parts.push({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, input: c.input });
        }
      }
      parts.push({ type: "finish", finishReason: finish(d.finishReason), usage: usage(prompt as Prompt) });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  } as unknown as Ctor;
  return new MockLanguageModelV3(args);
}

/** An `AgentSource` over a fixed map of definitions. */
export function staticAgentSource(agents: Record<string, AgentDefinition>): AgentSource {
  return { async load(id) { return agents[id] ?? null; } };
}

/** A minimal agent definition for tests. */
export function testAgent(over: Partial<AgentDefinition> & { id: string }): AgentDefinition {
  return {
    name: over.id, description: null, model: null, tier: null,
    tools: [], skills: [], shellAllowlist: [], systemPrompt: `You are ${over.id}.`, home: null, frontmatter: {},
    ...over,
  };
}

/** A `SkillSource` over a map of raw skill files. */
export function staticSkillSource(files: Record<string, string>): SkillSource {
  return {
    async spec(name): Promise<SkillSpec | null> {
      return files[name] ? skillSpecFrom(name, files[name]!) : null;
    },
    async body(name) {
      return files[name] ?? null;
    },
  };
}
