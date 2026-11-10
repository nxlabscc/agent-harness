import { parseFrontmatter, stringList, stringOrNull, type Frontmatter } from "./frontmatter";
import type { AgentDefinition } from "./types";

/**
 * The agent's prompt: the parts every agent shares, a rule, and then what is
 * this agent's. Empty parts are skipped. Blocks a context strategy adds at open
 * follow the body the same way.
 */
export function composePrompt(parts: { base?: readonly string[]; body: string; blocks?: readonly string[] }): string {
  const base = (parts.base ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  const body = parts.body.trim();
  const head = base.length > 0 ? `${base.join("\n\n")}\n\n---\n\n${body}` : body;
  const blocks = (parts.blocks ?? []).map((b) => b.trim()).filter((b) => b.length > 0);
  return blocks.length > 0 ? `${head}\n\n${blocks.join("\n\n")}` : head;
}

export type DefineAgentInput = {
  id: string;
  /** The agent file: frontmatter and body. */
  raw: string;
  /** The parts every agent's prompt starts with. */
  base?: readonly string[];
  home?: string | null;
};

/**
 * An `AGENT.md` read into a definition.
 *
 * The frontmatter keys the harness reads: `name`, `description`, `model`,
 * `tier`, `tools`, `skills`, `shell_allowlist`. The whole frontmatter is kept
 * for the project. The body becomes the agent's part of the prompt.
 *
 * `model` is taken as written and never checked against a list: models appear
 * and are renamed all the time, and whoever knows which exist is the provider.
 * A model that does not exist fails on the first call, with its message,
 * rather than falling silently to one nobody asked for.
 */
export function defineAgent(input: DefineAgentInput): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter(input.raw);
  return fromFrontmatter({ id: input.id, frontmatter, body, base: input.base, home: input.home });
}

/** The same, from a frontmatter and body a project already has apart (a table row, say). */
export function fromFrontmatter(input: {
  id: string;
  frontmatter: Frontmatter;
  body: string;
  base?: readonly string[];
  home?: string | null;
}): AgentDefinition {
  const fm = input.frontmatter;
  return {
    id: input.id,
    name: stringOrNull(fm.name) ?? input.id,
    description: stringOrNull(fm.description),
    model: stringOrNull(fm.model),
    tier: stringOrNull(fm.tier),
    tools: stringList(fm.tools),
    skills: stringList(fm.skills),
    shellAllowlist: stringList(fm.shell_allowlist),
    systemPrompt: composePrompt({ base: input.base, body: input.body }),
    home: input.home ?? null,
    frontmatter: fm,
  };
}
