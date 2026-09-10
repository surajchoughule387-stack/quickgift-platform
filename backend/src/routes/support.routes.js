const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');

const STAFF_ROLES = ['admin', 'super_admin', 'support_agent', 'ops_manager'];
const CATEGORIES = ['order_issue', 'payment_issue', 'delivery_issue', 'refund', 'product_issue', 'seller_issue', 'other'];

// POST /api/support — customer creates a ticket
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { category, subject, description, order_id = null } = req.body;
    if (!category || !subject) throw new ApiError(400, 'category and subject are required.');
    if (!CATEGORIES.includes(category)) throw new ApiError(400, `category must be one of: ${CATEGORIES.join(', ')}`);

    const { rows } = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, description) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, order_id, category, subject, description || null]
    );
    res.status(201).json({ ticket: rows[0] });
  } catch (err) { next(err); }
});

// GET /api/support — customer sees own tickets; staff sees all (optionally filtered)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const isStaff = STAFF_ROLES.includes(req.user.role);
    const { status, category } = req.query;
    const where = []; const values = [];
    if (!isStaff) { values.push(req.user.id); where.push(`t.user_id = $${values.length}`); }
    if (status) { values.push(status); where.push(`t.status = $${values.length}`); }
    if (category) { values.push(category); where.push(`t.category = $${values.length}`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT t.*, u.name AS customer_name FROM support_tickets t JOIN users u ON u.id = t.user_id ${whereClause} ORDER BY t.created_at DESC`,
      values
    );
    res.json({ tickets: rows });
  } catch (err) { next(err); }
});

// GET /api/support/:id — ticket + message thread
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const ticket = await db.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    if (!ticket.rows[0]) throw new ApiError(404, 'Ticket not found.');
    const isOwner = ticket.rows[0].user_id === req.user.id;
    if (!isOwner && !STAFF_ROLES.includes(req.user.role)) throw new ApiError(403, 'Not authorized.');

    const messages = await db.query(
      `SELECT m.*, u.name AS sender_name FROM support_messages m JOIN users u ON u.id = m.sender_id WHERE m.ticket_id = $1 ORDER BY m.created_at`,
      [req.params.id]
    );
    res.json({ ticket: ticket.rows[0], messages: messages.rows });
  } catch (err) { next(err); }
});

// POST /api/support/:id/messages — customer or assigned agent replies
router.post('/:id/messages', authenticate, async (req, res, next) => {
  try {
    const ticket = await db.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    if (!ticket.rows[0]) throw new ApiError(404, 'Ticket not found.');
    const isOwner = ticket.rows[0].user_id === req.user.id;
    if (!isOwner && !STAFF_ROLES.includes(req.user.role)) throw new ApiError(403, 'Not authorized.');

    const { message } = req.body;
    if (!message) throw new ApiError(400, 'message is required.');
    const { rows } = await db.query(
      `INSERT INTO support_messages (ticket_id, sender_id, message) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, req.user.id, message]
    );
    await db.query(`UPDATE support_tickets SET status = 'in_progress', updated_at = now() WHERE id = $1 AND status = 'open'`, [req.params.id]);
    res.status(201).json({ message: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/support/:id/status — staff only
router.patch('/:id/status', authenticate, requireRole(...STAFF_ROLES), async (req, res, next) => {
  try {
    const { status, assigned_to } = req.body;
    const fields = []; const values = [];
    if (status) { values.push(status); fields.push(`status = $${values.length}`); }
    if (assigned_to) { values.push(assigned_to); fields.push(`assigned_to = $${values.length}`); }
    if (!fields.length) throw new ApiError(400, 'Nothing to update.');
    fields.push('updated_at = now()');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE support_tickets SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (!rows[0]) throw new ApiError(404, 'Ticket not found.');
    res.json({ ticket: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
