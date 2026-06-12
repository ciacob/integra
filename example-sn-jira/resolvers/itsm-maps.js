// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * resolvers/itsm-maps.js
 * Transformation functions for ITSM data mapping.
 */

const SN_PRIORITY_MAP = {
  "1": "Highest",
  "2": "High",
  "3": "Medium",
  "4": "Low",
  "5": "Lowest",
};

export function mapIncident(ctx, input) {
  const incident  = input ?? ctx.input ?? {};
  const priority  = SN_PRIORITY_MAP[incident.priority] ?? "Medium";
  const projectKey = ctx.env.JIRA_PROJECT_KEY ?? "OPS";
  const description = incident.description || incident.short_description || "";

  return {
    fields: {
      project:     { key: projectKey },
      summary:     incident.short_description ?? "(no summary)",
      description: {
        type:    "doc",
        version: 1,
        content: [
          {
            type:    "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      },
      issuetype: { name: "Task" },
      priority:  { name: priority },
      labels:    [incident.category ?? "general"].filter(Boolean),
    },
    __sn_number:   incident.number,
    __sn_sys_id:   incident.sys_id,
    __sn_priority: incident.priority,
  };
}

export function mapStore(ctx, key) {
  ctx._shared.set(key, ctx.output);
  return ctx.output;
}
