import type { Scope } from "@nxlabscc/agent-context";

/** An agent ready to run: its prompt composed, its grants read. */
export type AgentDefinition = {
  /** What a session names it by. */
  id: string;
  /** What it is called. */
  name: string;
  description: string | null;
  /** `provider/model`, or null: then the tier decides, and whoever routes knows the keys. */
  model: string | null;
  tier: string | null;
  /** The tools it may use, by name. Skills add theirs through the registry. */
  tools: string[];
  /** The skills it declares. */
  skills: string[];
  /** Shell patterns it may run, for a project whose shell tool reads them. */
  shellAllowlist: string[];
  /** The prompt as composed: the base parts, a rule, the body. */
  systemPrompt: string;
  /** The directory the agent lives in, when it has one. */
  home: string | null;
  /** Everything the frontmatter declared, for the project: a type, a disposition, an icon. */
  frontmatter: Record<string, unknown>;
};

/**
 * Where agents come from. One project reads a roster and files, another a
 * table; the harness asks for an id within a scope and gets a definition or
 * null, the same null for "does not exist" and "belongs to someone else".
 */
export interface AgentSource {
  load(id: string, scope: Scope): Promise<AgentDefinition | null>;
}
