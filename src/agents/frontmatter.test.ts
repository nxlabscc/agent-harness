import { expect, test } from "bun:test";
import { parseFrontmatter, parseYamlSubset, splitFrontmatter } from "./frontmatter";

test("a file splits into frontmatter and body, and a file without one is all body", () => {
  expect(splitFrontmatter("---\nname: a\n---\n\n# Title\nbody\n")).toEqual({ frontmatter: "name: a", body: "\n# Title\nbody\n" });
  expect(splitFrontmatter("---\r\nname: a\r\n---\r\nbody")).toEqual({ frontmatter: "name: a", body: "body" });
  expect(splitFrontmatter("# just a body\n")).toEqual({ frontmatter: "", body: "# just a body\n" });
  expect(splitFrontmatter("---\nname: a\nno close")).toEqual({ frontmatter: "", body: "---\nname: a\nno close" });
});

test("the two ways of writing a list give the same thing", () => {
  const block = parseYamlSubset("tools:\n  # a comment\n  - search_memory\n  - remember\n");
  const inline = parseYamlSubset("tools: [search_memory, remember]\n");
  expect(block.tools).toEqual(["search_memory", "remember"]);
  expect(block.tools).toEqual(inline.tools);
  expect(parseYamlSubset("tools: []\n").tools).toEqual([]);
});

test("scalars come out typed, quotes come off, comments go", () => {
  const fm = parseYamlSubset(
    [
      'name: "Ada Lovelace"',
      "temperature: 0.3   # low",
      "steps: 100",
      "enabled: true",
      "model: null",
      "description: 'Note, #1 item'",
      "url: http://x#y",
    ].join("\n"),
  );
  expect(fm).toEqual({
    name: "Ada Lovelace",
    temperature: 0.3,
    steps: 100,
    enabled: true,
    model: null,
    description: "Note, #1 item",
    url: "http://x#y",
  });
});

test("a nested map is kept as an object, lists inside it included", () => {
  const fm = parseYamlSubset(
    [
      "permission:",
      "  edit: allow",
      "  bash:",
      '    "git pull*": allow',
      "    rm*: deny",
      "tools:",
      "  - read_file",
    ].join("\n"),
  );
  expect(fm.permission).toEqual({ edit: "allow", bash: {} });
  expect(fm.tools).toEqual(["read_file"]);
});

test("a key with nothing on its line and nothing below is left out", () => {
  expect(parseYamlSubset("model:\ntier: fast\n")).toEqual({ tier: "fast" });
});

test("parseFrontmatter returns the parsed frontmatter and the body as written", () => {
  const { frontmatter, body } = parseFrontmatter("---\nname: assistant\ntier: balanced\n---\n## Mission\n\nServe.\n");
  expect(frontmatter).toEqual({ name: "assistant", tier: "balanced" });
  expect(body).toBe("## Mission\n\nServe.\n");
});
