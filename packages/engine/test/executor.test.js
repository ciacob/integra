/**
 * packages/engine/test/executor.test.js
 *
 * Unit tests for the executor — flow control, error bubbling, component merging,
 * mapping logic, and the pure helper functions.
 * HTTP calls are mocked via global.fetch.
 */

import { executeProcess }  from "../src/executor.js";
import { createSharedSpace } from "../src/shared.js";
import { BreakSignal, ContinueSignal, StepError } from "../src/error.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeShared(initial = {}) {
  const s = createSharedSpace();
  for (const [k, v] of Object.entries(initial)) s.set(k, v);
  return s;
}

function makeRegistry(overrides = {}) {
  return { connections: {}, maps: {}, processes: {}, ...overrides };
}

/**
 * Minimal resolver that records calls and lets tests inject behaviour.
 * Each key is a function name; the value is the implementation.
 */
function makeResolvers(fns = {}) {
  return fns;
}

/**
 * Builds a minimal process JSON for testing.
 */
function makeProcess(id, steps, extra = {}) {
  return { id, flow: { steps }, ...extra };
}

// Silence logger during tests
process.env.LOG_LEVEL = "error";

// ── mergeComponent (pure helper — tested via executeProcess behaviour) ────────

describe("mergeComponent precedence", () => {
  test("wrapper.defaults fill gaps in component.defaults", async () => {
    const shared = makeShared();
    const calls  = [];

    const mapComp = {
      id: "my-map",
      defaults:  { color: "blue" },
      overrides: {},
      transformation: { base: "{{fn:capture}}" },
    };

    const registry = makeRegistry({ maps: { "my-map": mapComp } });
    const resolvers = makeResolvers({
      capture: (ctx) => { calls.push({ ...ctx.input }); return {}; },
    });

    const proc = makeProcess("p", [{
      id:        "s1",
      component: "my-map",
      defaults:  { size: "large" },   // wrapper default — fills gap
    }]);

    await executeProcess(proc, registry, shared, resolvers);
    // Both defaults should be present in input
    expect(calls[0].color).toBe("blue");
    expect(calls[0].size).toBe("large");
  });

  test("component.overrides beat wrapper.overrides", async () => {
    const shared = makeShared();
    const calls  = [];

    const mapComp = {
      id: "my-map",
      defaults:  {},
      overrides: { locked: "component" },  // component locks this
      transformation: { base: "{{fn:capture}}" },
    };

    const registry = makeRegistry({ maps: { "my-map": mapComp } });
    const resolvers = makeResolvers({
      capture: (ctx) => { calls.push({ ...ctx.input }); return {}; },
    });

    const proc = makeProcess("p", [{
      id:        "s1",
      component: "my-map",
      overrides: { locked: "wrapper" },   // wrapper tries to override
    }]);

    await executeProcess(proc, registry, shared, resolvers);
    expect(calls[0].locked).toBe("component");
  });
});

// ── applyMappings (via executeProcess with a map component) ──────────────────

describe("transformation mappings", () => {
  test("transformation.defaults fills fields base did not provide", async () => {
    const shared = makeShared({ src: { title: "Hello", body: "World" } });

    const mapComp = {
      id: "m",
      input: "{{shared.src}}",
      defaults: {},
      overrides: {},
      output: "{{fn:mapStore('result')}}",
      transformation: {
        base:     "{{fn:base}}",
        defaults: { "title": "summary" },   // src.title -> output.summary if not set
      },
    };

    const registry  = makeRegistry({ maps: { m: mapComp } });
    const resolvers = makeResolvers({
      base:     (ctx) => ({}),
      mapStore: (ctx, k) => { ctx._shared.set(k, ctx.output); return ctx.output; },
    });

    const proc = makeProcess("p", [{ component: "m" }]);
    await executeProcess(proc, registry, shared, resolvers);

    expect(shared.get("result").summary).toBe("Hello");
  });

  test("transformation.overrides always wins over base output", async () => {
    const shared = makeShared({ src: { color: "red" } });

    const mapComp = {
      id: "m",
      input: "{{shared.src}}",
      defaults: {},
      overrides: {},
      output: "{{fn:mapStore('result')}}",
      transformation: {
        base:      "{{fn:base}}",
        overrides: { "color": "forced" },   // always sets output.forced = input.color
      },
    };

    const registry  = makeRegistry({ maps: { m: mapComp } });
    const resolvers = makeResolvers({
      base:     (ctx) => ({ forced: "base-set" }),  // base sets it
      mapStore: (ctx, k) => { ctx._shared.set(k, ctx.output); return ctx.output; },
    });

    const proc = makeProcess("p", [{ component: "m" }]);
    await executeProcess(proc, registry, shared, resolvers);

    // overrides should win over base
    expect(shared.get("result").forced).toBe("red");
  });
});

// ── Flow control: if / else ───────────────────────────────────────────────────

describe("if / else", () => {
  test("if true executes steps", async () => {
    const shared = makeShared();
    const log    = [];

    const resolvers = makeResolvers({
      isTrue: () => true,
      mark:   (ctx, v) => { log.push(v); },
    });

    const proc = makeProcess("p", [
      { if: "{{fn:isTrue}}", steps: [{ component: "m" }] },
    ]);

    const mapComp = { id: "m", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('ran')}}" } };
    const registry = makeRegistry({ maps: { m: mapComp } });

    await executeProcess(proc, registry, shared, resolvers);
    expect(log).toContain("ran");
  });

  test("if false skips steps", async () => {
    const shared = makeShared();
    const log    = [];

    const resolvers = makeResolvers({
      isFalse: () => false,
      mark:    (ctx, v) => { log.push(v); },
    });

    const proc = makeProcess("p", [
      { if: "{{fn:isFalse}}", steps: [{ component: "m" }] },
    ]);

    const mapComp = { id: "m", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('ran')}}" } };
    const registry = makeRegistry({ maps: { m: mapComp } });

    await executeProcess(proc, registry, shared, resolvers);
    expect(log).not.toContain("ran");
  });

  test("else runs when preceding if was false", async () => {
    const shared = makeShared();
    const log    = [];

    const resolvers = makeResolvers({
      isFalse: () => false,
      mark:    (ctx, v) => { log.push(v); },
    });

    const mapA = { id: "mapA", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('if-branch')}}" } };
    const mapB = { id: "mapB", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('else-branch')}}" } };
    const registry = makeRegistry({ maps: { mapA, mapB } });

    const proc = makeProcess("p", [
      { if: "{{fn:isFalse}}", steps: [{ component: "mapA" }] },
      { else: null,           steps: [{ component: "mapB" }] },
    ]);

    await executeProcess(proc, registry, shared, resolvers);
    expect(log).not.toContain("if-branch");
    expect(log).toContain("else-branch");
  });

  test("else is skipped when preceding if was true", async () => {
    const shared = makeShared();
    const log    = [];

    const resolvers = makeResolvers({
      isTrue: () => true,
      mark:   (ctx, v) => { log.push(v); },
    });

    const mapA = { id: "mapA", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('if-branch')}}" } };
    const mapB = { id: "mapB", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('else-branch')}}" } };
    const registry = makeRegistry({ maps: { mapA, mapB } });

    const proc = makeProcess("p", [
      { if: "{{fn:isTrue}}", steps: [{ component: "mapA" }] },
      { else: null,          steps: [{ component: "mapB" }] },
    ]);

    await executeProcess(proc, registry, shared, resolvers);
    expect(log).toContain("if-branch");
    expect(log).not.toContain("else-branch");
  });
});

// ── Flow control: switch ──────────────────────────────────────────────────────

describe("switch", () => {
  function makeSwitchProc(priority) {
    return makeProcess("p", [{
      switch: "{{fn:getPriority}}",
      cases: {
        "1": { steps: [{ component: "mapCritical" }] },
        "2": { steps: [{ component: "mapHigh"     }] },
        "default": { steps: [{ component: "mapNormal" }] },
      },
    }]);
  }

  test("matches exact case", async () => {
    const shared = makeShared();
    const log = [];
    const resolvers = makeResolvers({
      getPriority: () => "1",
      mark: (ctx, v) => { log.push(v); },
    });
    const maps = {
      mapCritical: { id: "mapCritical", defaults: {}, overrides: {}, transformation: { base: "{{fn:mark('critical')}}" } },
      mapHigh:     { id: "mapHigh",     defaults: {}, overrides: {}, transformation: { base: "{{fn:mark('high')}}"     } },
      mapNormal:   { id: "mapNormal",   defaults: {}, overrides: {}, transformation: { base: "{{fn:mark('normal')}}"   } },
    };

    await executeProcess(makeSwitchProc("1"), makeRegistry({ maps }), shared, resolvers);
    expect(log).toEqual(["critical"]);
  });

  test("falls through to default", async () => {
    const shared = makeShared();
    const log = [];
    const resolvers = makeResolvers({
      getPriority: () => "99",
      mark: (ctx, v) => { log.push(v); },
    });
    const maps = {
      mapCritical: { id: "mapCritical", defaults: {}, overrides: {}, transformation: { base: "{{fn:mark('critical')}}" } },
      mapHigh:     { id: "mapHigh",     defaults: {}, overrides: {}, transformation: { base: "{{fn:mark('high')}}"     } },
      mapNormal:   { id: "mapNormal",   defaults: {}, overrides: {}, transformation: { base: "{{fn:mark('normal')}}"   } },
    };

    await executeProcess(makeSwitchProc("99"), makeRegistry({ maps }), shared, resolvers);
    expect(log).toEqual(["normal"]);
  });
});

// ── Flow control: while / break / continue ────────────────────────────────────

describe("while", () => {
  test("executes steps until condition is false", async () => {
    const shared = makeShared();
    let   count  = 3;
    const log    = [];

    const resolvers = makeResolvers({
      hasMore: () => count-- > 0,
      tick:    (ctx) => { log.push("tick"); },
    });

    const mapComp = { id: "m", defaults: {}, overrides: {},
      transformation: { base: "{{fn:tick}}" } };

    const proc = makeProcess("p", [{
      id:    "loop",
      while: "{{fn:hasMore}}",
      steps: [{ component: "m" }],
    }]);

    await executeProcess(proc, makeRegistry({ maps: { m: mapComp } }), shared, resolvers);
    expect(log).toHaveLength(3);
  });

  test("break exits the loop", async () => {
    const shared = makeShared();
    const log    = [];
    let   i      = 0;

    const resolvers = makeResolvers({
      always:    () => true,
      tick:      (ctx) => { log.push("tick"); },
      shouldStop: () => ++i >= 2,
    });

    const mapTick = { id: "tick", defaults: {}, overrides: {},
      transformation: { base: "{{fn:tick}}" } };

    const proc = makeProcess("p", [{
      id:    "loop",
      while: "{{fn:always}}",
      steps: [
        { component: "tick" },
        { if: "{{fn:shouldStop}}", steps: [{ break: "loop" }] },
      ],
    }]);

    await executeProcess(proc, makeRegistry({ maps: { tick: mapTick } }), shared, resolvers);
    expect(log).toHaveLength(2);
  });

  test("continue skips remaining steps and re-evaluates condition", async () => {
    const shared = makeShared();
    const log    = [];
    let   i      = 0;

    const resolvers = makeResolvers({
      hasMore:      () => i++ < 3,
      skipOnSecond: () => i === 2,
      mark:         (ctx, v) => { log.push(v); },
    });

    const mapA = { id: "mA", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('before')}}" } };
    const mapB = { id: "mB", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('after')}}" } };

    const proc = makeProcess("p", [{
      id:    "loop",
      while: "{{fn:hasMore}}",
      steps: [
        { component: "mA" },
        { if: "{{fn:skipOnSecond}}", steps: [{ continue: "loop" }] },
        { component: "mB" },
      ],
    }]);

    await executeProcess(proc, makeRegistry({ maps: { mA: mapA, mB: mapB } }), shared, resolvers);

    const befores = log.filter(x => x === "before").length;
    const afters  = log.filter(x => x === "after").length;
    expect(befores).toBe(3);
    expect(afters).toBe(2);   // skipped once due to continue
  });
});

// ── Error bubbling and onError ────────────────────────────────────────────────

describe("error handling", () => {
  test("step failure without onError bubbles as StepError", async () => {
    const shared = makeShared();

    const mapComp = { id: "m", defaults: {}, overrides: {},
      transformation: { base: "{{fn:boom}}" } };

    const resolvers = makeResolvers({
      boom: () => { throw new Error("explosion"); },
    });

    const proc = makeProcess("p", [{ id: "s1", component: "m" }]);

    await expect(
      executeProcess(proc, makeRegistry({ maps: { m: mapComp } }), shared, resolvers)
    ).rejects.toBeInstanceOf(StepError);
  });

  test("onError handler swallows error and continues", async () => {
    const shared = makeShared();
    const log    = [];

    const mapFail = { id: "fail", defaults: {}, overrides: {},
      transformation: { base: "{{fn:boom}}" } };
    const mapNext = { id: "next", defaults: {}, overrides: {},
      transformation: { base: "{{fn:mark('continued')}}" } };

    const resolvers = makeResolvers({
      boom:    () => { throw new Error("boom"); },
      handle:  (ctx) => { log.push("handled"); /* swallow */ },
      mark:    (ctx, v) => { log.push(v); },
    });

    const proc = makeProcess("p", [
      { id: "s1", component: "fail", onError: "{{fn:handle}}" },
      { id: "s2", component: "next" },
    ]);

    await executeProcess(proc, makeRegistry({ maps: { fail: mapFail, next: mapNext } }), shared, resolvers);
    expect(log).toEqual(["handled", "continued"]);
  });

  test("onError handler that rethrows still bubbles", async () => {
    const shared = makeShared();

    const mapComp = { id: "m", defaults: {}, overrides: {},
      transformation: { base: "{{fn:boom}}" } };

    const resolvers = makeResolvers({
      boom:   () => { throw new Error("original"); },
      handle: (ctx) => { throw new Error("rethrown"); },
    });

    const proc = makeProcess("p", [
      { id: "s1", component: "m", onError: "{{fn:handle}}" },
    ]);

    await expect(
      executeProcess(proc, makeRegistry({ maps: { m: mapComp } }), shared, resolvers)
    ).rejects.toThrow();
  });

  test("error in nested flow bubbles to parent if no handler in path", async () => {
    const shared = makeShared();

    const mapComp = { id: "m", defaults: {}, overrides: {},
      transformation: { base: "{{fn:boom}}" } };

    const resolvers = makeResolvers({
      boom:   () => { throw new Error("deep error"); },
      isTrue: () => true,
    });

    const proc = makeProcess("p", [{
      if:    "{{fn:isTrue}}",
      steps: [{ component: "m" }],
    }]);

    await expect(
      executeProcess(proc, makeRegistry({ maps: { m: mapComp } }), shared, resolvers)
    ).rejects.toBeInstanceOf(StepError);
  });
});

// ── HTTP connection component ─────────────────────────────────────────────────

describe("connection component", () => {
  afterEach(() => { global.fetch = undefined; });

  test("makes HTTP request and stores output in shared space", async () => {
    global.fetch = async (url, opts) => ({
      ok:     true,
      status: 200,
      json:   async () => ({ result: [{ id: "1", name: "Test" }] }),
    });

    const shared = makeShared();
    const conn   = {
      id:      "my-conn",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/items" },
      output:  "{{fn:storeIt('items')}}",
    };

    const resolvers = makeResolvers({
      storeIt: (ctx, k) => { ctx._shared.set(k, ctx.output); return ctx.output; },
    });

    const proc = makeProcess("p", [{ component: "my-conn" }]);
    await executeProcess(proc, makeRegistry({ connections: { "my-conn": conn } }), shared, resolvers);

    expect(shared.get("items")).toBeDefined();
    expect(shared.get("items").result).toHaveLength(1);
  });

  test("throws on non-ok HTTP response", async () => {
    global.fetch = async () => ({
      ok: false, status: 404, statusText: "Not Found",
      json: async () => ({}),
    });

    const conn = {
      id:      "my-conn",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/missing" },
    };

    const proc = makeProcess("p", [{ component: "my-conn" }]);
    await expect(
      executeProcess(proc, makeRegistry({ connections: { "my-conn": conn } }), makeShared(), {})
    ).rejects.toThrow("HTTP 404");
  });

  test("filter returning false discards the output", async () => {
    global.fetch = async () => ({
      ok:     true,
      status: 200,
      json:   async () => ({ result: [] }),
    });

    const shared = makeShared();
    const conn   = {
      id:      "my-conn",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/items" },
      filter:  "{{fn:hasItems}}",
      output:  "{{fn:storeIt('items')}}",
    };

    const resolvers = makeResolvers({
      hasItems: (ctx) => Array.isArray(ctx.output?.result) && ctx.output.result.length > 0,
      storeIt:  (ctx, k) => { ctx._shared.set(k, ctx.output); return ctx.output; },
    });

    const proc = makeProcess("p", [{ component: "my-conn" }]);
    await executeProcess(proc, makeRegistry({ connections: { "my-conn": conn } }), shared, resolvers);

    expect(shared.get("items")).toBeUndefined();
  });
});

// ── Parallel execution ────────────────────────────────────────────────────────

describe("parallel execution", () => {
  test("parallel:true runs all steps and all complete", async () => {
    const shared  = makeShared();
    const results = [];

    const resolvers = makeResolvers({
      runA: (ctx) => { results.push("A"); },
      runB: (ctx) => { results.push("B"); },
    });

    const maps = {
      mA: { id: "mA", defaults: {}, overrides: {}, transformation: { base: "{{fn:runA}}" } },
      mB: { id: "mB", defaults: {}, overrides: {}, transformation: { base: "{{fn:runB}}" } },
    };

    const proc = makeProcess("p", [], {
      flow: {
        metadata: { parallel: true },
        steps: [{ component: "mA" }, { component: "mB" }],
      },
    });

    await executeProcess(proc, makeRegistry({ maps }), shared, resolvers);

    expect(results).toHaveLength(2);
    expect(results).toContain("A");
    expect(results).toContain("B");
  });
});
