/**
 * resolvers/servicenow.js
 * ServiceNow-specific resolver functions for the jira-sn example.
 */

export function snStore(ctx, key) {
  ctx._shared.set(key, ctx.output);
  if (key === "sn_created_incident") {
    ctx.logger.info("sn.incident_created", {
      sys_id: ctx.output?.result?.sys_id ?? ctx.output?.sys_id ?? "unknown",
      number: ctx.output?.result?.number ?? "unknown",
      ...ctx.meta,
    });
  }
  return ctx.output;
}
