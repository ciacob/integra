// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/engine - listener.js
 *
 * Fastify-based HTTP listener for integrations with lifecycle: "listener".
 *
 * Responsibilities:
 *   - Starts a Fastify server bound to the port/path declared in httpServer config
 *   - Verifies inbound request signatures (HMAC supported out of the box)
 *   - Validates request payload against an optional JSON schema
 *   - Fires the integration's entry process with the request body as input
 *   - If sendResult is true, awaits the process result and sends it as the response
 *   - Otherwise responds 202 Accepted immediately and processes asynchronously
 *
 * The listener process stays alive indefinitely — PM2 supervises it.
 * Each inbound request triggers a fresh process execution in its own shared space.
 */

import Fastify                from "fastify";
import { readFile }           from "fs/promises";
import { resolve as resolvePath } from "path";
import { verifyHmacSignature } from "./authUtilities.js";
import { logger }             from "./logger.js";
import { EngineError }        from "./error.js";

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Resolves env placeholders in a string value.
 * Only handles {{env.KEY}} — full resolver not needed here (no shared space yet).
 * Pure given an env object.
 *
 * @param {string} value
 * @param {object} env
 * @returns {string}
 */
export function resolveEnvPlaceholders(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{env\.([^}]+)\}\}/g, (_, key) => env[key] ?? "");
}

/**
 * Resolves all string-valued leaves of an object through resolveEnvPlaceholders.
 * Pure given an env object.
 *
 * @param {object} obj
 * @param {object} env
 * @returns {object}
 */
export function resolveEnvInObject(obj, env = process.env) {
  if (!obj || typeof obj !== "object") return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = typeof v === "string"  ? resolveEnvPlaceholders(v, env)
              : typeof v === "object"  ? resolveEnvInObject(v, env)
              : v;
  }
  return result;
}

/**
 * Verifies inbound request authentication.
 * Currently supports HMAC; returns true for absent auth config (trust all).
 * Pure given injectable cryptoMod.
 *
 * @param {object}        authConfig   resolved auth block from httpServer
 * @param {string|Buffer} rawBody      raw request body bytes
 * @param {object}        headers      request headers
 * @param {object}        [cryptoMod]  injectable crypto
 * @returns {boolean}
 */
export function verifyInboundAuth(authConfig, rawBody, headers, cryptoMod = null) {
  if (!authConfig || !authConfig.type) return true;

  switch (authConfig.type) {
    case "hmac": {
      const headerName = authConfig.header ?? "X-Hub-Signature-256";
      const signature  = headers[headerName.toLowerCase()];
      if (!signature) return false;
      return verifyHmacSignature(rawBody, signature, authConfig.secret, authConfig.algorithm ?? "sha256", cryptoMod);
    }

    case "bearer_token": {
      const authHeader = headers["authorization"] ?? "";
      const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      return token === authConfig.token;
    }

    default:
      throw new EngineError(`Unsupported inbound auth type: "${authConfig.type}"`);
  }
}

// ── Fastify server factory ────────────────────────────────────────────────────

/**
 * Creates and starts a Fastify listener for a given integration.
 *
 * @param {object}   manifest      parsed integra.json
 * @param {object}   bootContext   { registry, resolvers, storage, executeProcess, createSharedSpace }
 * @param {string}   cwd           integration directory
 * @param {object}   [env]         injectable env (defaults to process.env)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function startListener(manifest, bootContext, cwd, env = process.env) {
  const { httpServer: rawHttpServer, entry: entryProcessId, sendResult = false } = manifest;

  if (!rawHttpServer) throw new EngineError("lifecycle 'listener' requires an httpServer block in integra.json");
  if (!entryProcessId) throw new EngineError("lifecycle 'listener' requires an entry process in integra.json");

  // Resolve env placeholders in the httpServer config
  const httpServer = resolveEnvInObject(rawHttpServer, env);

  const {
    port            = 3000,
    host            = "0.0.0.0",
    path            = "/",
    method          = "POST",
    auth            = null,
    validation      = null,
    queryValidation = null,
  } = httpServer;

  const { registry, resolvers, storage, executeProcess, createSharedSpace } = bootContext;

  const proc = registry.processes[entryProcessId];
  if (!proc) throw new EngineError(`Entry process not found: ${entryProcessId}`);

  // Load optional payload schema for validation
  let payloadSchema = null;
  if (validation) {
    try {
      const schemaPath = resolvePath(cwd, validation);
      const raw        = await readFile(schemaPath, "utf-8");
      payloadSchema    = JSON.parse(raw);
    } catch (err) {
      throw new EngineError(`Failed to load validation schema: ${validation}`, err);
    }
  }

  // Load optional query params schema for validation
  let querySchema = null;
  if (queryValidation) {
    try {
      const schemaPath = resolvePath(cwd, queryValidation);
      const raw        = await readFile(schemaPath, "utf-8");
      querySchema      = JSON.parse(raw);
    } catch (err) {
      throw new EngineError(`Failed to load query validation schema: ${queryValidation}`, err);
    }
  }

  const fastify = Fastify({ logger: false });

  // Add raw body access for HMAC verification (must happen before JSON parsing)
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body;
    try {
      done(null, JSON.parse(body.toString("utf-8")));
    } catch (err) {
      done(err);
    }
  });

  fastify.route({
    method:  method.toUpperCase(),
    url:     path,
    handler: async (request, reply) => {
      const requestId = `req_${Date.now()}`;
      const meta      = { requestId, path, method, integration: manifest.id };

      logger.info("listener.request", { ...meta, query: request.query });

      // Inbound authentication
      if (auth) {
        const resolvedAuth = resolveEnvInObject(auth, env);
        const verified     = verifyInboundAuth(resolvedAuth, request.rawBody, request.headers);
        if (!verified) {
          logger.warn("listener.auth_failed", meta);
          return reply.status(401).send({ error: "Unauthorized" });
        }
      }

      // Payload schema validation
      if (payloadSchema) {
        const { default: Ajv }   = await import("ajv");
        const { default: addFmt } = await import("ajv-formats");
        const ajv                 = new Ajv({ allErrors: true });
        addFmt(ajv);
        const validate = ajv.compile(payloadSchema);
        if (!validate(request.body)) {
          logger.warn("listener.validation_failed", { ...meta, errors: validate.errors });
          return reply.status(400).send({ error: "Bad Request", details: validate.errors });
        }
      }

      // Query params schema validation
      if (querySchema) {
        const { default: Ajv }    = await import("ajv");
        const { default: addFmt } = await import("ajv-formats");
        const ajv                 = new Ajv({ allErrors: true });
        addFmt(ajv);
        const validate = ajv.compile(querySchema);
        if (!validate(request.query)) {
          logger.warn("listener.query_validation_failed", { ...meta, errors: validate.errors });
          return reply.status(400).send({ error: "Bad Request", details: validate.errors });
        }
      }

      // Fire-and-forget or synchronous response
      if (!sendResult) {
        reply.status(202).send({ received: true, requestId });
        // Process runs after response is sent
        runProcess(proc, registry, resolvers, storage, buildRequestInput(request), meta, createSharedSpace).catch(err => {
          logger.error("listener.process_error", { ...meta, message: err.message });
        });
      } else {
        try {
          const result = await runProcess(proc, registry, resolvers, storage, buildRequestInput(request), meta, createSharedSpace);
          const httpResponse = result.shared?.http_response;
          const status       = httpResponse?.status ?? 200;
          const body         = httpResponse?.body   ?? { ok: true, requestId };
          return reply.status(status).send(body);
        } catch (err) {
          logger.error("listener.process_error", { ...meta, message: err.message });
          return reply.status(500).send({ error: "Internal Server Error", requestId });
        }
      }
    },
  });

  // Health check — always available
  fastify.get("/_health", async () => ({ status: "ok", integration: manifest.id }));

  await fastify.listen({ port: Number(port), host });
  logger.info("listener.started", { port, host, path, method, integration: manifest.id });

  return fastify;
}

/**
 * Builds the input envelope injected into the entry process.
 * Pure — takes a Fastify request object, returns a plain object.
 *
 * The process accesses these as:
 *   {{input.payload.fieldName}}          — parsed JSON body
 *   {{input.query.paramName}}            — query string parameters
 *   {{input.headers["x-event-type"]}}   — request headers
 *   {{input.rawBody}}                    — raw body bytes (Buffer), for custom HMAC etc.
 */
export function buildRequestInput(request) {
  return {
    payload: request.body    ?? null,
    query:   request.query   ?? {},
    headers: request.headers ?? {},
    rawBody: request.rawBody ?? null,
  };
}

/**
 * Executes the entry process for one inbound request.
 * Each request gets its own fresh shared space — requests are isolated.
 */
async function runProcess(proc, registry, resolvers, storage, input, meta, createSharedSpace) {
  const shared = createSharedSpace();
  logger.info("listener.process_start", meta);

  const result = await (await import("./executor.js")).executeProcess(
    proc, registry, shared, resolvers, undefined, storage,
    input   // full request envelope injected as process input
  );

  logger.info("listener.process_done", meta);
  return result;
}
