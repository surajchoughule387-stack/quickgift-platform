const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');

// Countries/currencies are DATA, not code — this is what keeps the platform
// from being hardcoded to India. Admin manages this list; every other part
// of the app (products, shipping, tax) reads from it.

// GET /api/countries — public
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.iso_code, c.tax_rate, c.is_active, c.supports_cod,
              cur.code AS currency_code, cur.symbol AS currency_symbol
       FROM countries c JOIN currencies cur ON cur.id = c.currency_id
       WHERE c.is_active = true ORDER BY c.name`
    );
    res.json({ countries: rows });
  } catch (err) { next(err); }
});

// POST /api/countries — admin only
router.post('/', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { name, iso_code, currency_code, tax_rate = 0, supports_cod = false } = req.body;
    if (!name || !iso_code || !currency_code) throw new ApiError(400, 'name, iso_code and currency_code are required.');

    const cur = await db.query('SELECT id FROM currencies WHERE code = $1', [currency_code]);
    if (!cur.rows[0]) throw new ApiError(400, `Currency ${currency_code} does not exist — create it first via POST /api/currencies.`);

    const { rows } = await db.query(
      `INSERT INTO countries (name, iso_code, currency_id, tax_rate, supports_cod)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, iso_code, cur.rows[0].id, tax_rate, supports_cod]
    );
    res.status(201).json({ country: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/countries/:id — admin only (activate/deactivate, adjust tax etc.)
router.patch('/:id', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const fields = ['name', 'tax_rate', 'is_active', 'supports_cod'];
    const updates = [];
    const values = [];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); }
    });
    if (!updates.length) throw new ApiError(400, 'No valid fields to update.');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE countries SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (!rows[0]) throw new ApiError(404, 'Country not found.');
    res.json({ country: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
