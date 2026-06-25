// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { buildScaffoldGuide } from "../src/scaffoldGuide.js";

describe("buildScaffoldGuide", () => {
  const baseParams = {
    id:      "my-integration",
    liveDir: "/srv/integra/.integrations/my-integration/live",
    osUser:  "deploy",
  };

  test("with a resolved host, embeds a real clone command", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).toContain("git clone deploy@203.0.113.5:/srv/integra/.integrations/my-integration/live my-integration");
  });

  test("with host=null, shows only the general clone form — no computed e.g. block, never embedding null/undefined literally", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: null });
    expect(guide).toContain("git clone <user>@<host>:<path> <local-folder-name>");
    expect(guide).not.toContain("nullnull");
    expect(guide).not.toContain("undefined");
    // No computed clone example at all when host couldn't be resolved —
    // every "git clone" line must still contain the <user>/<host>
    // placeholders, never a real, specific value.
    const cloneLines = guide.split("\n").filter(l => l.includes("git clone"));
    cloneLines.forEach(l => expect(l).toMatch(/<user>@<host>/));
  });

  test("mentions the live/ path so the developer knows not to edit it directly", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).toContain(baseParams.liveDir);
  });

  test("includes the correctly-named deploy command for this id", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).toContain("integra-manager deploy my-integration --branch my-patch");
  });

  test("explains that nothing local is verified until pushed", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide.toLowerCase()).toMatch(/nothing local is .?seen.? until pushed/);
  });

  test("includes the listener-resident-process warning, in one line, without naming PM2/Fastify", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide.toLowerCase()).toContain("listener");
    expect(guide.toLowerCase()).toMatch(/keeps? running until you stop it/);
    // The guide is action-oriented, not architectural — it should not name
    // the underlying implementation (that's the README's job).
    expect(guide).not.toMatch(/PM2|Fastify/i);
  });

  test("includes the push-before-trying-branch gotcha", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide.toLowerCase()).toContain("push");
  });

  // ── Structural properties specifically requested for this guide ───────────

  test("every fenced command block introduced by 'e.g.:' is preceded by a general (placeholder) form", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    const lines = guide.split("\n");

    lines.forEach((line, i) => {
      if (line.trim() === "e.g.:") {
        // The nearest preceding fenced block (searching backward) must be
        // the GENERAL form — i.e. it should contain a placeholder token
        // like <id> or <name>, not already be a fully computed command.
        let j = i - 1;
        while (j >= 0 && !lines[j].includes("```")) j--;
        // j now points at the closing ``` of the general block above e.g.:
        let generalBlock = [];
        let k = j - 1;
        while (k >= 0 && !lines[k].includes("```")) { generalBlock.unshift(lines[k]); k--; }
        const generalText = generalBlock.join("\n");
        expect(generalText).toMatch(/<[a-zA-Z-]+>/);
      }
    });
  });

  test("links to the real, public README, not a placeholder", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).toContain("https://github.com/ciacob/integra#readme");
  });

  test("mentions 'live' only for the literal required path, not as a recurring concept", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    const liveMentions = guide.match(/live/gi) ?? [];
    // Two unavoidable literal occurrences: the opening sentence's path,
    // and the clone command's own path (same path, both required verbatim).
    expect(liveMentions.length).toBeLessThanOrEqual(3);
  });

  test("does not narrate or justify why --id/--branch are mandatory — only shows the working commands", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).not.toMatch(/deliberate/i);
    expect(guide).not.toMatch(/this is (by )?design/i);
    expect(guide).not.toMatch(/no mode that (runs|operates)/i);
  });

  test("has no 'Gotchas' section — notes live inline, next to the step they apply to", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).not.toMatch(/^#.*gotcha/im);
  });

  test("every step in the numbered workflow is a checklist heading, not a documentation chapter title", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    const headings = guide.match(/^##\s+.+$/gm) ?? [];
    const numbered = headings.filter(h => /^##\s+\d+\./.test(h));
    expect(numbered.length).toBeGreaterThanOrEqual(5); // clone, dev setup, build/push/verify, promote, patch (undo is a 6th, also numbered)
  });

  // ── Where each command runs ─────────────────────────────────────────────────

  test("explicitly says the clone happens on your own machine, not the SSH session used to set this up", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide.toLowerCase()).toMatch(/not over the ssh session/);
    expect(guide.toLowerCase()).toContain("no editor or ide on the host");
  });

  test("the auto-detected host gets a 'may be wrong' note, distinct from the host-absent case", () => {
    const withHost = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(withHost.toLowerCase()).toMatch(/auto-detected and may be wrong/);

    const withoutHost = buildScaffoldGuide({ ...baseParams, host: null });
    expect(withoutHost.toLowerCase()).not.toMatch(/auto-detected and may be wrong/);
    expect(withoutHost.toLowerCase()).toMatch(/couldn'?t auto-detect/);
  });

  test("says clone access isn't guaranteed by SSH access alone, not just push access", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide.toLowerCase()).toMatch(/clone and push/);
  });

  test("every transition between 'your own machine' and 'the host, over SSH' is explicitly labeled", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    const lines = guide.split("\n").map(l => l.trim());

    // Walk the document tracking which zone we're nominally in, based on
    // the explicit labels; flag any git command found while the most
    // recent label claims we're on the host (over SSH), and any
    // integra/integra-manager command found while the most recent label
    // claims we're on the developer's own machine.
    let zone = null; // "local" | "host" | null (before the first label)
    const violations = [];

    for (const line of lines) {
      if (line === "**On your own machine:**") { zone = "local"; continue; }
      if (line === "**Back on the host, over SSH:**") { zone = "host"; continue; }

      if (zone === "host" && /^git (clone|checkout|add|commit|push)\b/.test(line)) {
        violations.push(`git command while labeled "host": ${line}`);
      }
      if (zone === "local" && /^integra(-manager)? /.test(line)) {
        violations.push(`integra command while labeled "local": ${line}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test("at least one explicit zone label appears before every git command and every integra(-manager) command", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    const lines = guide.split("\n").map(l => l.trim());

    let sawAnyLabel = false;
    const violations = [];

    for (const line of lines) {
      if (line === "**On your own machine:**" || line === "**Back on the host, over SSH:**") {
        sawAnyLabel = true;
        continue;
      }
      const isCommand = /^git (clone|checkout|add|commit|push)\b/.test(line) || /^integra(-manager)? /.test(line);
      if (isCommand && !sawAnyLabel) {
        violations.push(`command before any zone label: ${line}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
