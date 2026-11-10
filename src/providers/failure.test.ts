import { expect, test } from "bun:test";
import { APICallError, RetryError } from "ai";
import { classifyFailure, isProviderDown, isUnparseable } from "./failure";

const api = (statusCode: number | undefined, message = "x", responseBody?: string) =>
  new APICallError({ message, url: "https://api.example.com", requestBodyValues: {}, statusCode, responseBody });

test("the provider's failures: no balance, a bad key, rate limit, down, unreachable", () => {
  for (const s of [402, 401, 429, 500, 502, 503, undefined]) {
    expect(isProviderDown(api(s))).toBe(true);
    expect(classifyFailure(api(s)).status).toBe(s);
  }
});

test("the run's failures: content filter, invalid params, a tool that threw", () => {
  for (const s of [400, 422]) expect(classifyFailure(api(s)).kind).toBe("run");
  expect(classifyFailure(new Error("tool exploded"))).toEqual({ kind: "run", message: "tool exploded", status: undefined, body: undefined });
});

test("a 2xx whose body did not parse is its own kind, with the body kept", () => {
  const f = classifyFailure(api(200, "Invalid JSON response", "<html>oops</html>"));
  expect(f).toEqual({ kind: "unparseable", message: "Invalid JSON response", status: 200, body: "<html>oops</html>" });
  expect(isUnparseable(api(200, "Failed to process successful response"))).toBe(true);
  expect(isUnparseable(api(500, "Invalid JSON response"))).toBe(true);
});

test("a failure the SDK already retried is read through its last error", () => {
  const err = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [api(503), api(503), api(503, "down")] });
  expect(classifyFailure(err)).toMatchObject({ kind: "provider-down", status: 503, message: "down" });
});
