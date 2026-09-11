import { query } from '../db/pool.js';
import { FIRST_RESPONSE_JOIN_SQL, SLA_SELECT_SQL, SLA_BREACHED_CONDITION_SQL, attachSlaState } from './sla.js';

const PAGE_SIZE = 20;

// sortBy/order come straight from query-string input and are interpolated
// into the SQL string (mysql2 placeholders can't parameterise identifiers),
// so they must be resolved against a fixed whitelist rather than trusted.
const SORTABLE_COLUMNS = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  priority: 't.priority',
  status: 't.status',
};
const SORT_ORDERS = { asc: 'ASC', desc: 'DESC' };

/**
 * Paginated ticket list for the current organisation.
 *
 * Supports free-text search on subject, filtering by status and priority,
 * and sorting by any column the UI exposes in its dropdown.
 */
export async function listTickets({ orgId, page = 1, search = '', status, priority, sortBy = 'created_at', order = 'desc', breached = false }) {
  const where = ['t.org_id = ?'];
  const params = [orgId];

  if (search) {
    where.push('t.subject LIKE ?');
    params.push(`%${search}%`);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }

  const now = new Date();
  if (breached) {
    where.push(`(${SLA_BREACHED_CONDITION_SQL})`);
    params.push(now);
  }

  const whereSql = where.join(' AND ');
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * PAGE_SIZE;
  const orderColumn = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.created_at;
  const orderDirection = SORT_ORDERS[String(order).toLowerCase()] || SORT_ORDERS.desc;

  const rows = await query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            t.assignee_id, u.name AS assignee_name, r.name AS requester_name,
            ${SLA_SELECT_SQL}
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
       ${FIRST_RESPONSE_JOIN_SQL}
      WHERE ${whereSql}
      ORDER BY ${orderColumn} ${orderDirection}
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  for (const row of rows) attachSlaState(row, now);

  // Attach the comment count each row needs for the list badge. Batched
  // in one query instead of one round trip per row.
  if (rows.length) {
    const counts = await query(
      `SELECT ticket_id, COUNT(*) AS c FROM comments WHERE ticket_id IN (?) GROUP BY ticket_id`,
      [rows.map((r) => r.id)]
    );
    const countByTicket = new Map(counts.map((c) => [c.ticket_id, c.c]));
    for (const row of rows) row.comment_count = countByTicket.get(row.id) || 0;
  }

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total
       FROM tickets t
       ${FIRST_RESPONSE_JOIN_SQL}
      WHERE ${whereSql}`,
    params
  );

  return { rows, total, page: safePage, pageSize: PAGE_SIZE };
}

export async function getTicketById(id) {
  const rows = await query(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name, r.email AS requester_email,
            ${SLA_SELECT_SQL}
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
       ${FIRST_RESPONSE_JOIN_SQL}
      WHERE t.id = ?`,
    [id]
  );
  return attachSlaState(rows[0]) || null;
}

export async function listComments(ticketId) {
  return query(
    `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = ?
      ORDER BY c.created_at ASC`,
    [ticketId]
  );
}

export async function createTicket({ orgId, subject, body, priority, requesterId }) {
  const result = await query(
    `INSERT INTO tickets (org_id, subject, body, priority, requester_id)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, subject, body, priority, requesterId]
  );
  return getTicketById(result.insertId);
}

export async function assignTicket(ticketId, assigneeId) {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return null;

  if (ticket.assignee_id) {
    return { conflict: true, ticket };
  }

  // Look up the agent so the response carries a display name for the toast.
  const [agent] = await query('SELECT id, name FROM users WHERE id = ?', [assigneeId]);

  await query('UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ?', [assigneeId, 'pending', ticketId]);
  return { conflict: false, assignedTo: agent, ticket: await getTicketById(ticketId) };
}

export async function deleteTicket(id) {
  await query('DELETE FROM tickets WHERE id = ?', [id]);
}
