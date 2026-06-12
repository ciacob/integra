// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * resolvers/sync.js
 * Flow control and orchestration helpers for the sync process.
 */

export function hasIncidents(ctx, output) {
  const o         = output ?? ctx.output;
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

/**
 * Stores a structured run summary in the shared space.
 * Called as the process output: {{fn:syncStore('sync_result')}}
 *
 * Summary includes:
 *   - completed_at       ISO timestamp of when the run finished
 *   - incidents_fetched  total count fetched from ServiceNow
 *   - issues_created     count of Jira issues successfully created
 *   - issues_skipped     count that were filtered or errored
 */
export function syncStore(ctx, key) {
  const fetched = ctx._shared.get("sn_incidents")?.result?.length ?? 0;
  const created = ctx._shared.get("_issues_created_count") ?? 0;

  const summary = {
    completed_at:      new Date().toISOString(),
    incidents_fetched: fetched,
    issues_created:    created,
    issues_skipped:    fetched - created,
  };

  ctx._shared.set(key, summary);

  ctx.logger.info("sync.run_summary", { ...summary, ...ctx.meta });

  return summary;
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
}

export function handleCreateError(ctx) {
  const err = ctx.error;
  ctx.logger.error("sync.create_error", {
    message:  err?.message,
    incident: ctx._shared.get("current_sn_incident")?.number ?? "unknown",
    ...ctx.meta,
  });
}
