// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/setup.test.js
 *
 * `integra setup` always operates against the real, fixed home
 * (/opt/integra) — by design, it has no override parameter, the same way
 * resolveIntegraHome() itself takes none. That means this suite cannot
 * exercise its full happy path (a real mkdir into /opt/integra) without
 * writing into a real system path as a side effect of running tests,
 * which it must not do.
 *
 * What's testable without touching /opt:
 *   - the permission-denied path, by mocking fs/promises' mkdir to throw
 *     EACCES — a pure error-message test that locks in the friendly
 *     "run as sudo" message instead of a raw stack trace.
 *   - that chmod(home, 0o777) is actually called as its own step after
 *     mkdir — mkdir's own `mode` option is masked by the process umask
 *     (confirmed directly: 0o777 there silently becomes 0o755 under the
 *     common 0022 umask), so an explicit chmod is the only reliable way
 *     to guarantee 0o777, and that's worth locking in directly rather
 *     than trusting mkdir's mode option to do it.
 */

import { jest } from "@jest/globals";

const mockMkdir = jest.fn();
const mockChmod = jest.fn();
const mockReadHomeConfig  = jest.fn();
const mockWriteHomeConfig = jest.fn();

jest.unstable_mockModule("fs/promises", async () => {
  const real = await import("node:fs/promises");
  return { ...real, mkdir: mockMkdir, chmod: mockChmod };
});

jest.unstable_mockModule("@int3gra/manager/home", () => ({
  resolveIntegraHome:  () => "/opt/integra",
  readHomeConfig:      mockReadHomeConfig,
  writeHomeConfig:     mockWriteHomeConfig,
}));

const { setup } = await import("../src/commands/setup.js");

beforeEach(() => {
  mockMkdir.mockReset();
  mockChmod.mockReset();
  mockReadHomeConfig.mockReset();
  mockWriteHomeConfig.mockReset();
  mockMkdir.mockResolvedValue(undefined);
  mockChmod.mockResolvedValue(undefined);
  mockReadHomeConfig.mockResolvedValue(null);   // "not set up yet" by default
  mockWriteHomeConfig.mockResolvedValue(undefined);
});

test("surfaces a clear 'run as sudo' message on EACCES, not a raw stack trace", async () => {
  const err = new Error("permission denied");
  err.code = "EACCES";
  mockMkdir.mockRejectedValue(err);

  await expect(setup()).rejects.toThrow(/run 'integra setup' as root/i);
});

test("surfaces a clear 'run as sudo' message on EPERM too", async () => {
  const err = new Error("operation not permitted");
  err.code = "EPERM";
  mockMkdir.mockRejectedValue(err);

  await expect(setup()).rejects.toThrow(/run 'integra setup' as root/i);
});

test("re-throws unrelated mkdir errors unchanged", async () => {
  const err = new Error("disk full");
  err.code = "ENOSPC";
  mockMkdir.mockRejectedValue(err);

  await expect(setup()).rejects.toThrow("disk full");
});

test("chmod's 0o777 explicitly after mkdir, rather than relying on mkdir's mode option (which the umask would mask)", async () => {
  await setup();
  expect(mockChmod).toHaveBeenCalledWith("/opt/integra", 0o777);
  // mkdir must not be relying on a `mode` option either — chmod is the
  // one and only thing responsible for the final permission bits.
  expect(mockMkdir.mock.calls[0][1]).not.toHaveProperty("mode");
});

test("an EACCES from chmod (not just mkdir) also surfaces the 'run as sudo' message", async () => {
  const err = new Error("permission denied");
  err.code = "EACCES";
  mockChmod.mockRejectedValue(err);

  await expect(setup()).rejects.toThrow(/run 'integra setup' as root/i);
});

test("writes a fresh config.json when none exists yet", async () => {
  mockReadHomeConfig.mockResolvedValue(null);
  await setup();
  expect(mockWriteHomeConfig).toHaveBeenCalledWith({}, "/opt/integra");
});

test("never overwrites an existing config.json — true no-op on repeated runs", async () => {
  mockReadHomeConfig.mockResolvedValue({ someExistingSetting: true });
  await setup();
  expect(mockWriteHomeConfig).not.toHaveBeenCalled();
});
