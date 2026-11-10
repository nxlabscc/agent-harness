import { tool } from "ai";
import { z } from "zod";
import { parseFrontmatter, stringList, stringOrNull } from "../agents/frontmatter";
import type { AgentDefinition } from "../agents/types";
import type { Tool, ToolContext } from "./types";

// A skill is a named bundle an agent loads to act on, plus the grants it needs
// to do so. The registry owns two things about skills: the rule that a declared
// skill's tools and shell patterns are added to the agent's allowlist, and the
// `<skills>` index that rides in the system prompt. Where a skill's body comes
// from — a file, a blob in a database — is a loader the project provides.

export type SkillSpec = {
  name: string;
  /** The frontmatter's `description`: what the skill is for and when to load it. */
  description: string | null;
  /** Tools the skill needs; added to the agent's allowlist when it declares the skill. */
  tools: string[];
  /** Shell patterns the skill needs, for a project whose shell tool reads them. */
  shellPatterns: string[];
};

/** Where a skill's spec and body come from. The harness asks by name. */
export interface SkillSource {
  spec(name: string): Promise<SkillSpec | null>;
  body(name: string): Promise<string | null>;
}

/** A skill's spec from its file's frontmatter: `description`, `tools`, `shell_patterns`. */
export function skillSpecFrom(name: string, raw: string): SkillSpec {
  const { frontmatter } = parseFrontmatter(raw);
  return {
    name,
    description: stringOrNull(frontmatter.description),
    tools: stringList(frontmatter.tools),
    shellPatterns: stringList(frontmatter.shell_patterns),
  };
}

export type Grants = {
  /** The agent's tools, plus each declared skill's. */
  tools: string[];
  /** The agent's shell patterns, plus each declared skill's. */
  shellPatterns: string[];
  /** The specs of the skills that resolved, for the `<skills>` block. */
  skills: SkillSpec[];
};

/**
 * What an agent may use, its declared skills folded in.
 *
 * Declaring a skill in the persona approves the surface the skill needs: the
 * rule is access control, and it is the harness's. A skill that does not
 * resolve is skipped.
 */
export async function grantsFor(agent: AgentDefinition, source: SkillSource): Promise<Grants> {
  const tools = new Set(agent.tools);
  const shellPatterns = new Set(agent.shellAllowlist);
  const skills: SkillSpec[] = [];
  for (const name of agent.skills) {
    const spec = await source.spec(name);
    if (spec === null) continue;
    skills.push(spec);
    for (const t of spec.tools) tools.add(t);
    for (const p of spec.shellPatterns) shellPatterns.add(p);
  }
  return { tools: [...tools], shellPatterns: [...shellPatterns], skills };
}

/**
 * The agent's skill index for its system prompt: each skill as its name and
 * description, inside a tag, so the agent knows what it can load and when.
 */
export function skillsBlock(skills: readonly SkillSpec[]): string {
  if (skills.length === 0) return "";
  const items = skills.map((s) => `<skill>\nname: ${s.name}\ndescription: ${s.description ?? ""}\n</skill>`);
  return `<skills>\n${items.join("\n")}\n</skills>`;
}

/**
 * The tool that loads a skill's body whole. It is instruction, not data, so the
 * result guard's `skip` should name it: its size is the skill author's.
 */
export function loadSkillTool<Extra>(source: SkillSource): (ctx: ToolContext<Extra>) => Tool {
  return () =>
    tool({
      description: "Load a skill by name, whole, into the conversation. Pass just the name, not a path.",
      inputSchema: z.object({ name: z.string().describe("the skill's name, e.g. 'summary'") }),
      execute: async ({ name }) => {
        const cleaned = name
          .replace(/^\.?\/?(?:\.claude\/)?skills\//, "")
          .replace(/\.md$/i, "")
          .replace(/\/SKILL$/i, "")
          .toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/.test(cleaned)) throw new Error(`invalid skill name: ${name} (read as '${cleaned}')`);
        const body = await source.body(cleaned);
        if (body === null) throw new Error(`skill not found: ${cleaned}`);
        return { name: cleaned, body };
      },
    });
}
