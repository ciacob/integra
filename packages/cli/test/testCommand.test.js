// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/testCommand.test.js
 *
 * Unit tests for the pure helpers in the test command.
 * No filesystem, no network, no engine.
 */

import { resolveResponseFixture } from "../src/commands/test.js";

// ── resolveResponseFixture ────────────────────────────────────────────────────

describe("resolveResponseFixture", () => {
  const ONE_FILE    = ["/fixtures/responses/single.json"];
  const TWO_FILES   = ["/fixtures/responses/a.json", "/fixtures/responses/b.json"];
  const URL_SN      = "https://devXXXXX.service-now.com/api/now/table/incident";
  const URL_JIRA    = "https://org.atlassian.net/rest/api/3/issue";

  // Injectable exists function — always returns true for unit tests
  const existsAlways = () => true;
  // Injectable exists function — always returns false (simulates missing file)
  const existsNever  = () => false;

  // ── Single fixture ──────────────────────────────────────────────────────────

  test("returns the single file for any URL when only one fixture exists", () => {
    expect(resolveResponseFixture(URL_SN, null, ONE_FILE)).toBe(ONE_FILE[0]);
  });

  test("returns the single file even when a map is provided", () => {
    const map = { [URL_SN]: "/fixtures/responses/other.json" };
    expect(resolveResponseFixture(URL_SN, map, ONE_FILE)).toBe(ONE_FILE[0]);
  });

  // ── No fixtures ─────────────────────────────────────────────────────────────

  test("throws when no fixture files exist", () => {
    expect(() => resolveResponseFixture(URL_SN, null, []))
      .toThrow("No response fixtures found");
  });

  // ── Multiple fixtures, no map ───────────────────────────────────────────────

  test("throws when multiple fixtures exist but no map", () => {
    expect(() => resolveResponseFixture(URL_SN, null, TWO_FILES))
      .toThrow(".fixture-map.json");
  });

  // ── Multiple fixtures with map ──────────────────────────────────────────────

  test("returns the mapped file for a matching URL", () => {
    const map = { [URL_SN]: "/fixtures/responses/a.json" };
    expect(resolveResponseFixture(URL_SN, map, TWO_FILES, existsAlways))
      .toBe("/fixtures/responses/a.json");
  });

  test("supports prefix matching — longer URL path matches base URL key", () => {
    const baseUrl = "https://devXXXXX.service-now.com/api/now/table/incident";
    const fullUrl = "https://devXXXXX.service-now.com/api/now/table/incident?sysparm_limit=10";
    const map     = { [baseUrl]: "/fixtures/responses/a.json" };
    expect(resolveResponseFixture(fullUrl, map, TWO_FILES, existsAlways))
      .toBe("/fixtures/responses/a.json");
  });

  test("throws with the unmatched URL when no map entry exists", () => {
    const map = { [URL_SN]: "/fixtures/responses/a.json" };
    expect(() => resolveResponseFixture(URL_JIRA, map, TWO_FILES, existsAlways))
      .toThrow(URL_JIRA);
  });

  test("throws when mapped file does not exist on disk", () => {
    const map = { [URL_SN]: "/nonexistent/path/fixture.json" };
    expect(() => resolveResponseFixture(URL_SN, map, TWO_FILES, existsNever))
      .toThrow("does not exist");
  });

  test("error message names the missing file", () => {
    const map = { [URL_SN]: "/nonexistent/fixture.json" };
    let msg = "";
    try { resolveResponseFixture(URL_SN, map, TWO_FILES, existsNever); } catch (e) { msg = e.message; }
    expect(msg).toContain("fixture.json");
  });

  test("first matching entry in map wins (order-sensitive)", () => {
    // Both keys would prefix-match the URL, but first wins
    const map = {
      "https://devXXXXX.service-now.com/api/now/table/incident": "/fixtures/responses/a.json",
      "https://devXXXXX.service-now.com/api/now":                "/fixtures/responses/b.json",
    };
    expect(resolveResponseFixture(URL_SN, map, TWO_FILES, existsAlways))
      .toBe("/fixtures/responses/a.json");
  });
});
