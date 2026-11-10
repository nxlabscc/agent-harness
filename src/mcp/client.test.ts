import { afterEach, expect, test } from "bun:test";
import { callMcpTool, listMcpTools, mcpTools, mcpWriters, type McpServer } from "./client";

const server: McpServer = { name: "workspace", url: "http://mcp-server/api/v1/mcp" };
const auth = (_s: McpServer) => ({ authorization: "Bearer user-token" });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub the global fetch with a JSON-RPC responder, recording the requests. */
function stubRpc(handler: (method: string, params: Record<string, unknown>, headers: Headers) => unknown) {
  const calls: { method: string; params: Record<string, unknown>; headers: Headers }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    const body = JSON.parse(init!.body!) as { method: string; params: Record<string, unknown> };
    const headers = new Headers(init!.headers);
    calls.push({ method: body.method, params: body.params, headers });
    const result = handler(body.method, body.params, headers);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

const LIST = {
  result: {
    tools: [
      { name: "get_page", description: "read a page", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } },
      { name: "create_row", description: "add a row", annotations: { readOnlyHint: false } },
    ],
  },
};

test("tools are listed once, carrying their server, and a down server loses its tools not the session", async () => {
  const errors: string[] = [];
  stubRpc((method, _p, headers) => {
    expect(headers.get("authorization")).toBe("Bearer user-token");
    if (method === "tools/list") return LIST;
    return {};
  });
  const defs = await listMcpTools([server], auth);
  expect(defs.map((d) => d.name)).toEqual(["get_page", "create_row"]);
  expect(defs[0]!.server).toEqual(server);
  expect(mcpWriters(defs)).toEqual(new Set(["create_row"]));

  globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  expect(await listMcpTools([server], auth, (s, err) => errors.push(`${s.name}:${(err as Error).message}`))).toEqual([]);
  expect(errors[0]).toContain("workspace");
});

test("a built tool calls tools/call with its arguments and returns the text content", async () => {
  const calls = stubRpc((method, params) => {
    if (method === "tools/call") {
      expect(params).toEqual({ name: "get_page", arguments: { id: "p1" } });
      return { result: { content: [{ type: "text", text: "the page" }, { type: "image", text: "ignored" }] } };
    }
    return {};
  });
  const defs = [{ name: "get_page", server }];
  const set = mcpTools(defs, auth);
  const out = await (set.get_page!.execute as (a: unknown, o: unknown) => Promise<unknown>)({ id: "p1" }, {});
  expect(out).toBe("the page");
  expect(calls[0]!.method).toBe("tools/call");
});

test("a tool error from the server throws", async () => {
  stubRpc(() => ({ result: { content: [{ type: "text", text: "boom" }], isError: true } }));
  await expect(callMcpTool(server, auth, "get_page")).rejects.toThrow("boom");

  stubRpc(() => ({ error: { message: "bad request" } }));
  await expect(callMcpTool(server, auth, "get_page")).rejects.toThrow("bad request");
});
