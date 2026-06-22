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

  test("includes the --branch requires --env gotcha", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).toMatch(/--branch.*requires.*--env/is);
  });

  test("includes the listener-resident-process warning", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide).toMatch(/resident.*Fastify|Fastify.*resident/is);
  });

  test("includes the push-before-trying-branch gotcha", () => {
    const guide = buildScaffoldGuide({ ...baseParams, host: "203.0.113.5" });
    expect(guide.toLowerCase()).toContain("push");
  });
});
