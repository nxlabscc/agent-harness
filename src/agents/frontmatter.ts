// The frontmatter of an agent or skill file: the YAML subset those files use.
//
//   key: scalar                 string, number, true/false, null
//   key: [a, b, c]              inline list
//   key:                        block list
//     - a
//     - b
//   key:                        nested map, kept as an object
//     sub: value
//
// Comments start with `#` at the start of a line or after a space. Both ways of
// writing a list give the same result: whoever writes an agent uses the one
// that comes out, and a form the parser missed used to leave the key empty and
// the agent without tools, silently.

export type Frontmatter = Record<string, unknown>;

export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { frontmatter: "", body: raw };
  const after = raw.slice(raw.indexOf("\n") + 1);
  const close = after.match(/(^|\r?\n)---[ \t]*(\r?\n|$)/);
  if (close === null || close.index === undefined) return { frontmatter: "", body: raw };
  const frontmatter = after.slice(0, close.index);
  const body = after.slice(close.index + close[0].length);
  return { frontmatter, body };
}

/** The file split in two, the frontmatter parsed and the body as written. */
export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const { frontmatter, body } = splitFrontmatter(raw);
  return { frontmatter: parseYamlSubset(frontmatter), body };
}

type Line = { indent: number; text: string };

function lines(src: string): Line[] {
  const out: Line[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const text = stripComment(raw);
    if (text.trim() === "") continue;
    out.push({ indent: text.length - text.trimStart().length, text: text.trim() });
  }
  return out;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

export function parseYamlSubset(src: string): Frontmatter {
  const parsed = parseBlock(lines(src), 0);
  return typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
    ? (parsed.value as Frontmatter)
    : {};
}

/** Parses the lines from `from` that belong to one block (same indent), as a map or a list. */
function parseBlock(ls: Line[], from: number): { value: unknown; next: number } {
  if (from >= ls.length) return { value: {}, next: from };
  const indent = ls[from]!.indent;
  if (ls[from]!.text.startsWith("- ") || ls[from]!.text === "-") {
    const items: unknown[] = [];
    let i = from;
    while (i < ls.length && ls[i]!.indent === indent && (ls[i]!.text.startsWith("- ") || ls[i]!.text === "-")) {
      const rest = ls[i]!.text.slice(1).trim();
      if (rest === "") {
        const nested = parseBlock(ls, i + 1);
        items.push(nested.value);
        i = nested.next;
      } else {
        items.push(parseScalar(rest));
        i++;
      }
    }
    return { value: items, next: i };
  }

  const out: Frontmatter = {};
  let i = from;
  while (i < ls.length && ls[i]!.indent === indent) {
    const m = ls[i]!.text.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/);
    if (m === null) {
      i++;
      continue;
    }
    const key = m[1]!;
    const rest = (m[2] ?? "").trim();
    if (rest !== "") {
      out[key] = parseScalar(rest);
      i++;
      continue;
    }
    // Nothing on the line: a block below, or a key without a value.
    if (i + 1 < ls.length && ls[i + 1]!.indent > indent) {
      const nested = parseBlock(ls, i + 1);
      out[key] = nested.value;
      i = nested.next;
    } else {
      i++;
    }
  }
  // Lines deeper than this block's indent that follow a scalar belong to nobody: skip them.
  while (i < ls.length && ls[i]!.indent > indent) i++;
  return { value: out, next: i };
}

function parseScalar(s: string): unknown {
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((x) => parseScalar(x.trim()));
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return unquote(s);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** The strings of a frontmatter list; anything else is an empty list. */
export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
