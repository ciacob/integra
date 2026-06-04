/**
 * packages/engine/test/binaryUtilities.test.js
 *
 * Unit tests for binaryUtilities.js.
 * All I/O is injected — no real filesystem access except in the
 * writeBufferToDisk / readFileAsBuffer integration tests which use tmp dirs.
 */

import { mkdtemp, rm }   from "fs/promises";
import { tmpdir }         from "os";
import { join }           from "path";
import {
  detectMimeType,
  parseResponseMeta,
  buildBinaryOutput,
  checkIdempotency,
  registerIdempotency,
  buildMultipartFields,
  writeBufferToDisk,
  readFileAsBuffer,
  receiveAttachment,
  prepareAttachmentUpload,
} from "../src/binaryUtilities.js";

// ── detectMimeType ────────────────────────────────────────────────────────────

describe("detectMimeType", () => {
  test("detects JPEG from magic bytes", () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    expect(detectMimeType(buf)).toBe("image/jpeg");
  });

  test("detects PNG from magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D]);
    expect(detectMimeType(buf)).toBe("image/png");
  });

  test("detects PDF from magic bytes", () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);
    expect(detectMimeType(buf)).toBe("application/pdf");
  });

  test("falls back to extension when magic bytes don't match", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeType(buf, "report.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  test("returns octet-stream when neither matches", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectMimeType(buf, "unknown.xyz")).toBe("application/octet-stream");
  });

  test("works with null buffer (extension only)", () => {
    expect(detectMimeType(null, "file.pdf")).toBe("application/pdf");
  });

  test("works with null filename (magic bytes only)", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00]);
    expect(detectMimeType(buf, null)).toBe("image/png");
  });

  test("magic bytes take precedence over extension", () => {
    // PNG magic bytes but .pdf extension
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00]);
    expect(detectMimeType(buf, "file.pdf")).toBe("image/png");
  });

  test("is case-insensitive for extension", () => {
    expect(detectMimeType(null, "IMAGE.PNG")).toBe("image/png");
  });
});

// ── parseResponseMeta ─────────────────────────────────────────────────────────

describe("parseResponseMeta", () => {
  test("extracts content-type from standard header", () => {
    const meta = parseResponseMeta({ "content-type": "image/jpeg" });
    expect(meta.content_type).toBe("image/jpeg");
  });

  test("extracts size from content-length", () => {
    const meta = parseResponseMeta({ "content-length": "14523" });
    expect(meta.size).toBe(14523);
  });

  test("parses ServiceNow X-Attachment-Metadata header", () => {
    const snMeta = JSON.stringify({
      file_name: "screenshot.png",
      hash:      "abc123",
      size:      8192,
    });
    const meta = parseResponseMeta({ "x-attachment-metadata": snMeta });
    expect(meta.file_name).toBe("screenshot.png");
    expect(meta.hash).toBe("abc123");
    expect(meta.size).toBe(8192);
  });

  test("extracts filename from Content-Disposition header", () => {
    const meta = parseResponseMeta({
      "content-disposition": 'attachment; filename="report.pdf"',
    });
    expect(meta.file_name).toBe("report.pdf");
  });

  test("X-Attachment-Metadata takes precedence over Content-Disposition for filename", () => {
    const snMeta = JSON.stringify({ file_name: "from-sn.png" });
    const meta   = parseResponseMeta({
      "x-attachment-metadata":  snMeta,
      "content-disposition":    'attachment; filename="from-disposition.png"',
    });
    expect(meta.file_name).toBe("from-sn.png");
  });

  test("returns empty meta for empty headers", () => {
    const meta = parseResponseMeta({});
    expect(meta.content_type).toBeNull();
    expect(meta.size).toBeNull();
    expect(meta.file_name).toBeUndefined();
  });

  test("survives malformed X-Attachment-Metadata without throwing", () => {
    expect(() =>
      parseResponseMeta({ "x-attachment-metadata": "not json" })
    ).not.toThrow();
  });

  test("preserves raw headers", () => {
    const headers = { "x-custom": "value" };
    expect(parseResponseMeta(headers).raw).toBe(headers);
  });
});

// ── buildBinaryOutput ─────────────────────────────────────────────────────────

describe("buildBinaryOutput", () => {
  const buf  = Buffer.from("hello");
  const meta = { file_name: "test.txt", content_type: "text/plain", size: 5, hash: "abc" };

  test("includes buffer", () => {
    expect(buildBinaryOutput(buf, meta).buffer).toBe(buf);
  });

  test("includes serialisable meta", () => {
    const out = buildBinaryOutput(buf, meta);
    expect(out.meta.file_name).toBe("test.txt");
    expect(out.meta.content_type).toBe("text/plain");
    expect(out.meta.size).toBe(5);
    expect(out.meta.hash).toBe("abc");
  });

  test("includes idempotency_key", () => {
    expect(buildBinaryOutput(buf, meta, "abc").idempotency_key).toBe("abc");
  });

  test("defaults idempotency_key to null", () => {
    expect(buildBinaryOutput(buf, meta).idempotency_key).toBeNull();
  });

  test("uses buffer.length for size when meta.size is absent", () => {
    const out = buildBinaryOutput(Buffer.from("hello"), { file_name: "f" });
    expect(out.meta.size).toBe(5);
  });

  test("does not mutate meta input", () => {
    const original = { ...meta };
    buildBinaryOutput(buf, meta, "key");
    expect(meta).toEqual(original);
  });
});

// ── checkIdempotency / registerIdempotency ────────────────────────────────────

describe("checkIdempotency", () => {
  const registry = { "abc123": { file_path: "/tmp/abc123.png" } };

  test("returns existing record for known key", () => {
    expect(checkIdempotency(registry, "abc123")).toEqual({ file_path: "/tmp/abc123.png" });
  });

  test("returns null for unknown key", () => {
    expect(checkIdempotency(registry, "unknown")).toBeNull();
  });

  test("returns null for null key", () => {
    expect(checkIdempotency(registry, null)).toBeNull();
  });

  test("returns null for null registry", () => {
    expect(checkIdempotency(null, "abc123")).toBeNull();
  });
});

describe("registerIdempotency", () => {
  test("adds a new key", () => {
    const result = registerIdempotency({}, "abc", { file_path: "/tmp/abc" });
    expect(result["abc"]).toEqual({ file_path: "/tmp/abc" });
  });

  test("does not mutate the input registry", () => {
    const registry = { "existing": {} };
    registerIdempotency(registry, "new", {});
    expect(Object.keys(registry)).toEqual(["existing"]);
  });

  test("returns registry unchanged for null key", () => {
    const registry = { "x": 1 };
    expect(registerIdempotency(registry, null, {})).toEqual({ "x": 1 });
  });
});

// ── buildMultipartFields ──────────────────────────────────────────────────────

describe("buildMultipartFields", () => {
  test("includes file_name and content_type from record", () => {
    const result = buildMultipartFields(
      { file_name: "shot.png", content_type: "image/png" },
      {}
    );
    expect(result.file_name).toBe("shot.png");
    expect(result.content_type).toBe("image/png");
  });

  test("includes ServiceNow table fields when provided", () => {
    const result = buildMultipartFields(
      { file_name: "f" },
      { table_name: "incident", table_sys_id: "abc123" }
    );
    expect(result.table_name).toBe("incident");
    expect(result.table_sys_id).toBe("abc123");
  });

  test("includes Jira issue_id when provided", () => {
    const result = buildMultipartFields(
      { file_name: "f" },
      { issue_id: "PROJ-42" }
    );
    expect(result.issue_id).toBe("PROJ-42");
  });

  test("omits absent table fields rather than setting null", () => {
    const result = buildMultipartFields({ file_name: "f" }, {});
    expect("table_name" in result).toBe(false);
    expect("table_sys_id" in result).toBe(false);
    expect("issue_id" in result).toBe(false);
  });

  test("pure — does not mutate inputs", () => {
    const record    = { file_name: "f", content_type: "text/plain" };
    const tableInfo = { table_name: "incident" };
    const origRecord    = { ...record };
    const origTableInfo = { ...tableInfo };
    buildMultipartFields(record, tableInfo);
    expect(record).toEqual(origRecord);
    expect(tableInfo).toEqual(origTableInfo);
  });
});

// ── writeBufferToDisk / readFileAsBuffer (with real tmp dir) ──────────────────

describe("writeBufferToDisk + readFileAsBuffer", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "integra-binary-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes buffer and reads it back correctly", async () => {
    const buf  = Buffer.from("hello binary world");
    const path = await writeBufferToDisk(buf, tmpDir, "test.txt");
    const back = await readFileAsBuffer(path);
    expect(back.equals(buf)).toBe(true);
  });

  test("creates missing directories", async () => {
    const buf  = Buffer.from("data");
    const path = await writeBufferToDisk(buf, join(tmpDir, "nested", "deep"), "file.bin");
    const back = await readFileAsBuffer(path);
    expect(back.equals(buf)).toBe(true);
  });

  test("skips write when file exists and overwrite is false", async () => {
    const buf1 = Buffer.from("original");
    const buf2 = Buffer.from("replacement");
    const path = await writeBufferToDisk(buf1, tmpDir, "f.txt");
    await writeBufferToDisk(buf2, tmpDir, "f.txt", { overwrite: false });
    const back = await readFileAsBuffer(path);
    expect(back.toString()).toBe("original");
  });

  test("overwrites when overwrite is true", async () => {
    const buf1 = Buffer.from("original");
    const buf2 = Buffer.from("replacement");
    const path = await writeBufferToDisk(buf1, tmpDir, "f.txt");
    await writeBufferToDisk(buf2, tmpDir, "f.txt", { overwrite: true });
    const back = await readFileAsBuffer(path);
    expect(back.toString()).toBe("replacement");
  });

  test("returns the full path of the written file", async () => {
    const path = await writeBufferToDisk(Buffer.from("x"), tmpDir, "out.bin");
    expect(path).toContain("out.bin");
    expect(path).toContain(tmpDir);
  });
});

// ── receiveAttachment ─────────────────────────────────────────────────────────

describe("receiveAttachment", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "integra-recv-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(outputOverrides = {}, sharedStore = {}) {
    const store = { ...sharedStore };
    return {
      output: {
        buffer:          Buffer.from("fake image bytes"),
        meta:            { file_name: "photo.jpg", content_type: "image/jpeg", size: 16, hash: null },
        idempotency_key: null,
        ...outputOverrides,
      },
      _shared: {
        get: k => store[k],
        set: (k, v) => { store[k] = v; },
        _store: store,
      },
      meta:    { runId: "t", stepId: "s" },
      logger:  { info: () => {}, warn: () => {}, error: () => {} },
    };
  }

  test("writes buffer to disk and returns serialisable record", async () => {
    const ctx    = makeCtx();
    const record = await receiveAttachment(ctx, { dir: tmpDir });
    expect(record.file_name).toBe("photo.jpg");
    expect(record.content_type).toBe("image/jpeg");
    expect(record.size).toBe(16);
    expect(record.file_path).toContain("photo.jpg");
    expect(record.received_at).toBeTruthy();
  });

  test("record contains no Buffer — is fully serialisable", async () => {
    const ctx    = makeCtx();
    const record = await receiveAttachment(ctx, { dir: tmpDir });
    expect(Buffer.isBuffer(record)).toBe(false);
    expect(JSON.stringify(record)).not.toThrow;
    // Verify no Buffer values in record
    for (const val of Object.values(record)) {
      expect(Buffer.isBuffer(val)).toBe(false);
    }
  });

  test("skips write on second call with same idempotency key", async () => {
    const ctx = makeCtx({ idempotency_key: "hash-abc" });
    const r1  = await receiveAttachment(ctx, { dir: tmpDir });
    const r2  = await receiveAttachment(ctx, { dir: tmpDir });
    expect(r1.file_path).toBe(r2.file_path);
    // Second call returned the cached record — no duplicate log
  });

  test("registers idempotency key in shared space", async () => {
    const ctx = makeCtx({ idempotency_key: "hash-xyz" });
    await receiveAttachment(ctx, { dir: tmpDir });
    const registry = ctx._shared._store["_attachment_idempotency"];
    expect(registry?.["hash-xyz"]).toBeDefined();
  });

  test("writes file with generated name when meta has no file_name", async () => {
    const ctx = makeCtx({ meta: { content_type: "image/jpeg", size: 16 } });
    const record = await receiveAttachment(ctx, { dir: tmpDir });
    expect(record.file_name).toMatch(/^attachment_\d+$/);
  });

  test("throws when buffer is missing", async () => {
    const ctx = makeCtx({ buffer: undefined });
    await expect(receiveAttachment(ctx, { dir: tmpDir })).rejects.toThrow("buffer");
  });
});

// ── prepareAttachmentUpload ───────────────────────────────────────────────────

describe("prepareAttachmentUpload", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "integra-prepare-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeFileCtx(content = "file content") {
    const { writeFile } = await import("fs/promises");
    const { join: pathJoin } = await import("path");
    const filePath = pathJoin(tmpDir, "sample.png");
    await writeFile(filePath, Buffer.from(content));
    return {
      input:  { file_path: filePath, file_name: "sample.png" },
      meta:   {},
      logger: { info: () => {} },
    };
  }

  test("returns buffer, file_name, content_type, size", async () => {
    const ctx    = await makeFileCtx();
    const result = await prepareAttachmentUpload(ctx);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.file_name).toBe("sample.png");
    expect(result.content_type).toBeTruthy();
    expect(result.size).toBeGreaterThan(0);
  });

  test("detects MIME from PNG magic bytes", async () => {
    const ctx = await makeFileCtx();
    // Write real PNG magic bytes
    const { writeFile } = await import("fs/promises");
    await writeFile(ctx.input.file_path, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00]));
    const result = await prepareAttachmentUpload(ctx);
    expect(result.content_type).toBe("image/png");
  });

  test("respects mime_type override", async () => {
    const ctx    = await makeFileCtx();
    const result = await prepareAttachmentUpload(ctx, { mime_type: "application/pdf" });
    expect(result.content_type).toBe("application/pdf");
  });

  test("throws when file_path is absent", async () => {
    const ctx = { input: {}, logger: { info: () => {} } };
    await expect(prepareAttachmentUpload(ctx)).rejects.toThrow("file_path");
  });

  test("size matches actual file content length", async () => {
    const content = "exactly this content";
    const ctx     = await makeFileCtx(content);
    const result  = await prepareAttachmentUpload(ctx);
    expect(result.size).toBe(Buffer.from(content).length);
  });
});
