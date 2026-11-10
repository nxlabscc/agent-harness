import { expect, test } from "bun:test";
import { composePrompt, defineAgent } from "./definition";

const RAW = `---
name: ada
description: "A careful worker."
type: worker
model: deepseek/deepseek-v4-flash
tools:
  - read_file
  - write_file
skills: [alpha, beta]
shell_allowlist:
  - "python3 skills/alpha/*"
---

# Ada

Plans, tests, documents, adjusts.
`;

test("an AGENT.md becomes a definition with its grants and its composed prompt", () => {
  const agent = defineAgent({ id: "ada", raw: RAW, base: ["# Base\n\nShared context.\n"], home: "agents/ada/" });
  expect(agent).toMatchObject({
    id: "ada",
    name: "ada",
    description: "A careful worker.",
    model: "deepseek/deepseek-v4-flash",
    tier: null,
    tools: ["read_file", "write_file"],
    skills: ["alpha", "beta"],
    shellAllowlist: ["python3 skills/alpha/*"],
    home: "agents/ada/",
  });
  expect(agent.frontmatter.type).toBe("worker");
  expect(agent.systemPrompt).toBe("# Base\n\nShared context.\n\n---\n\n# Ada\n\nPlans, tests, documents, adjusts.");
});

test("an agent without a name is named by its id, and without a model asks for a tier", () => {
  const agent = defineAgent({ id: "assistant", raw: "---\ntier: balanced\n---\nServe.\n" });
  expect(agent.name).toBe("assistant");
  expect(agent.model).toBeNull();
  expect(agent.tier).toBe("balanced");
  expect(agent.tools).toEqual([]);
  expect(agent.systemPrompt).toBe("Serve.");
});

test("composePrompt skips empty parts and appends blocks after the body", () => {
  expect(composePrompt({ base: ["", "  "], body: "body" })).toBe("body");
  expect(composePrompt({ base: ["a", "b"], body: "body", blocks: ["", "<state>x</state>"] })).toBe(
    "a\n\nb\n\n---\n\nbody\n\n<state>x</state>",
  );
});
