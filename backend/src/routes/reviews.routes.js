const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');

// GET /api/reviews/product/:productId — public, only visible (non-hidden) reviews
router.get('/product/:productId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.id, r.product_rating, r.seller_rating, r.delivery_rating, r.review_text, r.image_urls, r.created_at, u.name AS reviewer_name
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.product_id = $1 AND r.is_hidden = false ORDER BY r.created_at DESC`,
      [req.params.productId]
    );
    res.json({ reviews: rows });
  } catch (err) { next(err); }
});

// POST /api/reviews — spec section 44: only DELIVERED order items can be reviewed
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { order_item_id, product_rating, seller_rating = null, delivery_rating = null, review_text = '', image_urls = [] } = req.body;
    if (!order_item_id || !product_rating) throw new ApiError(400, 'order_item_id and product_rating are required.');

    const itemRes = await db.query(
      `SELECT oi.*, o.user_id, o.status AS order_status FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = $1`,
      [order_item_id]
    );
    const item = itemRes.rows[0];
    if (!item) throw new ApiError(404, 'Order item not found.');
    if (item.user_id !== req.user.id) throw new ApiError(403, 'Not authorized to review this item.');
    if (item.order_status !== 'delivered') throw new ApiError(400, 'You can only review items from delivered orders.');

    const existing = await db.query('SELECT id FROM reviews WHERE order_item_id = $1', [order_item_id]);
    if (existing.rows[0]) throw new ApiError(409, 'You have already reviewed this item.');

    const { rows } = await db.query(
      `INSERT INTO reviews (order_item_id, product_id, seller_id, user_id, product_rating, seller_rating, delivery_rating, review_text, image_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [order_item_id, item.product_id, item.seller_id, req.user.id, product_rating, seller_rating, delivery_rating, review_text, image_urls]
    );

    // Recompute the product's aggregate rating.
    await db.query(
      `UPDATE products SET
         avg_rating = (SELECT AVG(product_rating) FROM reviews WHERE product_id = $1 AND is_hidden = false),
         review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1 AND is_hidden = false)
       WHERE id = $1`,
      [item.product_id]
    );

    res.status(201).json({ review: rows[0] });
  } catch (err) { next(err); }
});

// POST /api/reviews/:id/report — any authenticated user can flag a review
router.post('/:id/report', authenticate, async (req, res, next) => {
  try {
    await db.query('UPDATE reviews SET is_reported = true WHERE id = $1', [req.params.id]);
    res.json({ message: 'Review reported for moderation.' });
  } catch (err) { next(err); }
});

// PATCH /api/reviews/:id/moderate — admin/support hides or restores a review
router.patch('/:id/moderate', authenticate, requireRole('admin', 'super_admin', 'support_agent'), async (req, res, next) => {
  try {
    const { rows } = await db.query('UPDATE reviews SET is_hidden = $1 WHERE id = $2 RETURNING *', [!!req.body.is_hidden, req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'Review not found.');
    await db.query(
      `UPDATE products SET
         avg_rating = COALESCE((SELECT AVG(product_rating) FROM reviews WHERE product_id = $1 AND is_hidden = false), 0),
         review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1 AND is_hidden = false)
       WHERE id = $1`,
      [rows[0].product_id]
    );
    res.json({ review: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
