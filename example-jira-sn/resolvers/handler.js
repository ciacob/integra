// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * resolvers/handler.js
 * Flow control and response building for the handle-jira-issue process.
 */

const SUPPORTED_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
];

export function isSupportedEvent(ctx, webhookEvent) {
  const event = webhookEvent ?? ctx.input?.payload?.webhookEvent;
  const supported = SUPPORTED_EVENTS.includes(event);
  if (!supported) {
    ctx.logger.warn("handler.unsupported_event", { event, ...ctx.meta });
  }
  return supported;
}

/**
 * Builds and stores the http_response for the listener to send back.
 * sendResult:true means the listener will read this and respond accordingly.
 *
 * Note: Jira ignores this response body entirely — it is here for local
 * testing with send-test-webhook.js so you can see the result in your terminal.
 */
export function buildHttpResponse(ctx, key) {
  const created = ctx._shared.get("sn_created_incident");
  const issue   = ctx._shared.get("sn_incident_payload");

  const body = created
    ? {
        ok:                 true,
        sn_number:          created?.result?.number ?? "unknown",
        sn_sys_id:          created?.result?.sys_id ?? "unknown",
        short_description:  issue?.short_description ?? null,
      }
    : {
        ok:      false,
        reason:  "unsupported_event",
      };

  const result = { status: created ? 200 : 200, body };
  ctx._shared.set("http_response", result);
  ctx._shared.set(key, result);

  ctx.logger.info("handler.response_built", { ok: body.ok, ...ctx.meta });
  return result;
}

export function handleMapError(ctx) {
  const err = ctx.error;
  ctx.logger.error("handler.map_error", { message: err?.message, ...ctx.meta });
  // Rethrow — a mapping failure is a bug, not a recoverable condition
  throw new Error(err?.message ?? "Mapping failed");
}

export function handleCreateError(ctx) {
  const err = ctx.error;
  ctx.logger.error("handler.create_error", {
    message:  err?.message,
    payload:  ctx._shared.get("sn_incident_payload")?.short_description ?? "unknown",
    ...ctx.meta,
  });
  // Rethrow — a create failure means the incident was not created
  // With sendResult:true, this causes the listener to respond 500
  // so Jira would retry (if it were configured to care about responses)
  throw new Error(err?.message ?? "ServiceNow create failed");
}
