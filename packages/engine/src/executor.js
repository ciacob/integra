/**
 * @integra/engine - executor.js
 * Walks processes, flows, and steps — dispatching each to the correct handler.
 * Manages context, resolves values, bubbles errors, and honors flow control signals.
 */

import { resolve }                                    from "./resolver.js";
import { logger }                                     from "./logger.js";
import { StepError, BreakSignal, ContinueSignal,
         buildErrorCtx }                              from "./error.js";
import { createSharedSpace }                          from "./shared.js";
import { resolveAuthHeaders }                         from "./authUtilities.js";
import { buildMultipartBody, parseResponseMeta,
         buildBinaryOutput }                          from "./binaryUtilities.js";

let runCounter = 0;
function generateRunId() {
  return `run_${Date.now()}_${++runCounter}`;
}

/**
 * Merges component defaults/overrides with wrapper defaults/overrides.
 * Wrapper defaults fill gaps in component defaults.
 * Component overrides always win. Wrapper overrides win over component defaults.
 *
 * Precedence (highest to lowest):
 *   component.overrides > wrapper.overrides > input > component.defaults > wrapper.defaults
 */
function mergeComponent(component, wrapper) {
  return {
    ...component,
    defaults: { ...wrapper.defaults, ...component.defaults },
    overrides: { ...wrapper.overrides, ...component.overrides },
    input:     wrapper.input    ?? component.input,
    output:    wrapper.output   ?? component.output,
    resolver:  wrapper.resolver ?? component.resolver,
  };
}

/**
 * Applies dot-path source->target mappings from a mapping object onto a data object.
 * Only applies mappings where the target path is not already set (for defaults)
 * or always applies them (for overrides).
 */
function applyMappings(data, input, mappings, mode = "defaults") {
  const result = { ...data };

  for (const [source, target] of Object.entries(mappings ?? {})) {
    const sourceVal = getPath(input, source);
    if (mode === "defaults" && getPath(result, target) !== undefined) continue;
    setPath(result, target, sourceVal);
  }

  return result;
}

function getPath(obj, path) {
  return path.split(".").reduce((acc, k) => acc?.[k], obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let   cur  = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Builds the context object passed into every resolver function.
 */
function buildCtx({ shared, resolvers, registry, meta, input, output, components, env, storage }) {
  return {
    env:        env ?? process.env,
    shared:     shared.all(),
    input:      input      ?? {},
    output:     output     ?? {},
    component:  components ?? {},
    resolvers,
    meta,
    logger,
    // Allow resolvers to write to shared space
    _shared:   shared,
    // File-backed storage for tokens and other persistent state
    _storage:  storage ?? createNullStorage(),
  };
}

/**
 * A no-op storage used when no storage instance is provided (e.g. in tests).
 * get always returns undefined; set/delete are silent no-ops.
 */
function createNullStorage() {
  const store = {};
  return {
    get:    async (k)    => store[k],
    set:    async (k, v) => { store[k] = v; },
    delete: async (k)    => { delete store[k]; },
    all:    async ()     => ({ ...store }),
    has:    async (k)    => k in store,
  };
}

/**
 * Builds fetch options for a connection request.
 * Branches on body_type: json (default), binary, multipart.
 * Pure given resolved inputs.
 *
 * @param {string} method
 * @param {object} headers       already-merged headers including auth
 * @param {*}      body          resolved request.body (used for json only)
 * @param {string} body_type     "json" | "binary" | "multipart"
 * @param {object} binary_info   resolved binary_info block (for binary/multipart)
 * @returns {object}  fetch options
 */
function buildFetchOptions(method, headers, body, body_type = "json", binary_info = null) {
  const hasBody = !["GET", "DELETE"].includes(method);

  if (body_type === "binary" && binary_info && hasBody) {
    const buffer      = binary_info.source_bytes;
    const contentType = binary_info.content_type ?? "application/octet-stream";
    return {
      method,
      headers: { ...headers, "Content-Type": contentType },
      body:    buffer,
    };
  }

  if (body_type === "multipart" && binary_info && hasBody) {
    const { formData } = buildMultipartBody(
      binary_info.fields        ?? {},
      binary_info.source_bytes,
      binary_info.file_field    ?? "file",
      binary_info.file_name     ?? "file",
      binary_info.content_type  ?? "application/octet-stream"
    );
    // Do NOT set Content-Type manually — fetch sets it with the boundary
    return { method, headers: { ...headers }, body: formData };
  }

  // Default: JSON
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body && hasBody) {
    opts.body = JSON.stringify(body);
  }
  return opts;
}

/**
 * Wraps a raw API response in the standard integra envelope.
 * Pure.
 */
function wrapResponse(componentId, shortDescription, responseData) {
  return {
    __kind:              componentId,
    __origin:            componentId,
    __short_description: shortDescription ?? null,
    data:                responseData,
    ...(responseData.result ? { result: responseData.result } : {}),
    ...responseData,
  };
}

/**
 * Executes an HTTP connection component.
 * Resolves the auth block (if present) before making the request.
 * Supports on_401: "refresh_and_retry" for OAuth token expiry edge cases.
 */
async function executeConnection(component, ctx, registry) {
  const { request, auth } = component;
  const body_type     = component.body_type     ?? "json";
  const response_type = component.response_type ?? "json";

  const endpoint = resolve(request.endpoint, ctx);
  const method   = request.type;
  const headers  = resolve(request.headers ?? {}, ctx);
  const query    = resolve(request.query   ?? {}, ctx);
  const body     = request.body ? resolve(request.body, ctx) : undefined;

  // Resolve binary_info block if present
  const binary_info = component.binary_info
    ? resolve(component.binary_info, ctx)
    : null;

  // Resolve auth block — injects Authorization header automatically
  const resolvedAuth = auth ? resolve(auth, ctx) : null;
  const authHeaders  = await resolveAuthBlock(resolvedAuth, component.id, ctx);

  // Build URL with query params
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const mergedHeaders  = { ...authHeaders, ...headers };
  const fetchOptions   = buildFetchOptions(method, mergedHeaders, body, body_type, binary_info);

  const doFetch = async () => {
    logger.info("connection.request", { ...ctx.meta, method, url: url.toString() });
    const t0  = Date.now();
    const res = await fetch(url.toString(), fetchOptions);
    logger.info("connection.response", { ...ctx.meta, status: res.status, duration_ms: Date.now() - t0 });
    return res;
  };

  let res = await doFetch();

  // on_401 refresh-and-retry for OAuth CC edge cases (token revoked externally)
  if (res.status === 401 && resolvedAuth?.on_401 === "refresh_and_retry" &&
      resolvedAuth?.type === "oauth2_client_credentials") {
    logger.warn("connection.auth_retry", { ...ctx.meta, component: component.id });
    const storageKey = `auth_token:${component.id}`;
    await ctx._storage.delete(storageKey);   // force fresh fetch
    const freshHeaders = await resolveAuthBlock(resolvedAuth, component.id, ctx);
    Object.assign(fetchOptions.headers, freshHeaders);
    res = await doFetch();
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }

  let output;

  if (response_type === "binary") {
    // Binary response — don't parse as JSON
    const arrayBuffer  = await res.arrayBuffer();
    const buffer       = Buffer.from(arrayBuffer);
    const rawHeaders   = Object.fromEntries(res.headers.entries());
    const meta         = parseResponseMeta(rawHeaders);

    // Extract idempotency key from metadata if declared
    const idempotencyPath = binary_info?.idempotency_key ?? null;
    const idempotencyKey  = idempotencyPath
      ? (idempotencyPath.split(".").reduce((o, k) => o?.[k], meta) ?? null)
      : null;

    output = buildBinaryOutput(buffer, meta, idempotencyKey);

    logger.info("connection.binary_response", {
      ...ctx.meta,
      size:            buffer.length,
      content_type:    meta.content_type,
      idempotency_key: idempotencyKey,
    });
  } else {
    const responseData = await res.json();
    output = wrapResponse(component.id, component.short_description, responseData);
  }

  // Apply filter if defined
  if (component.filter) {
    const keep = resolve(component.filter, { ...ctx, output });
    if (!keep) {
      logger.info("connection.filtered", { ...ctx.meta });
      return null;
    }
  }

  // Store output if defined
  if (component.output) {
    resolve(component.output, { ...ctx, output });
  }

  return output;
}

/**
 * Resolves an auth block to a headers object.
 * Handles the custom type by delegating to the resolver fn.
 * Returns {} when auth is null/undefined.
 */
export async function resolveAuthBlock(auth, connId, ctx) {
  if (!auth) return {};

  if (auth.type === "custom") {
    // Delegate to resolver fn — must return a headers object
    if (!auth.resolver) throw new Error(`auth.type "custom" requires auth.resolver fn call`);
    return resolve(auth.resolver, ctx) ?? {};
  }

  return resolveAuthHeaders(auth, ctx._storage, connId) ?? {};
}

/**
 * Executes a map component.
 */
async function executeMap(component, ctx) {
  // Resolve input
  let input = component.input ? resolve(component.input, ctx) : ctx.input;
  input = input ?? {};

  // Apply data-level defaults then overrides
  input = { ...component.defaults ?? {}, ...input, ...component.overrides ?? {} };

  const mapCtx = { ...ctx, input };

  // Run transformation
  let output = {};

  // base transform
  if (component.transformation?.base) {
    output = resolve(component.transformation.base, mapCtx) ?? {};
  }

  // transformation defaults — apply mappings base didn't cover
  if (component.transformation?.defaults) {
    output = applyMappings(output, input, component.transformation.defaults, "defaults");
  }

  // transformation overrides — always apply
  if (component.transformation?.overrides) {
    output = applyMappings(output, input, component.transformation.overrides, "overrides");
  }

  // Wrap in standard envelope
  const envelope = {
    __kind:              component.id,
    __origin:            component.id,
    __short_description: component.short_description ?? null,
    ...output,
  };

  // Store output if defined
  if (component.output) {
    const outputCtx = { ...ctx, output: envelope };
    resolve(component.output, outputCtx);
  }

  return envelope;
}

/**
 * Executes a single step within a flow.
 */
async function executeStep(step, ctx, registry, components, lastIfResult = null) {
  const stepCtx = {
    ...ctx,
    meta: { ...ctx.meta, stepId: step.id ?? null },
  };

  const t0 = Date.now();

  logger.info("step.started", {
    ...stepCtx.meta,
    type: getStepType(step),
  });

  try {
    let result;

    if (step.component) {
      result = await executeComponentStep(step, stepCtx, registry, components);
    } else if ("if" in step) {
      result = await executeIf(step, stepCtx, registry, components, lastIfResult);
    } else if ("else" in step) {
      result = await executeElse(step, stepCtx, registry, components, lastIfResult);
    } else if ("switch" in step) {
      result = await executeSwitch(step, stepCtx, registry, components);
    } else if ("while" in step) {
      result = await executeWhile(step, stepCtx, registry, components);
    } else if ("break" in step) {
      throw new BreakSignal(step.break);
    } else if ("continue" in step) {
      throw new ContinueSignal(step.continue);
    } else if (step.process) {
      result = await executeSubProcess(step, stepCtx, registry, components);
    }

    // Register component instance result for later reference
    if (step.id && result !== undefined) {
      components[step.id] = { output: result, input: stepCtx.input };
    }

    logger.info("step.completed", {
      ...stepCtx.meta,
      duration_ms: Date.now() - t0,
    });

    // Return the updated lastIfResult so executeFlow can track it across steps
    if ("if" in step)   return !!resolve(step.if, stepCtx);
    if ("else" in step) return null;
    return lastIfResult;

  } catch (err) {
    // Signals pass through untouched
    if (err instanceof BreakSignal || err instanceof ContinueSignal) throw err;

    logger.error("step.failed", {
      ...stepCtx.meta,
      duration_ms: Date.now() - t0,
      message:     err.message,
    });

    // User-defined error handler
    if (step.onError) {
      const errorCtx = {
        ...stepCtx,
        error: buildErrorCtx(err, stepCtx.meta),
      };
      return resolve(step.onError, errorCtx);
    }

    // Bubble up
    throw new StepError({
      message:     err.message,
      stepId:      step.id ?? null,
      componentId: step.component ?? null,
      cause:       err,
    });
  }
}

async function executeComponentStep(step, ctx, registry, components) {
  const { connections, maps, processes } = registry;

  const componentDef =
    connections[step.component] ??
    maps[step.component]        ??
    processes[step.component];

  if (!componentDef) {
    throw new Error(`Component not found: ${step.component}`);
  }

  const merged = mergeComponent(componentDef, step);

  // Rebuild ctx with fresh shared snapshot
  const freshCtx = {
    ...ctx,
    shared:    ctx._shared.all(),
    component: components,
    meta: { ...ctx.meta, componentId: step.component },
  };

  if (connections[step.component]) {
    return executeConnection(merged, freshCtx, registry);
  } else if (maps[step.component]) {
    return executeMap(merged, freshCtx);
  } else {
    return executeProcess(merged, registry, ctx._shared, ctx.resolvers, components, ctx._storage);
  }
}

async function executeSubProcess(step, ctx, registry, components) {
  const { processes } = registry;
  const proc = processes[step.process];
  if (!proc) throw new Error(`Sub-process not found: ${step.process}`);
  return executeProcess(proc, registry, ctx._shared, ctx.resolvers, components, ctx._storage);
}

async function executeIf(step, ctx, registry, components, lastIfResult) {
  const condition = resolve(step.if, ctx);
  if (condition) {
    await executeFlow({ steps: step.steps, metadata: step.metadata }, ctx, registry, components);
  }
}

async function executeElse(step, ctx, registry, components, lastIfResult) {
  if (!lastIfResult) {
    await executeFlow({ steps: step.steps, metadata: step.metadata }, ctx, registry, components);
  }
}

async function executeSwitch(step, ctx, registry, components) {
  const value = resolve(step.switch, ctx);
  const cases = step.cases ?? {};

  const matchedCase = cases[String(value)] ?? cases["default"];
  if (matchedCase?.steps) {
    await executeFlow(matchedCase, ctx, registry, components);
  }
}

async function executeWhile(step, ctx, registry, components) {
  while (resolve(step.while, ctx)) {
    try {
      await executeFlow({ steps: step.steps, metadata: step.metadata }, ctx, registry, components);
    } catch (err) {
      if (err instanceof BreakSignal) {
        if (err.target === null || err.target === step.id) break;
        throw err; // targeting an outer loop
      }
      if (err instanceof ContinueSignal) {
        if (err.target === null || err.target === step.id) continue;
        throw err;
      }
      throw err;
    }
  }
}

async function executeFlow(flow, ctx, registry, components) {
  const steps    = flow.steps    ?? [];
  const parallel = flow.metadata?.parallel ?? false;

  if (parallel) {
    await Promise.all(steps.map(step => executeStep(step, ctx, registry, components, null)));
  } else {
    let lastIfResult = null;
    for (const step of steps) {
      lastIfResult = await executeStep(step, ctx, registry, components, lastIfResult);
    }
  }
}

function getStepType(step) {
  if (step.component) return "component";
  if ("if" in step)   return "if";
  if ("else" in step) return "else";
  if ("switch" in step) return "switch";
  if ("while" in step)  return "while";
  if ("break" in step)  return "break";
  if ("continue" in step) return "continue";
  if (step.process)   return "process";
  return "unknown";
}

/**
 * Main entry point: executes a top-level process.
 */
export async function executeProcess(process, registry, shared, resolvers, parentComponents, storage, inputOverride) {
  const runId      = generateRunId();
  const components = parentComponents ?? {};
  const meta       = { runId, processId: process.id, stepId: null, componentId: null };

  logger.info("process.started", { runId, processId: process.id });
  const t0 = Date.now();

  // Resolve input — inputOverride (e.g. from listener) takes precedence over process.input
  let input = inputOverride
    ?? (process.input ? resolve(process.input, buildCtx({ shared, resolvers, registry, meta, storage })) : {});

  const ctx = {
    ...buildCtx({ shared, resolvers, registry, meta, input, components, storage }),
    _shared: shared,
  };

  try {
    await executeFlow(process.flow, ctx, registry, components);

    // Resolve output if defined
    let output;
    if (process.output) {
      output = resolve(process.output, { ...ctx, shared: shared.all() });
    }

    logger.info("process.completed", {
      runId,
      processId:   process.id,
      duration_ms: Date.now() - t0,
    });

    return { shared: shared.all(), output, components };

  } catch (err) {
    logger.error("process.failed", {
      runId,
      processId:   process.id,
      duration_ms: Date.now() - t0,
      message:     err.message,
    });
    throw err;
  }
}
