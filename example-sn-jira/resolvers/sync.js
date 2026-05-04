/**
 * resolvers/sync.js
 * Flow control and orchestration helpers for the sync process.
 */

export function hasIncidents(ctx, output) {
  const o        = output ?? ctx.output;
  const incidents = o?.result;
  const has       = Array.isArray(incidents) && incidents.length > 0;
  ctx.logger.info("sync.has_incidents", { count: incidents?.length ?? 0, ...ctx.meta });
  return has;
}

/**
 * Pops the next incident from the queue into shared.current_sn_incident.
 * Returns true if there was one, false when the queue is empty.
 */
export function hasNextIncident(ctx) {
  const queue = ctx._shared.get("_sn_incident_queue") ?? [];

  if (!queue.length) return false;

  const next = queue.shift();
  ctx._shared.set("_sn_incident_queue",  queue);
  ctx._shared.set("current_sn_incident", next);

  ctx.logger.info("sync.processing_incident", {
    number:    next.number,
    remaining: queue.length,
    ...ctx.meta,
  });

  return true;
}

export function isHighPriority(ctx, priority) {
  const p = priority ?? ctx.input?.priority;
  return p === "1" || p === "2";
}

export function syncStore(ctx, key) {
  ctx._shared.set(key, ctx.output ?? { done: true });
  return ctx._shared.get(key);
}

// --- Error handlers ---

export function handleFetchError(ctx) {
  const err = ctx.error;
  ctx.logger.error("sync.fetch_error", { message: err?.message, ...ctx.meta });
  throw new Error(err?.message ?? "Fetch failed");
}

export function handleMapError(ctx) {
  const err = ctx.error;
  ctx.logger.warn("sync.map_error", {
    message:  err?.message,
    incident: ctx._shared.get("current_sn_incident")?.number ?? "unknown",
    ...ctx.meta,
  });
  // Swallow — log and move on to the next incident
}

export function handleCreateError(ctx) {
  const err = ctx.error;
  ctx.logger.error("sync.create_error", {
    message:  err?.message,
    incident: ctx._shared.get("current_sn_incident")?.number ?? "unknown",
    ...ctx.meta,
  });
  // Swallow — log and continue
}
