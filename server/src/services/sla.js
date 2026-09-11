import { config } from '../config.js';

/**
 * SLA breach tracking — server-side computation.
 *
 * "Responded" means the first non-internal comment left by an agent or
 * admin. An internal note doesn't count (the customer hasn't heard
 * anything yet) and a requester replying to themselves doesn't count
 * either. Decisions on the spec's open questions are in DECISIONS.md.
 *
 * config.slaTargets is the single source of truth for target hours per
 * priority (server/src/config.js, as pointed to by the spec). The values
 * come from our own config, not from user input, so building this SQL
 * fragment from them is safe.
 */
const TARGET_HOURS_CASE_SQL = `CASE t.priority ${Object.entries(config.slaTargets)
  .map(([priority, hours]) => `WHEN '${priority}' THEN ${Number(hours)}`)
  .join(' ')} END`;

// First-response lookup: earliest non-internal comment from an agent/admin,
// one row per ticket. Joined once and reused by both the list and detail
// queries instead of running a query per ticket.
export const FIRST_RESPONSE_JOIN_SQL = `
  LEFT JOIN (
    SELECT c.ticket_id, MIN(c.created_at) AS first_response_at
      FROM comments c
      JOIN users cu ON cu.id = c.author_id
     WHERE c.is_internal = 0 AND cu.role IN ('agent', 'admin')
     GROUP BY c.ticket_id
  ) fr ON fr.ticket_id = t.id
`;

// Selected as columns on both the list and the detail query.
export const SLA_SELECT_SQL = `
  ${TARGET_HOURS_CASE_SQL} AS sla_target_hours,
  DATE_ADD(t.created_at, INTERVAL (${TARGET_HOURS_CASE_SQL}) HOUR) AS sla_due_at,
  fr.first_response_at AS sla_first_response_at
`;

// Boolean condition, usable both in a SELECT (to label rows) and a WHERE
// (to filter to breached tickets only). `?` is bound to the "now" the
// caller is treating as current, so a single request is self-consistent.
export const SLA_BREACHED_CONDITION_SQL = `
  (fr.first_response_at IS NULL OR fr.first_response_at > DATE_ADD(t.created_at, INTERVAL (${TARGET_HOURS_CASE_SQL}) HOUR))
  AND ? > DATE_ADD(t.created_at, INTERVAL (${TARGET_HOURS_CASE_SQL}) HOUR)
`;

/**
 * Turns the raw sla_* columns from a row into the shape the API/UI use.
 * Safe to call on a row that has no sla_target_hours (e.g. unrelated
 * queries reusing the same row shape) — returns null in that case.
 */
export function attachSlaState(row, now = new Date()) {
  if (!row || row.sla_target_hours == null) return row;
  const dueAt = new Date(row.sla_due_at);
  const firstResponseAt = row.sla_first_response_at ? new Date(row.sla_first_response_at) : null;
  const respondedInTime = firstResponseAt !== null && firstResponseAt <= dueAt;
  const breached = !respondedInTime && now > dueAt;

  row.sla = {
    targetHours: row.sla_target_hours,
    dueAt: dueAt.toISOString(),
    firstResponseAt: firstResponseAt ? firstResponseAt.toISOString() : null,
    breached,
  };
  delete row.sla_target_hours;
  delete row.sla_due_at;
  delete row.sla_first_response_at;
  return row;
}
