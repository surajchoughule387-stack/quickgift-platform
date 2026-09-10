const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { ApiError } = require('../middleware/errorHandler');

async function getOrCreateCartId(userId) {
  const existing = await db.query('SELECT id FROM carts WHERE user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await db.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [userId]);
  return created.rows[0].id;
}

// GET /api/cart — full cart with live product prices (never trust stored prices)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const cartId = await getOrCreateCartId(req.user.id);
    const { rows } = await db.query(
      `SELECT ci.id, ci.quantity, ci.gift_wrap, ci.gift_message, ci.delivery_date, ci.saved_for_later,
              p.id AS product_id, p.name, p.base_price, p.mrp, p.gift_wrap_available,
              v.id AS variant_id, v.variant_name, v.variant_value, v.price_delta,
              (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort_order LIMIT 1) AS thumbnail
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN product_variants v ON v.id = ci.variant_id
       WHERE ci.cart_id = $1
       ORDER BY ci.created_at`,
      [cartId]
    );

    const items = rows.map((r) => ({ ...r, unit_price: parseFloat(r.base_price) + parseFloat(r.price_delta || 0) }));
    const activeItems = items.filter((i) => !i.saved_for_later);
    const subtotal = activeItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);

    res.json({ items, subtotal, currency: 'INR' });
  } catch (err) { next(err); }
});

// POST /api/cart/items  { product_id, variant_id?, quantity, gift_wrap?, gift_message?, recipient_id?, delivery_date? }
router.post('/items', authenticate, async (req, res, next) => {
  try {
    const { product_id, variant_id = null, quantity = 1, gift_wrap = false, gift_message = null, recipient_id = null, delivery_date = null } = req.body;
    if (!product_id) throw new ApiError(400, 'product_id is required.');

    const product = await db.query(`SELECT id FROM products WHERE id = $1 AND status = 'approved'`, [product_id]);
    if (!product.rows[0]) throw new ApiError(404, 'Product not available.');

    const cartId = await getOrCreateCartId(req.user.id);
    const { rows } = await db.query(
      `INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, gift_wrap, gift_message, recipient_id, delivery_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cartId, product_id, variant_id, quantity, gift_wrap, gift_message, recipient_id, delivery_date]
    );
    res.status(201).json({ item: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/cart/items/:id  { quantity?, gift_wrap?, gift_message?, saved_for_later? }
router.put('/items/:id', authenticate, async (req, res, next) => {
  try {
    const owns = await db.query(
      `SELECT ci.id FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE ci.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!owns.rows[0]) throw new ApiError(404, 'Cart item not found.');

    const fields = ['quantity', 'gift_wrap', 'gift_message', 'saved_for_later', 'delivery_date'];
    const updates = []; const values = [];
    fields.forEach((f) => { if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); } });
    if (!updates.length) throw new ApiError(400, 'No valid fields to update.');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE cart_items SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    res.json({ item: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/cart/items/:id
router.delete('/items/:id', authenticate, async (req, res, next) => {
  try {
    await db.query(
      `DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND ci.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Removed from cart.' });
  } catch (err) { next(err); }
});

module.exports = router;
