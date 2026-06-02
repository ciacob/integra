/**
 * resolvers/jira.js
 * Resolver functions for Jira connection components.
 */

export function jiraBasicAuth(ctx, user, token) {
  const encoded = Buffer.from(`${user}:${token}`).toString("base64");
  return `Basic ${encoded}`;
}

export function jiraStore(ctx, key) {
  ctx._shared.set(key, ctx.output);
  if (key === "jira_created_issue") {
    ctx.logger.info("jira.issue_created", {
      key: ctx.output?.key ?? ctx.output?.id ?? "unknown",
      ...ctx.meta,
    });
    // Increment the shared created counter so the run summary is accurate
    const count = ctx._shared.get("_issues_created_count") ?? 0;
    ctx._shared.set("_issues_created_count", count + 1);
  }
  return ctx.output;
}
