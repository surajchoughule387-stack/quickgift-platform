const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');
const paymentProvider = require('../services/paymentProvider');
const { setOrderStatus } = require('../services/orderStatus');

// GET /api/payments/order/:orderId — check current payment status for an order
router.get('/order/:orderId', authenticate, async (req, res, next) => {
  try {
    const order = await db.query('SELECT user_id FROM orders WHERE id = $1', [req.params.orderId]);
    if (!order.rows[0]) throw new ApiError(404, 'Order not found.');
    if (order.rows[0].user_id !== req.user.id && !['admin', 'super_admin', 'finance_manager'].includes(req.user.role)) {
      throw new ApiError(403, 'Not authorized.');
    }
    const { rows } = await db.query('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [req.params.orderId]);
    res.json({ payments: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhook
// This is the ONLY place a payment is ever marked captured/paid. The frontend
// finishing its checkout SDK flow is NOT sufficient — that would let a client
// simply claim success without paying (spec section 25/33).
//
// Mount this route with express.raw() in server.js (not express.json()) so
// the raw body bytes are available for signature verification, exactly as
// real gateways (Razorpay/Stripe) require.
// ---------------------------------------------------------------------------
router.post('/webhook', async (req, res, next) => {
  try {
    const signature = req.headers['x-webhook-signature'] || req.headers['x-razorpay-signature'] || '';
    const rawBody = req.body; // Buffer, thanks to express.raw() in server.js

    if (!paymentProvider.verifyWebhookSignature(rawBody, signature)) {
      throw new ApiError(400, 'Invalid webhook signature.');
    }

    // Each provider's webhook payload has a different shape (Razorpay nests it
    // under payload.payment.entity, for instance) — parseWebhookEvent normalizes
    // whichever provider is active into { providerPaymentId, status }.
    const { providerPaymentId, status } = paymentProvider.parseWebhookEvent(rawBody);
    if (!providerPaymentId || !status) throw new ApiError(400, 'Could not parse webhook payload.');

    const paymentRes = await db.query('UPDATE payments SET status = $1, webhook_verified = true WHERE provider_payment_id = $2 RETURNING *', [status, providerPaymentId]);
    const payment = paymentRes.rows[0];
    if (!payment) throw new ApiError(404, 'Payment record not found for this webhook event.');

    await db.query(`INSERT INTO transactions (payment_id, type, amount, status, provider_reference) VALUES ($1,'charge',$2,$3,$4)`,
      [payment.id, payment.amount, status, providerPaymentId]);

    if (status === 'captured') {
      const order = await setOrderStatus(payment.order_id, 'payment_confirmed', 'Payment captured via webhook', null);
      await setOrderStatus(order.id, 'order_confirmed', 'Order confirmed after payment', null);

      // Create commission rows now that the sale is real money.
      const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
      for (const item of items.rows) {
        const seller = await db.query('SELECT commission_rate FROM sellers WHERE id = $1', [item.seller_id]);
        const rate = parseFloat(seller.rows[0]?.commission_rate || 12);
        const amount = Math.round(item.unit_price * item.quantity * (rate / 100) * 100) / 100;
        await db.query('INSERT INTO commissions (order_item_id, seller_id, rate, amount) VALUES ($1,$2,$3,$4)', [item.id, item.seller_id, rate, amount]);
      }
    } else if (status === 'failed') {
      await setOrderStatus(payment.order_id, 'cancelled', 'Payment failed', null);
    }

    res.json({ received: true });
  } catch (err) { next(err); }
});

// POST /api/payments/:id/refund — finance_manager/admin only
router.post('/:id/refund', authenticate, requireRole('admin', 'super_admin', 'finance_manager'), async (req, res, next) => {
  try {
    const payment = await db.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (!payment.rows[0]) throw new ApiError(404, 'Payment not found.');
    const { amount = payment.rows[0].amount, reason = '' } = req.body;

    const providerResult = await paymentProvider.refund({ providerPaymentId: payment.rows[0].provider_payment_id, amount });

    const refund = await db.query(
      `INSERT INTO refunds (order_id, payment_id, amount, reason, status, requested_by, processed_by, processed_at)
       VALUES ($1,$2,$3,$4,'refunded',$5,$5,now()) RETURNING *`,
      [payment.rows[0].order_id, payment.rows[0].id, amount, reason, req.user.id]
    );
    await db.query(`INSERT INTO transactions (payment_id, type, amount, status, provider_reference) VALUES ($1,'refund',$2,'refunded',$3)`,
      [payment.rows[0].id, amount, providerResult.providerPaymentId]);

    await setOrderStatus(payment.rows[0].order_id, 'refunded', reason, req.user.id);
    res.json({ refund: refund.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
