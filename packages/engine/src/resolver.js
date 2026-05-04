/**
 * @integra/engine - resolver.js
 * Resolves {{placeholders}} and {{fn:calls}} in any value.
 *
 * Syntax:
 *   {{env.KEY}}                 → process.env.KEY
 *   {{shared.KEY}}              → shared space value
 *   {{input.field.path}}        → dot-path into current input
 *   {{output.field.path}}       → dot-path into current output
 *   {{component.id.property}}   → property of a named component instance
 *   {{fn:fnName(arg1,arg2)}}    → call a resolver function
 */

import { createRequire } from "module";
import { resolve as resolvePath } from "path";
import { logger } from "./logger.js";
import { EngineError } from "./error.js";

const PLACEHOLDER_RE = /^\{\{(.+)\}\}$/s;
const INTERPOLATE_RE = /\{\{([^}]+)\}\}/g;
const FN_RE          = /^fn:(\w+)(?:\((.*)\))?$/s;

/**
 * Loads all resolver modules declared across components.
 * Returns a map of { exportedFnName -> fn } merged from all modules.
 * Modules are loaded relative to the integration's cwd.
 */
export async function loadResolvers(resolverPaths, cwd) {
  const resolvers = {};
  const require   = createRequire(resolvePath(cwd, "dummy.js"));

  for (const relPath of [...new Set(resolverPaths)]) {
    if (!relPath) continue;
    const absPath = resolvePath(cwd, relPath);

    try {
      const mod = await import(absPath);
      Object.assign(resolvers, mod);
      logger.debug("resolver.loaded", { path: absPath });
    } catch (err) {
      throw new EngineError(`Failed to load resolver module: ${absPath}`, err);
    }
  }

  return resolvers;
}

/**
 * Resolves a single value against the current context.
 * Constants pass through unchanged.
 * Strings matching {{...}} are resolved as placeholders or function calls.
 * Objects and arrays are resolved recursively.
 */
export function resolve(value, ctx) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(v => resolve(v, ctx));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolve(v, ctx);
    }
    return out;
  }

  if (typeof value !== "string") return value;

  // Whole-string placeholder: {{expr}} — may return non-string values
  const match = value.match(PLACEHOLDER_RE);
  if (match) {
    const expression = match[1].trim();
    return resolveExpression(expression, ctx);
  }

  // Interpolated string: "prefix {{expr}} suffix" — always returns a string
  if (INTERPOLATE_RE.test(value)) {
    INTERPOLATE_RE.lastIndex = 0;
    return value.replace(INTERPOLATE_RE, (_, expr) => {
      const resolved = resolveExpression(expr.trim(), ctx);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }

  return value;
}

function resolveExpression(expression, ctx) {
  const fnMatch = expression.match(FN_RE);
  if (fnMatch) return resolveFunction(fnMatch[1], fnMatch[2], ctx);
  return resolveDotPath(expression, ctx);
}

function resolveDotPath(path, ctx) {
  const value = path.split(".").reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, ctx);

  logger.debug("resolver.path", { path, resolved: value !== undefined });
  return value;
}

function resolveFunction(fnName, rawArgs, ctx) {
  const fn = ctx.resolvers?.[fnName];

  if (!fn || typeof fn !== "function") {
    throw new EngineError(`Resolver function not found: ${fnName}`);
  }

  const args = rawArgs !== undefined ? parseArgs(rawArgs, ctx) : [];
  logger.debug("resolver.fn", { fn: fnName, argCount: args.length });
  return fn(ctx, ...args);
}

/**
 * Parses a comma-separated argument string, resolving each argument.
 * Handles quoted strings and nested placeholders.
 */
function parseArgs(rawArgs, ctx) {
  if (!rawArgs || !rawArgs.trim()) return [];

  const args   = [];
  let   current = "";
  let   depth   = 0;
  let   inQuote = false;
  let   quoteChar = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const ch = rawArgs[i];

    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inQuote   = true;
      quoteChar = ch;
      continue;
    }

    if (ch === "(") { depth++; current += ch; continue; }
    if (ch === ")") { depth--; current += ch; continue; }

    if (ch === "," && depth === 0) {
      args.push(resolveArg(current.trim(), ctx));
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) args.push(resolveArg(current.trim(), ctx));
  return args;
}

function resolveArg(arg, ctx) {
  if (arg.match(PLACEHOLDER_RE)) return resolve(arg, ctx);
  if (arg === "null")  return null;
  if (arg === "true")  return true;
  if (arg === "false") return false;
  if (!isNaN(arg))     return Number(arg);
  // Bare path (e.g. env.SN_USER, shared, shared.key, component.my-step.output) — resolve as path
  if (/^[a-zA-Z_][a-zA-Z0-9_.\-]*$/.test(arg)) {
    const resolved = resolveDotPath(arg, ctx);
    if (resolved !== undefined) return resolved;
  }
  return arg;
}
