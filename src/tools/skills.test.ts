import { expect, test } from "bun:test";
import type { AgentDefinition } from "../agents/types";
import { grantsFor, loadSkillTool, skillSpecFrom, skillsBlock, type SkillSource, type SkillSpec } from "./skills";
import type { ToolContext } from "./types";

const agent = (over: Partial<AgentDefinition>): AgentDefinition => ({
  id: "ada", name: "b", description: null, model: null, tier: null,
  tools: ["read_file"], skills: [], shellAllowlist: ["ls*"], systemPrompt: "", home: null, frontmatter: {}, ...over,
});

const FILES: Record<string, string> = {
  alpha: "---\nname: alpha\ndescription: Summarize the inputs.\ntools:\n  - execute_shell\nshell_patterns:\n  - \"python3 skills/alpha/*\"\n---\n\n# Alpha\nbody\n",
  "beta": "---\nname: beta\ntools: [http_get, http_put]\n---\n# no description\n",
};

const source: SkillSource = {
  async spec(name) {
    return FILES[name] ? skillSpecFrom(name, FILES[name]!) : null;
  },
  async body(name) {
    return FILES[name] ?? null;
  },
};

test("a skill's spec comes from its frontmatter", () => {
  const spec = skillSpecFrom("alpha", FILES.alpha!);
  expect(spec).toEqual({ name: "alpha", description: "Summarize the inputs.", tools: ["execute_shell"], shellPatterns: ["python3 skills/alpha/*"] });
  expect(skillSpecFrom("beta", FILES["beta"]!).description).toBeNull();
});

test("declared skills fold their tools and shell patterns into the agent's grants", async () => {
  const grants = await grantsFor(agent({ skills: ["alpha", "beta", "missing"] }), source);
  expect(grants.tools.sort()).toEqual(["execute_shell", "http_get", "http_put", "read_file"]);
  expect(grants.shellPatterns.sort()).toEqual(["ls*", "python3 skills/alpha/*"]);
  expect(grants.skills.map((s) => s.name)).toEqual(["alpha", "beta"]); // missing is skipped
});

test("the skills block is each resolved skill's name and description, inside a tag", () => {
  const specs: SkillSpec[] = [
    { name: "alpha", description: "Summarize the inputs.", tools: [], shellPatterns: [] },
    { name: "beta", description: null, tools: [], shellPatterns: [] },
  ];
  expect(skillsBlock(specs)).toBe(
    "<skills>\n<skill>\nname: alpha\ndescription: Summarize the inputs.\n</skill>\n<skill>\nname: beta\ndescription: \n</skill>\n</skills>",
  );
  expect(skillsBlock([])).toBe("");
});

test("load_skill returns the body whole, and cleans a path-ish name", async () => {
  const ctx: ToolContext = { scope: { tenantId: "t" }, sessionId: "s", agent: agent({}) };
  const t = loadSkillTool(source)(ctx);
  const exec = (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  expect(await exec({ name: ".claude/skills/alpha/SKILL.md" }, {})).toEqual({ name: "alpha", body: FILES.alpha });
  await expect(exec({ name: "no-such-skill" }, {})).rejects.toThrow("skill not found");
  await expect(exec({ name: "../etc" }, {})).rejects.toThrow("invalid skill name");
});
