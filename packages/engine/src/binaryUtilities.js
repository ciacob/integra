/**
 * @integra/engine - binaryUtilities.js
 *
 * Pure, tested utility functions for binary content transfer.
 * Used internally by the engine for body_type and response_type handling,
 * and exported for connector authors to import directly.
 *
 * Design principles:
 *   - Every function is pure or has all side-effectful dependencies injected
 *   - I/O dependencies (fs, fetch, crypto) are injectable for testing
 *   - No global state
 *
 * Attachment delegatees (the 98% case):
 *   receiveAttachment        — full inbound pipeline: idempotency check → write to disk → return record
 *   prepareAttachmentUpload  — full outbound pipeline: read from disk → detect MIME → return upload-ready object
 *   buildMultipartFields     — builds the metadata fields object for a multipart upload
 *
 * Lower-level utilities (for custom resolver logic):
 *   writeBufferToDisk        — writes a Buffer to a file, returns the full path
 *   readFileAsBuffer         — reads a file into a Buffer
 *   detectMimeType           — best-effort MIME from magic bytes + filename extension
 *   parseResponseMeta        — extracts attachment metadata from response headers
 *   checkIdempotency         — pure: checks a registry object for a known key
 *   registerIdempotency      — pure: returns a new registry with the key added
 *   buildBinaryOutput        — pure: builds the ctx.output shape for binary responses
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

// ── MIME type helpers ─────────────────────────────────────────────────────────

const EXTENSION_MIME = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".pdf":  "application/pdf",
  ".zip":  "application/zip",
  ".txt":  "text/plain",
  ".csv":  "text/csv",
  ".json": "application/json",
  ".xml":  "application/xml",
  ".doc":  "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls":  "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Magic byte signatures for common formats
const MAGIC_BYTES = [
  { bytes: [0xFF, 0xD8, 0xFF],             mime: "image/jpeg"       },
  { bytes: [0x89, 0x50, 0x4E, 0x47],       mime: "image/png"        },
  { bytes: [0x47, 0x49, 0x46],             mime: "image/gif"        },
  { bytes: [0x52, 0x49, 0x46, 0x46],       mime: "image/webp"       }, // also wav/avi, but webp most common
  { bytes: [0x25, 0x50, 0x44, 0x46],       mime: "application/pdf"  },
  { bytes: [0x50, 0x4B, 0x03, 0x04],       mime: "application/zip"  },
];

/**
 * Best-effort MIME type detection from magic bytes and/or filename extension.
 * Magic bytes take precedence over extension.
 * Returns "application/octet-stream" when neither matches.
 * Pure.
 *
 * @param {Buffer|null}  buffer    file bytes (or null to skip magic byte check)
 * @param {string|null}  filename  filename with extension (or null)
 * @returns {string}
 */
export function detectMimeType(buffer = null, filename = null) {
  // Try magic bytes first
  if (buffer && buffer.length >= 4) {
    for (const { bytes, mime } of MAGIC_BYTES) {
      if (bytes.every((b, i) => buffer[i] === b)) return mime;
    }
  }

  // Fall back to extension
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (EXTENSION_MIME[ext]) return EXTENSION_MIME[ext];
  }

  return "application/octet-stream";
}

// ── Response metadata parsing ─────────────────────────────────────────────────

/**
 * Parses attachment metadata from response headers.
 * Handles ServiceNow's X-Attachment-Metadata header and standard headers.
 * Pure.
 *
 * @param {object} headers  response headers as a plain object (lowercased keys)
 * @returns {object}        { file_name?, content_type?, size?, hash?, raw }
 */
export function parseResponseMeta(headers = {}) {
  const meta = { raw: headers };

  // Standard headers
  meta.content_type = headers["content-type"]   ?? null;
  meta.size         = headers["content-length"]
    ? parseInt(headers["content-length"], 10)
    : null;

  // ServiceNow X-Attachment-Metadata (JSON string)
  const snMeta = headers["x-attachment-metadata"];
  if (snMeta) {
    try {
      const parsed    = JSON.parse(snMeta);
      meta.file_name  = parsed.file_name  ?? parsed.fileName  ?? null;
      meta.hash       = parsed.hash       ?? null;
      meta.size       = parsed.size       ?? meta.size;
      meta.content_type = parsed.content_type ?? parsed.contentType ?? meta.content_type;
    } catch { /* malformed — skip */ }
  }

  // Content-Disposition: attachment; filename="foo.png"
  const disposition = headers["content-disposition"];
  if (disposition && !meta.file_name) {
    const match = disposition.match(/filename="?([^";\n]+)"?/i);
    if (match) meta.file_name = match[1].trim();
  }

  return meta;
}

// ── Pure binary output builder ────────────────────────────────────────────────

/**
 * Builds the ctx.output object for a binary response.
 * The buffer is in-memory only — never serialised to shared space.
 * The meta object is serialisable and safe to store.
 * Pure.
 *
 * @param {Buffer} buffer
 * @param {object} meta           from parseResponseMeta
 * @param {string} idempotencyKey extracted value (or null)
 * @returns {{ buffer, meta, idempotency_key }}
 */
export function buildBinaryOutput(buffer, meta, idempotencyKey = null) {
  return {
    buffer,
    meta: {
      file_name:    meta.file_name    ?? null,
      content_type: meta.content_type ?? null,
      size:         meta.size         ?? buffer?.length ?? null,
      hash:         meta.hash         ?? null,
    },
    idempotency_key: idempotencyKey,
  };
}

// ── Idempotency registry (pure) ───────────────────────────────────────────────

/**
 * Checks whether a key is already registered.
 * Pure — does not read shared space.
 *
 * @param {object}      registry  plain object keyed by idempotency key
 * @param {string|null} key
 * @returns {object|null}  the existing record, or null
 */
export function checkIdempotency(registry, key) {
  if (!key || !registry) return null;
  return registry[key] ?? null;
}

/**
 * Returns a new registry with the key registered.
 * Pure — does not mutate the input.
 *
 * @param {object} registry
 * @param {string} key
 * @param {object} record     serialisable attachment record
 * @returns {object}
 */
export function registerIdempotency(registry, key, record) {
  if (!key) return registry;
  return { ...registry, [key]: record };
}

// ── Filesystem I/O (injectable) ───────────────────────────────────────────────

/**
 * Writes a Buffer to disk, creating the directory if needed.
 * Returns the full path of the written file.
 *
 * @param {Buffer}   buffer
 * @param {string}   dir        target directory
 * @param {string}   filename   target filename
 * @param {object}   [options]  { overwrite: boolean }
 * @param {object}   [fsMod]    injectable fs/promises (for testing)
 * @returns {Promise<string>}   absolute path of written file
 */
export async function writeBufferToDisk(buffer, dir, filename, options = {}, fsMod = null) {
  const { mkdir, writeFile, access } = fsMod ?? await import("fs/promises");
  const { resolve, join }            = await import("path");
  const { overwrite = false }        = options;

  const absDir  = resolve(dir);
  const absPath = join(absDir, filename);

  await mkdir(absDir, { recursive: true });

  if (!overwrite) {
    try {
      await access(absPath);
      // File exists — skip write, return path
      return absPath;
    } catch { /* does not exist — proceed */ }
  }

  await writeFile(absPath, buffer);
  return absPath;
}

/**
 * Reads a file from disk into a Buffer.
 *
 * @param {string} filePath
 * @param {object} [fsMod]   injectable fs/promises (for testing)
 * @returns {Promise<Buffer>}
 */
export async function readFileAsBuffer(filePath, fsMod = null) {
  const { readFile } = fsMod ?? await import("fs/promises");
  return readFile(filePath);
}

// ── Multipart form builder ────────────────────────────────────────────────────

/**
 * Builds a FormData body for a multipart file upload.
 * Returns { formData, contentType } where contentType includes the boundary.
 *
 * @param {object} fields      plain object of metadata fields to append first
 * @param {Buffer} fileBuffer  the file bytes
 * @param {string} fileField   the form field name for the file (e.g. "file")
 * @param {string} fileName    the filename to declare in the form
 * @param {string} mimeType    the MIME type of the file
 * @returns {{ formData: FormData, contentType: string }}
 */
export function buildMultipartBody(fields, fileBuffer, fileField, fileName, mimeType) {
  const formData = new FormData();

  // Metadata fields first — required by ServiceNow and most multipart endpoints
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined && value !== null) {
      formData.append(key, String(value));
    }
  }

  // File content last
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append(fileField ?? "file", blob, fileName);

  // FormData sets Content-Type with boundary automatically when passed to fetch
  return { formData };
}

/**
 * Builds the metadata fields object for a multipart attachment upload.
 * Covers ServiceNow (/now/attachment/upload) and Jira (/rest/api/3/issue/{id}/attachments).
 * Pure.
 *
 * @param {object} uploadRecord   { file_name, content_type, size, ... }
 * @param {object} tableInfo      { table_name, table_sys_id } for SN; { issue_id } for Jira
 * @returns {object}
 */
export function buildMultipartFields(uploadRecord, tableInfo = {}) {
  return {
    ...(tableInfo.table_name   ? { table_name:   tableInfo.table_name   } : {}),
    ...(tableInfo.table_sys_id ? { table_sys_id: tableInfo.table_sys_id } : {}),
    ...(tableInfo.issue_id     ? { issue_id:     tableInfo.issue_id     } : {}),
    file_name:    uploadRecord.file_name    ?? null,
    content_type: uploadRecord.content_type ?? null,
  };
}

// ── Attachment delegatees (the 98% case) ──────────────────────────────────────

/**
 * Full inbound attachment pipeline.
 * Checks idempotency, writes buffer to disk, registers the key, returns a
 * serialisable attachment record.
 *
 * Call from a resolver function that handles a binary GET response:
 *   export async function myStore(ctx) {
 *     const record = await receiveAttachment(ctx, { dir: "attachments" });
 *     ctx._shared.set("attachment", record);
 *     return record;
 *   }
 *
 * @param {object}  ctx
 * @param {object}  [options]
 * @param {string}  [options.dir]              storage directory (default: "attachments")
 * @param {boolean} [options.use_idempotency]  default true
 * @param {boolean} [options.overwrite]        default false
 * @param {object}  [options.fsMod]            injectable fs/promises
 * @returns {Promise<object>}  serialisable attachment record
 */
export async function receiveAttachment(ctx, options = {}) {
  const {
    dir             = "attachments",
    use_idempotency = true,
    overwrite       = false,
    fsMod           = null,
  } = options;

  const { buffer, meta, idempotency_key } = ctx.output ?? {};

  if (!buffer) throw new Error("receiveAttachment: ctx.output.buffer is missing");

  const registryKey = "_attachment_idempotency";
  const registry    = ctx._shared.get(registryKey) ?? {};

  // Idempotency check — skip write if we've seen this key before
  if (use_idempotency && idempotency_key) {
    const existing = checkIdempotency(registry, idempotency_key);
    if (existing) {
      ctx.logger.info("binary.attachment_skipped", {
        idempotency_key,
        file_path: existing.file_path,
        ...ctx.meta,
      });
      return existing;
    }
  }

  const fileName  = meta?.file_name ?? `attachment_${Date.now()}`;
  const mimeType  = meta?.content_type ?? detectMimeType(buffer, fileName);
  const filePath  = await writeBufferToDisk(buffer, dir, fileName, { overwrite }, fsMod);

  const record = {
    file_path:       filePath,
    file_name:       fileName,
    content_type:    mimeType,
    size:            buffer.length,
    hash:            meta?.hash         ?? null,
    idempotency_key: idempotency_key    ?? null,
    received_at:     new Date().toISOString(),
  };

  // Register idempotency key
  if (use_idempotency && idempotency_key) {
    ctx._shared.set(registryKey, registerIdempotency(registry, idempotency_key, record));
  }

  ctx.logger.info("binary.attachment_received", {
    file_name: fileName,
    size:      record.size,
    idempotency_key: idempotency_key ?? null,
    ...ctx.meta,
  });

  return record;
}

/**
 * Full outbound attachment pipeline.
 * Reads a file from disk, detects MIME, returns an upload-ready object for
 * the connection component to pick up via binary_info.source_bytes.
 *
 * Call from a resolver function that prepares a binary POST or multipart upload:
 *   export async function myPrepare(ctx) {
 *     const upload = await prepareAttachmentUpload(ctx);
 *     ctx._shared.set("attachment_buffer", upload.buffer);
 *     ctx._shared.set("attachment_meta",   upload);
 *   }
 *
 * @param {object}  ctx
 * @param {object}  [options]
 * @param {string}  [options.file_path]   override ctx.input.file_path
 * @param {string}  [options.file_name]   override ctx.input.file_name
 * @param {string}  [options.mime_type]   override detected MIME
 * @param {object}  [options.fsMod]       injectable fs/promises
 * @returns {Promise<{ buffer, file_name, content_type, size }>}
 */
export async function prepareAttachmentUpload(ctx, options = {}) {
  const {
    file_path = ctx.input?.file_path ?? null,
    file_name = ctx.input?.file_name ?? null,
    mime_type = null,
    fsMod     = null,
  } = options;

  if (!file_path) throw new Error("prepareAttachmentUpload: file_path is required");

  const { basename } = await import("path");
  const resolvedName = file_name ?? basename(file_path);
  const buffer       = await readFileAsBuffer(file_path, fsMod);
  const contentType  = mime_type ?? detectMimeType(buffer, resolvedName);

  ctx.logger.info("binary.attachment_prepared", {
    file_name: resolvedName,
    size:      buffer.length,
    content_type: contentType,
    ...ctx.meta,
  });

  return {
    buffer,
    file_name:    resolvedName,
    content_type: contentType,
    size:         buffer.length,
  };
}
