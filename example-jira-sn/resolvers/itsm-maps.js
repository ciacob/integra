/**
 * resolvers/itsm-maps.js
 * Field mapping functions for Jira → ServiceNow transformation.
 */

// Jira priority name → ServiceNow urgency (1=Critical … 4=Low)
const JIRA_PRIORITY_TO_SN_URGENCY = {
  "Highest": "1",
  "High":    "2",
  "Medium":  "3",
  "Low":     "4",
  "Lowest":  "4",
};

// Jira issue type → ServiceNow category
const JIRA_ISSUETYPE_TO_SN_CATEGORY = {
  "Bug":          "software",
  "Incident":     "software",
  "Service Request": "request",
  "Task":         "inquiry",
  "Story":        "inquiry",
};

/**
 * Maps a Jira issue fields object to a ServiceNow incident payload.
 * Called as the base transformation in the map component.
 *
 * Note: ctx.input is the Jira issue object (issue, not issue.fields),
 * because the process wrapper passes input.payload.issue directly.
 */
export function mapJiraToSn(ctx, input) {
  const issue  = input ?? ctx.input ?? {};
  const fields = issue.fields ?? {};

  const priority     = fields.priority?.name ?? "Medium";
  const urgency      = JIRA_PRIORITY_TO_SN_URGENCY[priority]      ?? "3";
  const impact       = JIRA_PRIORITY_TO_SN_URGENCY[priority]      ?? "3";
  const category     = JIRA_ISSUETYPE_TO_SN_CATEGORY[fields.issuetype?.name] ?? "software";

  // Extract plain text from Jira's Atlassian Document Format description
  const description  = extractAtlassianText(fields.description) ?? fields.summary ?? "";

  return {
    short_description: fields.summary ?? "(no summary)",
    description,
    urgency,
    impact,
    category,
    // Cross-reference: store the Jira key so we can find this incident later
    correlation_id:    issue.key  ?? null,
    correlation_display: `Jira ${issue.key ?? ""}`,
    // Caller info
    caller_id:         fields.reporter?.displayName ?? null,
    assigned_to:       fields.assignee?.displayName ?? null,
  };
}

/**
 * Extracts plain text from an Atlassian Document Format (ADF) node.
 * Recursively walks the content tree and collects text nodes.
 * Pure.
 */
export function extractAtlassianText(adfNode) {
  if (!adfNode) return null;
  if (typeof adfNode === "string") return adfNode;
  if (adfNode.type === "text") return adfNode.text ?? "";
  if (Array.isArray(adfNode.content)) {
    return adfNode.content.map(extractAtlassianText).filter(Boolean).join(" ");
  }
  return null;
}

export function mapStore(ctx, key) {
  ctx._shared.set(key, ctx.output);
  return ctx.output;
}
