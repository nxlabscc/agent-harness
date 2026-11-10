import { dynamicTool, jsonSchema, type ToolSet } from "ai";

// The MCP client: the tools of the configured servers, over JSON-RPC. It knows
// nothing about any one server — it asks `tools/list`, exposes what comes back
// as the model's tools, and reads `readOnlyHint` as each tool's effect. Which
// servers, and what authenticates a call, the project gives per session.

export type McpServer = { name: string; url: string };

/** Headers for a call to a server: the project's, usually the person's bearer token. */
export type McpAuth = (server: McpServer) => Record<string, string> | Promise<Record<string, string>>;

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

/** A tool and the server it came from. This is what is frozen with the session. */
export type McpToolDef = McpToolInfo & { server: McpServer };

type RpcResponse = {
  result?: { tools?: McpToolInfo[]; content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { message?: string };
};

async function rpc(server: McpServer, auth: McpAuth, method: string, params: Record<string, unknown>): Promise<RpcResponse> {
  const headers = await auth(server);
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${server.name} answered ${res.status}`);
  return (await res.json()) as RpcResponse;
}

/**
 * Ask each server what tools it has. Called once, when the session opens: the
 * definitions travel in every request, so changing them mid-conversation
 * breaks the cached prefix and changes the agent's tools under its hand. A
 * server that is down loses its tools, not the session.
 */
export async function listMcpTools(servers: McpServer[], auth: McpAuth, onError?: (server: McpServer, err: unknown) => void): Promise<McpToolDef[]> {
  const out: McpToolDef[] = [];
  for (const server of servers) {
    try {
      const tools = (await rpc(server, auth, "tools/list", {})).result?.tools ?? [];
      out.push(...tools.map((t) => ({ ...t, server })));
    } catch (err) {
      onError?.(server, err);
    }
  }
  return out;
}

/** The names a server declared as writers (`readOnlyHint: false`). Anything else is read-only. */
export function mcpWriters(defs: McpToolDef[]): Set<string> {
  return new Set(defs.filter((d) => d.annotations?.readOnlyHint === false).map((d) => d.name));
}

/** Call one tool and return its text content. The path with no model in between: a crawler's. */
export async function callMcpTool(server: McpServer, auth: McpAuth, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const json = await rpc(server, auth, "tools/call", { name, arguments: args });
  if (json.error) throw new Error(json.error.message ?? `${server.name}: ${name}`);
  const text = (json.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (json.result?.isError) throw new Error(`${name}: ${text.slice(0, 200)}`);
  return text;
}

/**
 * The tools, built from the definitions already known. No network until one is
 * called. Each is exposed as it came — name, description, input schema — so the
 * harness keeps no second version of what the server declares.
 */
export function mcpTools(defs: McpToolDef[], auth: McpAuth): ToolSet {
  const out: Record<string, ToolSet[string]> = {};
  for (const t of defs) {
    out[t.name] = dynamicTool({
      description: t.description ?? "",
      inputSchema: jsonSchema(t.inputSchema ?? { type: "object", properties: {} }),
      execute: async (args) => callMcpTool(t.server, auth, t.name, args as Record<string, unknown>),
    });
  }
  return out;
}
