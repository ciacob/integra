// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * resolvers/servicenow.js
 * Resolver functions for ServiceNow connection components.
 *
 * NOTE: All exported names are prefixed to avoid collisions
 * with other resolver modules loaded in the same process.
 */

export function basicAuth(ctx, user, pass) {
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

export function snHasResults(ctx) {
  const result = ctx.output?.result;
  if (!Array.isArray(result) || result.length === 0) {
    ctx.logger.info("sn.no_results", { ...ctx.meta });
    return false;
  }
  return true;
}

/**
 * Stores the incident list and initialises the iteration queue.
 * Called as: {{fn:snStore('sn_incidents')}}
 */
export function snStore(ctx, key) {
  ctx._shared.set(key, ctx.output);

  if (key === "sn_incidents") {
    const incidents = ctx.output?.result ?? [];
    ctx._shared.set("_sn_incident_queue", [...incidents]);
    ctx.logger.info("sn.incidents_queued", { count: incidents.length, ...ctx.meta });
  }

  return ctx.output;
}
