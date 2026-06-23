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

// ── registry entry schema validation (registry.d/<id>.registry.json) ──────────
// registry.json (a single array-wrapped file) no longer exists — replaced by
// registry.d/, one file per integration, validated against this per-entry
// schema. These tests exercise the schema shape directly.

describe("registry-entry schema shape", () => {
  let validate;

  beforeAll(async () => {
    const { readFile }  = await import("fs/promises");
    const { resolve }   = await import("path");
    const { fileURLToPath } = await import("url");
    const Ajv           = (await import("ajv")).default;

    const testDir    = resolve(fileURLToPath(import.meta.url), "..");
    const schemaPath = resolve(testDir, "../../manager/schemas/registry-entry.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf-8"));
    const ajv    = new Ajv({ allErrors: true });
    validate     = ajv.compile(schema);
  });

  test("accepts a minimal valid entry", () => {
    expect(validate({ id: "my-integration", path: "./my-integration" })).toBe(true);
  });

  test("accepts a fully-populated entry", () => {
    expect(validate({
      id:          "my-integration",
      path:        "./my-integration",
      enabled:     true,
      description: "Does a thing",
      schedule:    "*/5 * * * *",
      max_ttl:     240,
    })).toBe(true);
  });

  test("rejects env_file — PM2-managed processes always use .env, no override", () => {
    expect(validate({
      id:       "my-integration",
      path:     "./my-integration",
      env_file: ".env.dev",
    })).toBe(false);
  });

  test("rejects an entry missing id", () => {
    expect(validate({ path: "./x" })).toBe(false);
  });

  test("rejects an entry missing path", () => {
    expect(validate({ id: "x" })).toBe(false);
  });

  test("rejects an entry with empty id", () => {
    expect(validate({ id: "", path: "./x" })).toBe(false);
  });

  test("rejects an entry with empty path", () => {
    expect(validate({ id: "x", path: "" })).toBe(false);
  });

  test("rejects max_ttl less than 1", () => {
    expect(validate({ id: "x", path: "./x", max_ttl: 0 })).toBe(false);
  });

  test("rejects unknown fields", () => {
    expect(validate({ id: "x", path: "./x", unknown: "field" })).toBe(false);
  });

  test("rejects a wrapped { integrations: [...] } document — that shape no longer exists", () => {
    expect(validate({ integrations: [{ id: "x", path: "./x" }] })).toBe(false);
  });
});
