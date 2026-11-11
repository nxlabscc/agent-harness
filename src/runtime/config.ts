// The step limits and the texts around them. The library carries no text of
// its own (D10): the prompts are required, and a runtime without them refuses
// to start. A project passes this in code or loads it from JSON.

export type RuntimeConfig = {
  /** Steps a turn gets. `run` is the automated path, `stream` the interactive one. */
  maxSteps: { run: number; stream: number };
  /** A cut reply is handed back with this prompt, this many times, before the run errors. */
  continueOnCut: { prompt: string; times: number };
  /** A run that spends its budget is told this, with this many steps to close. */
  wrapUp: { prompt: string; steps: number };
  /**
   * How a streamed turn's failure reaches the client, as the body of the UI
   * message stream. The default surfaces the error's own message; a deployment
   * that must not leak it sets its own formatter — a fixed string, a request id.
   * Set in code, not from JSON (a function), so `loadRuntimeConfig` leaves it
   * unset and the default applies.
   */
  streamOnError?: (error: unknown) => string;
};

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`runtime config: ${field} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`runtime config: ${field} must be a non-negative integer`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`runtime config: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a runtime config, naming the field that is missing or out of range.
 * The library ships no prompt text, so a project cannot run on words it did not
 * choose.
 */
export function loadRuntimeConfig(json: unknown): RuntimeConfig {
  if (typeof json !== "object" || json === null) throw new Error("runtime config: must be an object");
  const c = json as Record<string, unknown>;
  const maxSteps = (c.maxSteps ?? {}) as Record<string, unknown>;
  const continueOnCut = (c.continueOnCut ?? {}) as Record<string, unknown>;
  const wrapUp = (c.wrapUp ?? {}) as Record<string, unknown>;
  return {
    maxSteps: {
      run: requirePositiveInt(maxSteps.run, "maxSteps.run"),
      stream: requirePositiveInt(maxSteps.stream, "maxSteps.stream"),
    },
    continueOnCut: {
      prompt: requireText(continueOnCut.prompt, "continueOnCut.prompt"),
      times: requireNonNegativeInt(continueOnCut.times, "continueOnCut.times"),
    },
    wrapUp: {
      prompt: requireText(wrapUp.prompt, "wrapUp.prompt"),
      steps: requirePositiveInt(wrapUp.steps, "wrapUp.steps"),
    },
  };
}
