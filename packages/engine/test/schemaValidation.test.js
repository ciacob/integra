// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/engine/test/schemaValidation.test.js
 *
 * Tests for validateManifest (integra.json) and registry validation.
 * Pure — no filesystem writes, no network.
 */

import { validateManifest } from "../src/loader.js";

// ── validateManifest ──────────────────────────────────────────────────────────

describe("validateManifest", () => {

  // ── Valid manifests ─────────────────────────────────────────────────────────

  test("accepts a minimal valid run-once manifest", async () => {
    await expect(validateManifest({ id: "my-integration", entry: "my-process" }))
      .resolves.toBeUndefined();
  });

  test("accepts a valid scheduled manifest", async () => {
    await expect(validateManifest({
      id:        "my-integration",
      entry:     "my-process",
      lifecycle: "scheduled",
    })).resolves.toBeUndefined();
  });

  test("accepts a valid listener manifest with httpServer", async () => {
    await expect(validateManifest({
      id:          "my-integration",
      entry:       "my-process",
      lifecycle:   "listener",
      sendResult:  true,
      httpServer:  { port: 3000, path: "/hooks/jira", method: "POST" },
    })).resolves.toBeUndefined();
  });

  test("accepts null entry (scaffolded but not yet configured)", async () => {
    await expect(validateManifest({ id: "my-integration", entry: null }))
      .resolves.toBeUndefined();
  });

  test("accepts private annotation keys (_sendResult_note etc.)", async () => {
    await expect(validateManifest({
      id:                 "x",
      entry:              "p",
      _sendResult_note:   "for demo only",
      _lifecycle_note:    ["a", "b"],
    })).resolves.toBeUndefined();
  });

  // ── Invalid manifests ───────────────────────────────────────────────────────

  test("rejects manifest missing required id", async () => {
    await expect(validateManifest({ entry: "my-process" }))
      .rejects.toThrow("integra.json validation failed");
  });

  test("rejects manifest missing required entry", async () => {
    await expect(validateManifest({ id: "my-integration" }))
      .rejects.toThrow("integra.json validation failed");
  });

  test("rejects empty id string", async () => {
    await expect(validateManifest({ id: "", entry: "p" }))
      .rejects.toThrow("integra.json validation failed");
  });

  test("rejects unknown lifecycle value", async () => {
    await expect(validateManifest({
      id:        "x",
      entry:     "p",
      lifecycle: "daemon",
    })).rejects.toThrow("integra.json validation failed");
  });

  test("rejects listener manifest without httpServer", async () => {
    await expect(validateManifest({
      id:        "x",
      entry:     "p",
      lifecycle: "listener",
    })).rejects.toThrow("integra.json validation failed");
  });

  test("rejects httpServer without required path", async () => {
    await expect(validateManifest({
      id:         "x",
      entry:      "p",
      lifecycle:  "listener",
      httpServer: { port: 3000 },   // missing path
    })).rejects.toThrow("integra.json validation failed");
  });

  test("rejects httpServer with unknown auth type", async () => {
    await expect(validateManifest({
      id:        "x",
      entry:     "p",
      lifecycle: "listener",
      httpServer: {
        port: 3000,
        path: "/hooks",
        auth: { type: "magic-auth" },
      },
    })).rejects.toThrow("integra.json validation failed");
  });

  test("rejects unknown root fields (additionalProperties: false)", async () => {
    await expect(validateManifest({
      id:      "x",
      entry:   "p",
      unknown: "field",
    })).rejects.toThrow("integra.json validation failed");
  });

  test("error message names the failing property", async () => {
    let message = "";
    try {
      await validateManifest({ entry: "p" });
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain("id");
  });
});

// ── registry schema validation (via validateRegistryData internal logic) ──────
// These test the schema shape indirectly by validating real registry structures.

describe("registry.json schema shape", () => {
  // Import Ajv and the schema directly so we can test without filesystem
  let validate;

  beforeAll(async () => {
    const { readFile }  = await import("fs/promises");
    const { resolve }   = await import("path");
    const { fileURLToPath } = await import("url");
    const Ajv           = (await import("ajv")).default;

    const testDir    = resolve(fileURLToPath(import.meta.url), "..");
    const schemaPath = resolve(testDir, "../../manager/schemas/registry.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf-8"));
    const ajv    = new Ajv({ allErrors: true });
    validate     = ajv.compile(schema);
  });

  test("accepts a valid registry", () => {
    expect(validate({
      integrations: [
        { id: "my-integration", path: "./my-integration", enabled: true },
      ],
    })).toBe(true);
  });

  test("accepts a scheduled integration entry", () => {
    expect(validate({
      integrations: [{
        id:       "sched",
        path:     "./sched",
        schedule: "*/5 * * * *",
        max_ttl:  240,
      }],
    })).toBe(true);
  });

  test("accepts an empty integrations array", () => {
    expect(validate({ integrations: [] })).toBe(true);
  });

  test("rejects missing integrations array", () => {
    expect(validate({})).toBe(false);
  });

  test("rejects integration entry missing id", () => {
    expect(validate({ integrations: [{ path: "./x" }] })).toBe(false);
  });

  test("rejects integration entry missing path", () => {
    expect(validate({ integrations: [{ id: "x" }] })).toBe(false);
  });

  test("rejects integration entry with empty id", () => {
    expect(validate({ integrations: [{ id: "", path: "./x" }] })).toBe(false);
  });

  test("rejects max_ttl less than 1", () => {
    expect(validate({ integrations: [{ id: "x", path: "./x", max_ttl: 0 }] })).toBe(false);
  });

  test("rejects unknown fields on integration entry", () => {
    expect(validate({
      integrations: [{ id: "x", path: "./x", unknown: "field" }],
    })).toBe(false);
  });

  test("rejects unknown root fields", () => {
    expect(validate({ integrations: [], extra: true })).toBe(false);
  });
});
