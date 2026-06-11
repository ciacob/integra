// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/engine/test/resolver.test.js
 *
 * Unit tests for the resolver — the engine's core value resolution system.
 * All tests are pure: no filesystem, no network, no process.env mutation.
 */

import { resolve } from "../src/resolver.js";

// ── Minimal test context factory ──────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    env:       { BASE_URL: "https://example.com", API_KEY: "secret" },
    shared:    { incident: { id: "INC001", priority: "1" } },
    input:     { name: "Test", count: 3 },
    output:    { result: "ok" },
    component: { "my-step": { output: { key: "OPS-1" } } },
    resolvers: {},
    meta:      { runId: "r1", stepId: "s1" },
    _shared:   { get: () => {}, set: () => {} },
    logger:    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  const ctx = makeCtx();

  test("string constant passes through", () => {
    expect(resolve("hello", ctx)).toBe("hello");
  });

  test("number passes through", () => {
    expect(resolve(42, ctx)).toBe(42);
  });

  test("boolean passes through", () => {
    expect(resolve(true, ctx)).toBe(true);
  });

  test("null passes through", () => {
    expect(resolve(null, ctx)).toBeNull();
  });

  test("undefined passes through", () => {
    expect(resolve(undefined, ctx)).toBeUndefined();
  });

  test("object is resolved recursively (values inside may be placeholders)", () => {
    const result = resolve({ a: "{{env.API_KEY}}", b: 1 }, ctx);
    expect(result).toEqual({ a: "secret", b: 1 });
  });

  test("array is resolved recursively", () => {
    const result = resolve(["{{env.API_KEY}}", "plain"], ctx);
    expect(result).toEqual(["secret", "plain"]);
  });
});

// ── Placeholder resolution ────────────────────────────────────────────────────

describe("placeholder resolution", () => {
  const ctx = makeCtx();

  test("resolves env path", () => {
    expect(resolve("{{env.BASE_URL}}", ctx)).toBe("https://example.com");
  });

  test("resolves nested shared path", () => {
    expect(resolve("{{shared.incident.id}}", ctx)).toBe("INC001");
  });

  test("resolves input path", () => {
    expect(resolve("{{input.name}}", ctx)).toBe("Test");
  });

  test("resolves output path", () => {
    expect(resolve("{{output.result}}", ctx)).toBe("ok");
  });

  test("resolves component instance path with hyphenated id", () => {
    expect(resolve("{{component.my-step.output.key}}", ctx)).toBe("OPS-1");
  });

  test("returns undefined for missing path (does not throw)", () => {
    expect(resolve("{{env.DOES_NOT_EXIST}}", ctx)).toBeUndefined();
  });

  test("returns undefined for deeply missing path", () => {
    expect(resolve("{{shared.missing.deep.path}}", ctx)).toBeUndefined();
  });

  test("whole-string placeholder can return a non-string (number)", () => {
    expect(resolve("{{input.count}}", ctx)).toBe(3);
  });

  test("whole-string placeholder can return an object", () => {
    expect(resolve("{{shared.incident}}", ctx)).toEqual({ id: "INC001", priority: "1" });
  });
});

// ── String interpolation ──────────────────────────────────────────────────────

describe("string interpolation", () => {
  const ctx = makeCtx();

  test("interpolates single placeholder in a string", () => {
    expect(resolve("{{env.BASE_URL}}/api/v1", ctx)).toBe("https://example.com/api/v1");
  });

  test("interpolates multiple placeholders in a string", () => {
    expect(resolve("{{env.BASE_URL}}/{{input.name}}", ctx)).toBe("https://example.com/Test");
  });

  test("missing placeholder in interpolated string becomes empty string", () => {
    expect(resolve("prefix-{{env.MISSING}}-suffix", ctx)).toBe("prefix--suffix");
  });

  test("always returns a string from interpolation", () => {
    // input.count is 3 (number) but interpolation always coerces to string
    expect(resolve("count:{{input.count}}", ctx)).toBe("count:3");
  });
});

// ── Function calls ────────────────────────────────────────────────────────────

describe("function calls", () => {
  test("calls zero-arg function with no parentheses", () => {
    const ctx = makeCtx({
      resolvers: { greet: (ctx) => "hello" },
    });
    expect(resolve("{{fn:greet}}", ctx)).toBe("hello");
  });

  test("calls zero-arg function with empty parentheses", () => {
    const ctx = makeCtx({
      resolvers: { greet: (ctx) => "hello" },
    });
    expect(resolve("{{fn:greet()}}", ctx)).toBe("hello");
  });

  test("passes string literal argument", () => {
    const ctx = makeCtx({
      resolvers: { echo: (ctx, val) => val },
    });
    expect(resolve("{{fn:echo('hello')}}", ctx)).toBe("hello");
  });

  test("passes numeric literal argument", () => {
    const ctx = makeCtx({
      resolvers: { double: (ctx, n) => n * 2 },
    });
    expect(resolve("{{fn:double(5)}}", ctx)).toBe(10);
  });

  test("passes boolean literal arguments", () => {
    const ctx = makeCtx({
      resolvers: { both: (ctx, a, b) => [a, b] },
    });
    expect(resolve("{{fn:both(true, false)}}", ctx)).toEqual([true, false]);
  });

  test("passes null literal argument", () => {
    const ctx = makeCtx({
      resolvers: { isNull: (ctx, v) => v === null },
    });
    expect(resolve("{{fn:isNull(null)}}", ctx)).toBe(true);
  });

  test("passes dot-path argument resolved from ctx", () => {
    const ctx = makeCtx({
      resolvers: { identity: (ctx, v) => v },
    });
    expect(resolve("{{fn:identity(env.API_KEY)}}", ctx)).toBe("secret");
  });

  test("passes multiple mixed arguments", () => {
    const ctx = makeCtx({
      resolvers: { join: (ctx, a, b, c) => `${a}:${b}:${c}` },
    });
    expect(resolve("{{fn:join(env.API_KEY, 'literal', 42)}}", ctx)).toBe("secret:literal:42");
  });

  test("function receives ctx as first argument", () => {
    const ctx = makeCtx({
      resolvers: { getRunId: (ctx) => ctx.meta.runId },
    });
    expect(resolve("{{fn:getRunId}}", ctx)).toBe("r1");
  });

  test("throws EngineError when function not found", () => {
    const ctx = makeCtx({ resolvers: {} });
    expect(() => resolve("{{fn:missing}}", ctx)).toThrow("Resolver function not found: missing");
  });

  test("function return value of non-string type is preserved for whole-string call", () => {
    const ctx = makeCtx({
      resolvers: { getObj: (ctx) => ({ x: 1 }) },
    });
    expect(resolve("{{fn:getObj}}", ctx)).toEqual({ x: 1 });
  });
});

// ── Recursive resolution ──────────────────────────────────────────────────────

describe("recursive resolution", () => {
  test("nested object values are resolved", () => {
    const ctx = makeCtx();
    const input = { url: "{{env.BASE_URL}}", nested: { key: "{{env.API_KEY}}" } };
    expect(resolve(input, ctx)).toEqual({
      url:    "https://example.com",
      nested: { key: "secret" },
    });
  });

  test("array of placeholders is resolved", () => {
    const ctx = makeCtx();
    expect(resolve(["{{env.API_KEY}}", "{{input.name}}"], ctx)).toEqual(["secret", "Test"]);
  });
});
