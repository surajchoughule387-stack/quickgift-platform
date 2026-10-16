const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ApiError } = require('../middleware/errorHandler');
const paymentProvider = require('../services/paymentProvider');
const { setOrderStatus } = require('../services/orderStatus');

// GET /api/payments/order/:orderId
router.get('/order/:orderId', authenticate, async (req, res, next) => {
  try {
    const order = await db.query(
      'SELECT user_id FROM orders WHERE id = $1',
      [req.params.orderId]
    );

    if (!order.rows[0]) {
      throw new ApiError(404, 'Order not found.');
    }

    if (
      order.rows[0].user_id !== req.user.id &&
      !['admin', 'super_admin', 'finance_manager'].includes(req.user.role)
    ) {
      throw new ApiError(403, 'Not authorized.');
    }

    const { rows } = await db.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
      [req.params.orderId]
    );

    res.json({ payments: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/webhook
router.post('/webhook', async (req, res, next) => {
  try {
    const signature =
      req.headers['x-webhook-signature'] ||
      req.headers['x-razorpay-signature'] ||
      '';

    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      throw new ApiError(400, 'Webhook body must be raw bytes.');
    }

    if (!paymentProvider.verifyWebhookSignature(rawBody, signature)) {
      throw new ApiError(400, 'Invalid webhook signature.');
    }

    const parsed = paymentProvider.parseWebhookEvent(rawBody);

  

    const {
  providerOrderId = null,
  providerPaymentId,
  providerRefundId = null,
  refundAmount = null,
  status,
  event = null
} = parsed;
    if (!providerPaymentId || !status) {
      throw new ApiError(
        400,
        'Could not parse webhook payload.'
      );
    }


        // Find payment using Razorpay ORDER ID.
    let paymentRes;

    if (providerOrderId) {
      paymentRes = await db.query(
        `SELECT * FROM payments
         WHERE provider = $1
           AND provider_order_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        ['razorpay', providerOrderId]
      );
    }

    // Fallback: find using Razorpay PAYMENT ID.
    if (!paymentRes?.rows[0]) {
      paymentRes = await db.query(
        `SELECT * FROM payments
         WHERE provider = $1
           AND provider_payment_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        ['razorpay', providerPaymentId]
      );
    }

    const payment = paymentRes.rows[0];

    if (!payment) {
      throw new ApiError(
        404,
        'Payment record not found for this webhook event.'
      );
    }
    
  // Ignore duplicate non-refund webhook events.
if (
  event !== 'refund.processed' &&
  payment.webhook_verified &&
  payment.status === status
) {
  return res.json({
    received: true,
    duplicate: true
  });
}

    // Refund webhook.
    if (event === 'refund.processed') {
      if (
        !providerRefundId ||
        !providerPaymentId ||
        !Number.isFinite(refundAmount) ||
        refundAmount <= 0
      ) {
        throw new ApiError(
          400,
          'Refund ID, payment ID and valid refund amount are required.'
        );
      }

      const existingRefundTx = await db.query(
        `SELECT id FROM transactions
         WHERE payment_id = $1
           AND type = 'refund'
           AND provider_reference = $2
         LIMIT 1`,
        [payment.id, providerRefundId]
      );

      if (existingRefundTx.rows[0]) {
        return res.json({
          received: true,
          duplicate: true
        });
      }

      const client = await db.getClient();

      try {
        await client.query('BEGIN');

        const lockedPayment = await client.query(
          `SELECT * FROM payments
           WHERE id = $1
           FOR UPDATE`,
          [payment.id]
        );

        if (!lockedPayment.rows[0]) {
          throw new ApiError(404, 'Payment not found.');
        }

        const duplicate = await client.query(
          `SELECT id FROM transactions
           WHERE payment_id = $1
             AND type = 'refund'
             AND provider_reference = $2
           LIMIT 1`,
          [payment.id, providerRefundId]
        );

        if (!duplicate.rows[0]) {
          await client.query(
            `INSERT INTO transactions
             (payment_id, type, amount, status, provider_reference)
             VALUES ($1, 'refund', $2, 'refunded', $3)`,
            [payment.id, refundAmount, providerRefundId]
          );
        }

        const totalRefunds = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS total
           FROM transactions
           WHERE payment_id = $1
             AND type = 'refund'
             AND status = 'refunded'`,
          [payment.id]
        );

        const fullyRefunded =
          Number(totalRefunds.rows[0].total) >=
          Number(lockedPayment.rows[0].amount);

        await client.query(
          `UPDATE payments
           SET status = $1,
               webhook_verified = true
           WHERE id = $2`,
          [
            fullyRefunded ? 'refunded' : 'partially_refunded',
            payment.id
          ]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return res.json({ received: true });
    }
    
    // Update payment with the REAL Razorpay Payment ID.
    const updatedPaymentRes = await db.query(
      `UPDATE payments
       SET status = $1,
           webhook_verified = true,
           provider_payment_id = $2
       WHERE id = $3
       RETURNING *`,
      [
        status,
        providerPaymentId,
        payment.id
      ]
    );

    const updatedPayment =
      updatedPaymentRes.rows[0];

    // Prevent duplicate transaction.
    const existingChargeTx = await db.query(
      `SELECT id FROM transactions
       WHERE payment_id = $1
         AND type = $2
         AND provider_reference = $3
       LIMIT 1`,
      [
        updatedPayment.id,
        'charge',
        providerPaymentId
      ]
    );

    if (!existingChargeTx.rows[0]) {
      await db.query(
        `INSERT INTO transactions
         (payment_id, type, amount, status, provider_reference)
         VALUES ($1, 'charge', $2, $3, $4)`,
        [
          updatedPayment.id,
          updatedPayment.amount,
          status,
          providerPaymentId
        ]
      );
    }

    // Successful payment.
    if (status === 'captured') {
      const order = await setOrderStatus(
        updatedPayment.order_id,
        'payment_confirmed',
        'Payment captured via webhook',
        null
      );

      await setOrderStatus(
        order.id,
        'order_confirmed',
        'Order confirmed after payment',
        null
      );

      const items = await db.query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [order.id]
      );

      for (const item of items.rows) {
        const seller = await db.query(
          'SELECT commission_rate FROM sellers WHERE id = $1',
          [item.seller_id]
        );

        const rate = parseFloat(
          seller.rows[0]?.commission_rate || 12
        );

        const amount =
          Math.round(
            item.unit_price *
            item.quantity *
            (rate / 100) *
            100
          ) / 100;

        const existingCommission = await db.query(
          `SELECT id FROM commissions
           WHERE order_item_id = $1
           LIMIT 1`,
          [item.id]
        );

        if (!existingCommission.rows[0]) {
          await db.query(
            `INSERT INTO commissions
             (order_item_id, seller_id, rate, amount)
             VALUES ($1, $2, $3, $4)`,
            [
              item.id,
              item.seller_id,
              rate,
              amount
            ]
          );
        }
      }
    }

    // Failed payment.
    else if (status === 'failed') {
      await setOrderStatus(
        updatedPayment.order_id,
        'cancelled',
        'Payment failed',
        null
      );
    }

    res.json({
      received: true
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/:id/refund
router.post(
  '/:id/refund',
  authenticate,
  requireRole(
    'admin',
    'super_admin',
    'finance_manager'
  ),
  async (req, res, next) => {
    try {
      const payment = await db.query(
        'SELECT * FROM payments WHERE id = $1',
        [req.params.id]
      );

      if (!payment.rows[0]) {
        throw new ApiError(
          404,
          'Payment not found.'
        );
      }

      const {
        amount = payment.rows[0].amount,
        reason = ''
      } = req.body;

      const providerResult =
        await paymentProvider.refund({
          providerPaymentId:
            payment.rows[0].provider_payment_id,
          amount
        });

      const refund = await db.query(
        `INSERT INTO refunds
         (order_id, payment_id, amount, reason,
          status, requested_by, processed_by, processed_at)
         VALUES
         ($1, $2, $3, $4, 'refunded',
          $5, $5, now())
         RETURNING *`,
        [
          payment.rows[0].order_id,
          payment.rows[0].id,
          amount,
          reason,
          req.user.id
        ]
      );

      await db.query(
        `INSERT INTO transactions
         (payment_id, type, amount, status, provider_reference)
         VALUES ($1, 'refund', $2, 'refunded', $3)`,
        [
          payment.rows[0].id,
          amount,
          providerResult.providerRefundId
        ]
      );

      await setOrderStatus(
        payment.rows[0].order_id,
        'refunded',
        reason,
        req.user.id
      );

      res.json({
        refund: refund.rows[0]
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
