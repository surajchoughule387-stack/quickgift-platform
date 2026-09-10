const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { validateCoupon } = require('../services/couponValidator');
const { ApiError } = require('../middleware/errorHandler');

// POST /api/coupons/validate — used by the cart page to preview a discount
// before checkout actually applies it (checkout re-validates independently).
router.post('/validate', authenticate, async (req, res, next) => {
  try {
    const { code, subtotal, category_id, seller_id, country_id } = req.body;
    if (!code || subtotal === undefined) throw new ApiError(400, 'code and subtotal are required.');
    const result = await validateCoupon(code, { userId: req.user.id, subtotal, categoryId: category_id, sellerId: seller_id, countryId: country_id });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/coupons — admin list
router.get('/', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ coupons: rows });
  } catch (err) { next(err); }
});

// POST /api/coupons — admin create
router.post('/', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { code, type, value, min_order_value = 0, country_id = null, category_id = null, seller_id = null, first_order_only = false, usage_limit = null, expires_at = null } = req.body;
    if (!code || !type || value === undefined) throw new ApiError(400, 'code, type and value are required.');
    const { rows } = await db.query(
      `INSERT INTO coupons (code, type, value, min_order_value, country_id, category_id, seller_id, first_order_only, usage_limit, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [code.toUpperCase(), type, value, min_order_value, country_id, category_id, seller_id, first_order_only, usage_limit, expires_at]
    );
    res.status(201).json({ coupon: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/coupons/:id — admin
router.patch('/:id', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const fields = ['value', 'min_order_value', 'usage_limit', 'expires_at', 'is_active'];
    const updates = []; const values = [];
    fields.forEach((f) => { if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); } });
    if (!updates.length) throw new ApiError(400, 'No valid fields to update.');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE coupons SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    res.json({ coupon: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/coupons/:id — admin
router.delete('/:id', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    await db.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    res.json({ message: 'Coupon deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
