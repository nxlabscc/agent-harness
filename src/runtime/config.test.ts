import { expect, test } from "bun:test";
import { loadRuntimeConfig } from "./config";

const valid = {
  maxSteps: { run: 100, stream: 8 },
  continueOnCut: { prompt: "Continue from where you stopped.", times: 2 },
  wrapUp: { prompt: "Wrap up: write your pending tasks.", steps: 15 },
};

test("a valid config loads", () => {
  expect(loadRuntimeConfig(valid)).toEqual(valid);
});

test("a missing or out-of-range field is named", () => {
  expect(() => loadRuntimeConfig({})).toThrow("maxSteps.run");
  expect(() => loadRuntimeConfig({ ...valid, maxSteps: { run: 0, stream: 8 } })).toThrow("maxSteps.run must be a positive integer");
  expect(() => loadRuntimeConfig({ ...valid, continueOnCut: { prompt: "  ", times: 2 } })).toThrow("continueOnCut.prompt must be a non-empty string");
  expect(() => loadRuntimeConfig({ ...valid, continueOnCut: { prompt: "x", times: -1 } })).toThrow("continueOnCut.times");
  expect(() => loadRuntimeConfig({ ...valid, wrapUp: { prompt: "x", steps: 1.5 } })).toThrow("wrapUp.steps");
  expect(() => loadRuntimeConfig(null)).toThrow("must be an object");
});
