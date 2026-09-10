const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { ApiError } = require('../middleware/errorHandler');

// GET /api/addresses — the logged-in user's saved addresses
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, c.name AS country_name, c.iso_code FROM addresses a LEFT JOIN countries c ON c.id = a.country_id
       WHERE a.user_id = $1 ORDER BY a.is_default DESC, a.created_at DESC`,
      [req.user.id]
    );
    res.json({ addresses: rows });
  } catch (err) { next(err); }
});

// POST /api/addresses  { label, line1, line2?, landmark?, city, state?, postal_code, country_id, is_default? }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { label = 'Home', line1, line2 = null, landmark = null, city, state = null, postal_code, country_id, is_default = false } = req.body;
    if (!line1 || !city || !postal_code || !country_id) throw new ApiError(400, 'line1, city, postal_code and country_id are required.');

    if (is_default) await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);

    const { rows } = await db.query(
      `INSERT INTO addresses (user_id, label, line1, line2, landmark, city, state, postal_code, country_id, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, label, line1, line2, landmark, city, state, postal_code, country_id, is_default]
    );
    res.status(201).json({ address: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/addresses/:id
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const owns = await db.query('SELECT id FROM addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!owns.rows[0]) throw new ApiError(404, 'Address not found.');

    const fields = ['label', 'line1', 'line2', 'landmark', 'city', 'state', 'postal_code', 'country_id', 'is_default'];
    const updates = []; const values = [];
    fields.forEach((f) => { if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); } });
    if (!updates.length) throw new ApiError(400, 'No valid fields to update.');
    if (req.body.is_default) await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE addresses SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    res.json({ address: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/addresses/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Address deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
