const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');
const { generateOrderNumber } = require('../utils/orderNumber');
const { setOrderStatus } = require('../services/orderStatus');
const { validateCoupon } = require('../services/couponValidator');
const { notifyOrderEvent, EVENTS } = require('../services/notification');
const paymentProvider = require('../services/paymentProvider');

// ---------------------------------------------------------------------------
// POST /api/orders/checkout
// This is the one place order totals get calculated. Every number here comes
// from the database, never from req.body — the frontend cannot set its own
// price, discount, or total (spec section 44).
// ---------------------------------------------------------------------------
router.post('/checkout', authenticate, async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { delivery_address_id, recipient_id = null, coupon_code = null, delivery_date = null, delivery_time_slot = null, payment_method = 'card' } = req.body;
    if (!delivery_address_id) throw new ApiError(400, 'delivery_address_id is required.');

    const address = await db.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [delivery_address_id, req.user.id]);
    if (!address.rows[0]) throw new ApiError(404, 'Delivery address not found.');
    const country = await db.query(
      `SELECT c.*, cur.code AS currency_code FROM countries c JOIN currencies cur ON cur.id = c.currency_id WHERE c.id = $1`,
      [address.rows[0].country_id]
    );
    if (!country.rows[0]) throw new ApiError(400, 'Delivery country is not configured. Set country_id on the address, or add the country via admin.');
    if (payment_method === 'cod' && !country.rows[0].supports_cod) {
      throw new ApiError(400, 'Cash on Delivery is not available for this country.');
    }

    const cart = await db.query('SELECT id FROM carts WHERE user_id = $1', [req.user.id]);
    if (!cart.rows[0]) throw new ApiError(400, 'Cart is empty.');

    const itemsRes = await db.query(
      `SELECT ci.id AS cart_item_id, ci.quantity, ci.gift_wrap, ci.gift_message, ci.variant_id,
              p.id AS product_id, p.name, p.base_price, p.seller_id, p.category_id, p.status,
              v.price_delta,
              (SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE product_id = p.id
               AND (variant_id = ci.variant_id OR (ci.variant_id IS NULL AND variant_id IS NULL))) AS available_stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN product_variants v ON v.id = ci.variant_id
       WHERE ci.cart_id = $1 AND ci.saved_for_later = false`,
      [cart.rows[0].id]
    );
    if (!itemsRes.rows.length) throw new ApiError(400, 'Cart is empty.');

    // Server-side stock + availability check (spec section 44) — never trust the client.
    const unavailable = itemsRes.rows.filter((i) => i.status !== 'approved' || parseInt(i.available_stock, 10) < i.quantity);
    if (unavailable.length) {
      throw new ApiError(409, `Some items are no longer available in the requested quantity: ${unavailable.map((i) => i.name).join(', ')}`);
    }

    const priced = itemsRes.rows.map((i) => ({
      ...i,
      unit_price: parseFloat(i.base_price) + parseFloat(i.price_delta || 0)
    }));
    const subtotal = priced.reduce((s, i) => s + i.unit_price * i.quantity, 0);

    // Coupon (optional) — validated server-side, discount recomputed here, not trusted from body.
    let discount = 0, appliedCoupon = null;
    if (coupon_code) {
      const result = await validateCoupon(coupon_code, {
        userId: req.user.id, subtotal, categoryId: priced[0]?.category_id, countryId: country.rows[0].id
      });
      if (!result.valid) throw new ApiError(400, result.reason);
      discount = result.discount;
      appliedCoupon = result.coupon;
    }

    const taxRate = parseFloat(country.rows[0].tax_rate) || 0;
    const taxAmount = Math.round((subtotal - discount) * (taxRate / 100) * 100) / 100;
    const shippingAmount = 0; // TODO: wire shipping_methods cost calc (weight/zone) once couriers are configured
    const codCharge = payment_method === 'cod' ? 30 : 0;
    const totalAmount = Math.round((subtotal - discount + taxAmount + shippingAmount + codCharge) * 100) / 100;

    await client.query('BEGIN');

    const orderNumber = generateOrderNumber();
    const orderInsert = await client.query(
      `INSERT INTO orders (order_number, user_id, recipient_id, delivery_address_id, country_id, currency_code,
                            subtotal, discount_amount, tax_amount, shipping_amount, total_amount, coupon_id,
                            delivery_date, delivery_time_slot, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_payment') RETURNING *`,
      [orderNumber, req.user.id, recipient_id, delivery_address_id, country.rows[0].id, country.rows[0].currency_code,
       subtotal, discount, taxAmount, shippingAmount, totalAmount, appliedCoupon ? appliedCoupon.id : null,
       delivery_date, delivery_time_slot]
    );
    const order = orderInsert.rows[0];

    for (const item of priced) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, seller_id, product_name_snapshot, unit_price, quantity, gift_wrap, gift_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, item.product_id, item.variant_id, item.seller_id, item.name, item.unit_price, item.quantity, item.gift_wrap, item.gift_message]
      );
      // Reserve stock immediately. Production note: for a payment window longer
      // than a few minutes, reserve with an expiry and release on timeout instead.
      await client.query(
        `UPDATE inventory SET quantity = quantity - $1, updated_at = now()
         WHERE product_id = $2 AND (variant_id = $3 OR ($3::int IS NULL AND variant_id IS NULL))`,
        [item.quantity, item.product_id, item.variant_id]
      );
    }

    if (appliedCoupon) {
      await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [appliedCoupon.id]);
    }

    await client.query(
      `INSERT INTO order_status_history (order_id, status, note, changed_by) VALUES ($1,'pending_payment','Order created',$2)`,
      [order.id, req.user.id]
    );

    // Clear purchased items out of the cart.
    await client.query(`DELETE FROM cart_items WHERE cart_id = $1 AND saved_for_later = false`, [cart.rows[0].id]);

    await client.query('COMMIT');

    await notifyOrderEvent(req.user.id, EVENTS.ORDER_PLACED, order);

    // Create the payment intent the frontend's payment SDK will confirm against.
    const intent = await paymentProvider.createPaymentIntent({ amount: totalAmount, currency: country.rows[0].currency_code, orderId: order.id });
    await db.query(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount, currency_code, method)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [order.id, intent.provider, intent.providerPaymentId, totalAmount, country.rows[0].currency_code, payment_method]
    );

    res.status(201).json({ order, payment_intent: intent });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/orders — the logged-in customer's own orders
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o WHERE o.user_id = $1 ORDER BY o.placed_at DESC`,
      [req.user.id]
    );
    res.json({ orders: rows });
  } catch (err) { next(err); }
});

// GET /api/orders/:id — full detail (owner, or admin/support)
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const orderRes = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) throw new ApiError(404, 'Order not found.');
    const isOwner = order.user_id === req.user.id;
    const isStaff = ['admin', 'super_admin', 'ops_manager', 'support_agent'].includes(req.user.role);
    if (!isOwner && !isStaff) throw new ApiError(403, 'Not authorized to view this order.');

    const items = await db.query(
      `SELECT oi.*, s.business_name AS seller_name FROM order_items oi JOIN sellers s ON s.id = oi.seller_id WHERE oi.order_id = $1`,
      [order.id]
    );
    const history = await db.query('SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [order.id]);
    res.json({ order, items: items.rows, history: history.rows });
  } catch (err) { next(err); }
});

// GET /api/orders/:id/tracking
router.get('/:id/tracking', authenticate, async (req, res, next) => {
  try {
    const orderRes = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.user_id !== req.user.id && !['admin', 'super_admin', 'ops_manager', 'support_agent'].includes(req.user.role)) {
      throw new ApiError(403, 'Not authorized.');
    }
    const shipment = await db.query(
      `SELECT s.*, c.name AS courier_name, c.tracking_url_template FROM shipments s LEFT JOIN couriers c ON c.id = s.courier_id WHERE s.order_id = $1`,
      [order.id]
    );
    let events = [];
    if (shipment.rows[0]) {
      events = (await db.query('SELECT * FROM tracking_events WHERE shipment_id = $1 ORDER BY event_time', [shipment.rows[0].id])).rows;
    }
    res.json({ order_status: order.status, shipment: shipment.rows[0] || null, events });
  } catch (err) { next(err); }
});

// POST /api/orders/:id/cancel
router.post('/:id/cancel', authenticate, async (req, res, next) => {
  try {
    const orderRes = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.user_id !== req.user.id) throw new ApiError(403, 'Not authorized.');
    const cancellable = ['pending_payment', 'payment_confirmed', 'order_confirmed', 'seller_accepted', 'preparing'];
    if (!cancellable.includes(order.status)) throw new ApiError(400, `Order cannot be cancelled once it is "${order.status}".`);

    // Restock cancelled items.
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    for (const item of items.rows) {
      await db.query(
        `UPDATE inventory SET quantity = quantity + $1 WHERE product_id = $2 AND (variant_id = $3 OR ($3::int IS NULL AND variant_id IS NULL))`,
        [item.quantity, item.product_id, item.variant_id]
      );
    }
    const updated = await setOrderStatus(order.id, 'cancelled', req.body.reason || 'Cancelled by customer', req.user.id);
    res.json({ order: updated });
  } catch (err) { next(err); }
});

// PATCH /api/orders/:id/status — admin/ops override (sellers use /api/sellers/me/orders/:itemId/status instead)
router.patch('/:id/status', authenticate, requireRole('admin', 'super_admin', 'ops_manager'), async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (!status) throw new ApiError(400, 'status is required.');
    const order = await setOrderStatus(req.params.id, status, note, req.user.id);
    res.json({ order });
  } catch (err) { next(err); }
});

module.exports = router;
