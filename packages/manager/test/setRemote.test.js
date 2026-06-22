// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm } from "fs/promises";
import { tmpdir }      from "os";
import { join }        from "path";
import { execSync }    from "child_process";

import { setRemote }    from "../src/commands/setRemote.js";
import { publishEntry } from "../src/registryStorage.js";

describe("set-remote", () => {
  let cwd, liveDir;

  beforeEach(async () => {
    cwd     = await mkdtemp(join(tmpdir(), "integra-setremote-test-"));
    liveDir = join(cwd, ".integrations", "my-int", "live");
    execSync(`mkdir -p ${liveDir}`);
    execSync("git init", { cwd: liveDir, stdio: "ignore" });

    await publishEntry(cwd, "my-int", { id: "my-int", path: "./.integrations/my-int/live" });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("throws when id or url is missing", async () => {
    await expect(setRemote(undefined, "url", { cwd })).rejects.toThrow(/usage/i);
    await expect(setRemote("my-int", undefined, { cwd })).rejects.toThrow(/usage/i);
  });

  test("throws when the id is not registered", async () => {
    await expect(setRemote("nonexistent", "git@example.com:x.git", { cwd }))
      .rejects.toThrow(/not registered/i);
  });

  test("sets origin when none exists yet", async () => {
    const result = await setRemote("my-int", "git@example.com:my-int.git", { cwd });
    expect(result.replaced).toBe(false);

    const url = execSync("git remote get-url origin", { cwd: liveDir, encoding: "utf-8" }).trim();
    expect(url).toBe("git@example.com:my-int.git");
  });

  test("updates origin when one already exists, and reports the previous value", async () => {
    await setRemote("my-int", "git@example.com:old.git", { cwd });
    const result = await setRemote("my-int", "git@example.com:new.git", { cwd });

    expect(result.replaced).toBe(true);
    expect(result.previousUrl).toBe("git@example.com:old.git");

    const url = execSync("git remote get-url origin", { cwd: liveDir, encoding: "utf-8" }).trim();
    expect(url).toBe("git@example.com:new.git");
  });
});
