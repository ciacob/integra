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
  }
  return ctx.output;
}
