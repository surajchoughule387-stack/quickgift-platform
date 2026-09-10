const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');
const { notifyOrderEvent, EVENTS } = require('../services/notification');

// ---------------------------------------------------------------------------
// POST /api/sellers/register — any logged-in user applies to become a seller.
// Their account role is switched to 'seller' immediately (so the Partner app
// unlocks) but sellers.status starts at 'pending' — they cannot list products
// until an admin approves them (spec section 15/17).
// ---------------------------------------------------------------------------
router.post('/register', authenticate, async (req, res, next) => {
  try {
    const already = await db.query('SELECT id FROM sellers WHERE user_id = $1', [req.user.id]);
    if (already.rows[0]) throw new ApiError(409, 'A seller profile already exists for this account.');

    const { business_name, business_email, business_phone, business_address, country_id, tax_info, bank_account_info, documents = [] } = req.body;
    if (!business_name) throw new ApiError(400, 'business_name is required.');

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const sellerRes = await client.query(
        `INSERT INTO sellers (user_id, business_name, business_email, business_phone, business_address, country_id, tax_info, bank_account_info, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [req.user.id, business_name, business_email, business_phone, business_address, country_id, tax_info, bank_account_info || {}]
      );
      const seller = sellerRes.rows[0];

      for (const doc of documents) {
        await client.query('INSERT INTO seller_documents (seller_id, doc_type, file_url) VALUES ($1,$2,$3)', [seller.id, doc.doc_type, doc.file_url]);
      }

      const sellerRoleId = await client.query("SELECT id FROM roles WHERE name = 'seller'");
      await client.query('UPDATE users SET role_id = $1 WHERE id = $2', [sellerRoleId.rows[0].id, req.user.id]);

      await client.query('COMMIT');
      res.status(201).json({ seller, message: 'Seller application submitted. An admin will review your documents before you can list products.' });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch (err) { next(err); }
});

async function getOwnSeller(userId) {
  const { rows } = await db.query('SELECT * FROM sellers WHERE user_id = $1', [userId]);
  if (!rows[0]) throw new ApiError(404, 'No seller profile found for this account.');
  return rows[0];
}

// GET /api/sellers/me
router.get('/me', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    res.json({ seller: await getOwnSeller(req.user.id) });
  } catch (err) { next(err); }
});

// GET /api/sellers/me/dashboard — spec section 16
router.get('/me/dashboard', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await getOwnSeller(req.user.id);

    const [todayOrders, revenue, pendingOrders, lowStock, reviews, totalProducts] = await Promise.all([
      db.query(`SELECT COUNT(DISTINCT order_id) FROM order_items WHERE seller_id = $1 AND order_id IN (SELECT id FROM orders WHERE placed_at::date = CURRENT_DATE)`, [seller.id]),
      db.query(`SELECT COALESCE(SUM(unit_price * quantity),0) AS total FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.seller_id = $1 AND o.status NOT IN ('cancelled','pending_payment')`, [seller.id]),
      db.query(`SELECT COUNT(*) FROM order_items WHERE seller_id = $1 AND item_status = 'pending'`, [seller.id]),
      db.query(`SELECT p.id, p.name, COALESCE(SUM(i.quantity),0) AS stock FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.seller_id = $1 GROUP BY p.id HAVING COALESCE(SUM(i.quantity),0) <= 5`, [seller.id]),
      db.query(`SELECT COUNT(*), AVG(product_rating) AS avg FROM reviews WHERE seller_id = $1`, [seller.id]),
      db.query(`SELECT COUNT(*) FROM products WHERE seller_id = $1`, [seller.id])
    ]);

    res.json({
      seller,
      today_orders: parseInt(todayOrders.rows[0].count, 10),
      total_revenue: parseFloat(revenue.rows[0].total),
      pending_orders: parseInt(pendingOrders.rows[0].count, 10),
      low_stock_products: lowStock.rows,
      total_reviews: parseInt(reviews.rows[0].count, 10),
      avg_rating: parseFloat(reviews.rows[0].avg || 0),
      total_products: parseInt(totalProducts.rows[0].count, 10)
    });
  } catch (err) { next(err); }
});

// GET /api/sellers/me/products — seller's own catalog, any status
router.get('/me/products', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await getOwnSeller(req.user.id);
    const { rows } = await db.query(
      `SELECT p.*, (SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE product_id = p.id) AS stock,
              (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort_order LIMIT 1) AS thumbnail
       FROM products p WHERE p.seller_id = $1 ORDER BY p.created_at DESC`,
      [seller.id]
    );
    res.json({ products: rows });
  } catch (err) { next(err); }
});

// PUT /api/sellers/me/products/:id/inventory  { quantity, warehouse_id?, variant_id? }
router.put('/me/products/:id/inventory', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await getOwnSeller(req.user.id);
    const product = await db.query('SELECT id FROM products WHERE id = $1 AND seller_id = $2', [req.params.id, seller.id]);
    if (!product.rows[0]) throw new ApiError(404, 'Product not found for this seller.');

    const { quantity, warehouse_id = null, variant_id = null } = req.body;
    const existing = await db.query(
      'SELECT id FROM inventory WHERE product_id = $1 AND (variant_id = $2 OR ($2::int IS NULL AND variant_id IS NULL))',
      [req.params.id, variant_id]
    );
    if (existing.rows[0]) {
      await db.query('UPDATE inventory SET quantity = $1, warehouse_id = $2, updated_at = now() WHERE id = $3', [quantity, warehouse_id, existing.rows[0].id]);
    } else {
      await db.query('INSERT INTO inventory (product_id, variant_id, warehouse_id, quantity) VALUES ($1,$2,$3,$4)', [req.params.id, variant_id, warehouse_id, quantity]);
    }
    res.json({ message: 'Inventory updated.' });
  } catch (err) { next(err); }
});

// GET /api/sellers/me/orders — order items belonging to this seller (spec section 18)
router.get('/me/orders', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await getOwnSeller(req.user.id);
    const { status } = req.query;
    const where = ['oi.seller_id = $1'];
    const values = [seller.id];
    if (status) { values.push(status); where.push(`oi.item_status = $${values.length}`); }

    const { rows } = await db.query(
      `SELECT oi.*, o.order_number, o.status AS order_status, o.delivery_date, o.placed_at, o.currency_code
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE ${where.join(' AND ')} ORDER BY o.placed_at DESC`,
      values
    );
    res.json({ order_items: rows });
  } catch (err) { next(err); }
});

// PATCH /api/sellers/me/orders/:itemId/status  { status: accepted|rejected|preparing|packed, tracking_number? }
router.patch('/me/orders/:itemId/status', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await getOwnSeller(req.user.id);
    const { status, tracking_number } = req.body;
    const allowed = ['accepted', 'rejected', 'preparing', 'packed'];
    if (!allowed.includes(status)) throw new ApiError(400, `status must be one of: ${allowed.join(', ')}`);

    const item = await db.query('SELECT * FROM order_items WHERE id = $1 AND seller_id = $2', [req.params.itemId, seller.id]);
    if (!item.rows[0]) throw new ApiError(404, 'Order item not found for this seller.');

    await db.query('UPDATE order_items SET item_status = $1 WHERE id = $2', [status, req.params.itemId]);

    const orderId = item.rows[0].order_id;
    const statusMap = { accepted: 'seller_accepted', rejected: 'cancelled', preparing: 'preparing', packed: 'packed' };
    await db.query(
      `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2`,
      [statusMap[status], orderId]
    );
    await db.query(`INSERT INTO order_status_history (order_id, status, note, changed_by) VALUES ($1,$2,$3,$4)`,
      [orderId, statusMap[status], `Seller marked item ${status}`, req.user.id]);

    const order = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const eventMap = { accepted: EVENTS.SELLER_ACCEPTED, packed: EVENTS.ORDER_PACKED };
    if (eventMap[status]) await notifyOrderEvent(order.rows[0].user_id, eventMap[status], order.rows[0]);

    if (status === 'packed' && tracking_number) {
      await db.query(
        `INSERT INTO shipments (order_id, tracking_number, status) VALUES ($1,$2,'label_created')
         ON CONFLICT DO NOTHING`,
        [orderId, tracking_number]
      );
    }

    res.json({ message: `Order item marked ${status}.` });
  } catch (err) { next(err); }
});

// GET /api/sellers/me/payouts
router.get('/me/payouts', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await getOwnSeller(req.user.id);
    const { rows } = await db.query('SELECT * FROM payouts WHERE seller_id = $1 ORDER BY created_at DESC', [seller.id]);
    res.json({ payouts: rows });
  } catch (err) { next(err); }
});

module.exports = router;
