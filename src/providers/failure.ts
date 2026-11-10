import { APICallError, RetryError } from "ai";

/**
 * Whose failure it is.
 *
 * - `provider-down`: the provider cannot answer anyone. No balance (402), a bad
 *   key (401), rate-limited or down (429, 5xx) after the SDK's own retries, or
 *   unreachable. The run is not at fault; whoever runs sessions should pause.
 * - `unparseable`: the call reached the provider, came back 2xx, and the body
 *   did not parse. The SDK retries only 408/409/429/5xx, so this one it never
 *   retries; `retryUnparseable` does.
 * - `run`: this prompt or this turn failed. A content filter (400), invalid
 *   parameters (422), a tool that threw. Nothing to pause for.
 */
export type Failure = {
  kind: "provider-down" | "unparseable" | "run";
  message: string;
  status: number | undefined;
  /** The response body, when there was one, for whoever writes it down. */
  body: string | undefined;
};

// Messages the SDK raises when a 2xx body fails to parse against the provider schema.
const PARSE_FAILURES = new Set(["Invalid JSON response", "Failed to process successful response"]);

const unwrap = (err: unknown): unknown => (RetryError.isInstance(err) ? err.lastError : err);

export function isUnparseable(err: unknown): err is APICallError {
  const e = unwrap(err);
  return APICallError.isInstance(e) && PARSE_FAILURES.has(e.message);
}

export function classifyFailure(err: unknown): Failure {
  const e = unwrap(err);
  const message = e instanceof Error ? e.message : String(e);
  if (!APICallError.isInstance(e)) return { kind: "run", message, status: undefined, body: undefined };
  const status = e.statusCode;
  const body = typeof e.responseBody === "string" ? e.responseBody : undefined;
  if (PARSE_FAILURES.has(e.message)) return { kind: "unparseable", message, status, body };
  if (status === undefined || status === 401 || status === 402 || status === 429 || status >= 500) {
    return { kind: "provider-down", message, status, body };
  }
  return { kind: "run", message, status, body };
}

export const isProviderDown = (err: unknown): boolean => classifyFailure(err).kind === "provider-down";
