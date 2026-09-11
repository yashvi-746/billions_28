import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listTickets,
  getTicketById,
  createTicket,
  assignTicket,
  deleteTicket,
  listComments,
} from '../services/ticketService.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await listTickets({
      orgId: req.user.orgId,
      page: Number(req.query.page || 1),
      search: req.query.search || '',
      status: req.query.status,
      priority: req.query.priority,
      sortBy: req.query.sortBy || 'created_at',
      order: req.query.order || 'desc',
      breached: req.query.breached === 'true' || req.query.breached === '1',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id));
    // Return 404 (not 403) for cross-org tickets so we don't confirm to a
    // caller that a given id exists in another organisation.
    if (!ticket || ticket.org_id !== req.user.orgId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const comments = await listComments(ticket.id);
    res.json({ ticket, comments });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { subject, body, priority } = req.body;
    if (!subject || !body) {
      return res.status(400).json({ error: 'subject and body are required' });
    }
    const ticket = await createTicket({
      orgId: req.user.orgId,
      subject,
      body,
      priority: priority || 'P3',
      requesterId: req.user.id,
    });
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

// Claiming a ticket is an agent action (README: "agent — claim and answer any
// ticket"). Requesters must not be able to claim tickets, in their own org or
// anyone else's.
router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const ticketId = Number(req.params.id);
    const existing = await getTicketById(ticketId);
    if (!existing || existing.org_id !== req.user.orgId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const result = await assignTicket(ticketId, req.user.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.conflict) {
      return res.status(409).json({ error: 'Ticket already assigned', ticket: result.ticket });
    }
    res.json(result.ticket);
  } catch (err) {
    next(err);
  }
});

// README: "admin — everything an agent can, plus delete tickets". Deletion
// also has to stay inside the caller's organisation.
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id));
    if (!ticket || ticket.org_id !== req.user.orgId) {
      return res.status(404).json({ error: 'Not found' });
    }
    await deleteTicket(ticket.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
