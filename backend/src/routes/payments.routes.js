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

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const lockedResult = await client.query(
      `SELECT *
       FROM payments
       WHERE id = $1
       FOR UPDATE`,
      [payment.id]
    );

    const lockedPayment = lockedResult.rows[0];

    if (!lockedPayment) {
      throw new ApiError(404, 'Payment not found.');
    }

    const existingTx = await client.query(
      `SELECT id, status
       FROM transactions
       WHERE payment_id = $1
         AND type = 'refund'
         AND provider_reference = $2
       FOR UPDATE`,
      [payment.id, providerRefundId]
    );

    if (existingTx.rows[0]) {
      if (existingTx.rows[0].status !== 'refunded') {
        await client.query(
          `UPDATE transactions
           SET status = 'refunded'
           WHERE id = $1`,
          [existingTx.rows[0].id]
        );
      }
    } else {
      
      await client.query(
        `INSERT INTO transactions
         (payment_id, type, amount, status, provider_reference)
         VALUES ($1, 'refund', $2, $3, $4)`,
        [
          payment.id,
          refundAmount,
          refundStatus,
          providerResult.providerRefundId
        ]
      );

    // Mark a matching pending refund as completed.
    await client.query(
      `UPDATE refunds
       SET status = 'refunded',
           processed_at = COALESCE(processed_at, now())
       WHERE id = (
         SELECT id
         FROM refunds
         WHERE payment_id = $1
           AND amount = $2
           AND status IN ('requested', 'approved', 'processing')
         ORDER BY created_at ASC
         LIMIT 1
       )`,
      [payment.id, refundAmount]
    );

    const totals = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE payment_id = $1
         AND type = 'refund'
         AND status = 'refunded'`,
      [payment.id]
    );

    const totalRefunded = Number(totals.rows[0].total);
    const originalAmount = Number(lockedPayment.amount);

    if (totalRefunded > originalAmount) {
      throw new ApiError(
        409,
        'Recorded refunds exceed the original payment amount.'
      );
    }

    const newStatus =
      totalRefunded >= originalAmount
        ? 'refunded'
        : totalRefunded > 0
          ? 'partially_refunded'
          : lockedPayment.status;

    await client.query(
      `UPDATE payments
       SET status = $1,
           webhook_verified = true
       WHERE id = $2`,
      [newStatus, payment.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Refund webhook rollback failed:', rollbackError);
    }

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
// POST /api/payments/:id/refund
router.post(
  '/:id/refund',
  authenticate,
  requireRole('admin', 'super_admin', 'finance_manager'),
  async (req, res, next) => {
    let client;

    try {
      client = await db.getClient();
      await client.query('BEGIN');

      const paymentResult = await client.query(
        `SELECT *
         FROM payments
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );

      const payment = paymentResult.rows[0];

      if (!payment) {
        throw new ApiError(404, 'Payment not found.');
      }

      if (
        !['captured', 'partially_refunded'].includes(
          payment.status
        )
      ) {
        throw new ApiError(
          400,
          'Only captured or partially refunded payments can be refunded.'
        );
      }

      const refundAmount = Number(
        req.body.amount ?? payment.amount
      );

      const reason =
        typeof req.body.reason === 'string'
          ? req.body.reason.trim()
          : '';

      if (
        !Number.isFinite(refundAmount) ||
        refundAmount <= 0 ||
        Math.round(refundAmount * 100) !==
          refundAmount * 100
      ) {
        throw new ApiError(400, 'Invalid refund amount.');
      }

      const refundedResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
         WHERE payment_id = $1
           AND type = 'refund'
           AND status = 'refunded'`,
        [payment.id]
      );

      const refundedTotal = Number(
        refundedResult.rows[0].total
      );

      const remainingAmount =
        Math.round(
          (Number(payment.amount) - refundedTotal) * 100
        ) / 100;

      if (
        refundAmount > remainingAmount ||
        refundAmount > Number(payment.amount)
      ) {
        throw new ApiError(
          400,
          'Refund amount exceeds the remaining refundable amount.'
        );
      }

      if (
        payment.provider !== 'razorpay' &&
        payment.provider !== 'mock'
      ) {
        throw new ApiError(
          400,
          'Unsupported payment provider.'
        );
      }

      if (!payment.provider_payment_id) {
        throw new ApiError(
          400,
          'Provider payment ID is missing.'
        );
      }

      /*
       * IMPORTANT:
       * The external provider may accept the refund even if the
       * database later fails. Reconciliation is still required.
       */
      const providerResult = await paymentProvider.refund({
        providerPaymentId: payment.provider_payment_id,
        amount: refundAmount
      });

      if (!providerResult.providerRefundId) {
        throw new Error(
          'Provider refund ID missing. Manual reconciliation required.'
        );
      }

      const providerStatus = String(
        providerResult.status || 'pending'
      ).toLowerCase();

      const refundCompleted = [
        'processed',
        'refunded'
      ].includes(providerStatus);

      const refundStatus = refundCompleted
        ? 'refunded'
        : 'processing';

      

      await client.query(
        `INSERT INTO refunds
         (order_id, payment_id, amount, reason,
          status, requested_by, processed_by, processed_at,
          provider_refund_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $5 = 'refunded' THEN now() ELSE NULL END,
                 $8)`,
        [
          payment.order_id,
          payment.id,
          refundAmount,
          reason,
          refundStatus,
          req.user.id,
          refundCompleted ? req.user.id : null,
          providerResult.providerRefundId
        ]
      );

      const totalResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
         WHERE payment_id = $1
           AND type = 'refund'
           AND status = 'refunded'`,
        [payment.id]
      );

      const totalRefunded = Number(
        totalResult.rows[0].total
      );

      const fullyRefunded =
        totalRefunded >= Number(payment.amount);

      const newPaymentStatus = fullyRefunded
        ? 'refunded'
        : totalRefunded > 0
          ? 'partially_refunded'
          : payment.status;

      await client.query(
        `UPDATE payments
         SET status = $1
         WHERE id = $2`,
        [newPaymentStatus, payment.id]
      );

      await client.query('COMMIT');

      if (fullyRefunded) {
        await setOrderStatus(
          payment.order_id,
          'refunded',
          reason,
          req.user.id
        );
      }

      return res.json({
        refund: {
          payment_id: payment.id,
          amount: refundAmount,
          provider_refund_id: providerResult.providerRefundId,
          status: refundStatus
        }
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error(
            'Refund rollback failed:',
            rollbackError
          );
        }
      }

      return next(err);
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

module.exports = router;
