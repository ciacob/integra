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

  test("with host=null, falls back to a placeholder clone command, never embedding null/undefined literally", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: null });
    expect(guide).toContain("git clone <user>@<this-host>:/srv/integra/.integrations/my-integration/live my-integration");
    expect(guide).not.toContain("nullnull");
    expect(guide).not.toContain("undefined");
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
});
