const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// GET /api/categories — public, includes the 22 categories the spec lists
// (Birthday, Anniversary, Wedding, ... International Gifts) once seeded.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, slug, parent_id, icon, sort_order FROM categories
       WHERE is_active = true ORDER BY sort_order, name`
    );
    res.json({ categories: rows });
  } catch (err) { next(err); }
});

// POST /api/categories — admin only
router.post('/', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { name, parent_id = null, icon = null, sort_order = 0 } = req.body;
    if (!name) throw new ApiError(400, 'name is required.');
    const slug = slugify(name);
    const { rows } = await db.query(
      `INSERT INTO categories (name, slug, parent_id, icon, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, slug, parent_id, icon, sort_order]
    );
    res.status(201).json({ category: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/categories/:id — admin only
router.patch('/:id', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const fields = ['name', 'icon', 'sort_order', 'is_active', 'parent_id'];
    const updates = []; const values = [];
    fields.forEach((f) => { if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); } });
    if (!updates.length) throw new ApiError(400, 'No valid fields to update.');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE categories SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (!rows[0]) throw new ApiError(404, 'Category not found.');
    res.json({ category: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/categories/:id — admin only
router.delete('/:id', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    await db.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ message: 'Category deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
