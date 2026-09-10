const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { ApiError } = require('../middleware/errorHandler');

async function getOrCreateWishlistId(userId) {
  const existing = await db.query('SELECT id FROM wishlists WHERE user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await db.query('INSERT INTO wishlists (user_id) VALUES ($1) RETURNING id', [userId]);
  return created.rows[0].id;
}

// GET /api/wishlist
router.get('/', authenticate, async (req, res, next) => {
  try {
    const wishlistId = await getOrCreateWishlistId(req.user.id);
    const { rows } = await db.query(
      `SELECT wi.id AS wishlist_item_id, wi.added_at, p.id, p.name, p.slug, p.base_price, p.mrp, p.avg_rating,
              (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort_order LIMIT 1) AS thumbnail
       FROM wishlist_items wi JOIN products p ON p.id = wi.product_id
       WHERE wi.wishlist_id = $1 ORDER BY wi.added_at DESC`,
      [wishlistId]
    );
    res.json({ items: rows });
  } catch (err) { next(err); }
});

// POST /api/wishlist/:productId
router.post('/:productId', authenticate, async (req, res, next) => {
  try {
    const wishlistId = await getOrCreateWishlistId(req.user.id);
    await db.query(
      `INSERT INTO wishlist_items (wishlist_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [wishlistId, req.params.productId]
    );
    res.status(201).json({ message: 'Added to wishlist.' });
  } catch (err) { next(err); }
});

// DELETE /api/wishlist/:productId
router.delete('/:productId', authenticate, async (req, res, next) => {
  try {
    const wishlistId = await getOrCreateWishlistId(req.user.id);
    await db.query('DELETE FROM wishlist_items WHERE wishlist_id = $1 AND product_id = $2', [wishlistId, req.params.productId]);
    res.json({ message: 'Removed from wishlist.' });
  } catch (err) { next(err); }
});

// POST /api/wishlist/:productId/move-to-cart
router.post('/:productId/move-to-cart', authenticate, async (req, res, next) => {
  try {
    const cart = await db.query('SELECT id FROM carts WHERE user_id = $1', [req.user.id]);
    const cartId = cart.rows[0] ? cart.rows[0].id : (await db.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [req.user.id])).rows[0].id;
    await db.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1,$2,1)', [cartId, req.params.productId]);
    const wishlistId = await getOrCreateWishlistId(req.user.id);
    await db.query('DELETE FROM wishlist_items WHERE wishlist_id = $1 AND product_id = $2', [wishlistId, req.params.productId]);
    res.json({ message: 'Moved to cart.' });
  } catch (err) { next(err); }
});

module.exports = router;
