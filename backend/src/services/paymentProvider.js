
'use strict';

// ---------------------------------------------------------------------------
// Payment abstraction layer
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const activeProviderName = process.env.PAYMENT_PROVIDER || 'mock';

// ---------------------------------------------------------------------------
// Mock provider — development/testing only
// ---------------------------------------------------------------------------

const mockProvider = {
  name: 'mock',

  async createPaymentIntent({ amount, currency, orderId }) {
    return {
      provider: 'mock',
      providerPaymentId: `mock_pi_${orderId}_${Date.now()}`,
      clientSecret: crypto.randomBytes(16).toString('hex'),
      amount,
      currency
    };
  },

  verifyWebhookSignature() {
    // Never trust mock webhooks in production.
    return process.env.NODE_ENV !== 'production';
  },

  parseWebhookEvent(rawBody) {
    const body = JSON.parse(rawBody.toString('utf8'));

    return {
      providerOrderId: body.providerOrderId || null,
      providerPaymentId: body.providerPaymentId || null,
      providerRefundId: body.providerRefundId || null,
      refundAmount:
        Number.isFinite(body.refundAmount) &&
        body.refundAmount >= 0
          ? body.refundAmount
          : null,
      status: body.status || null,
      event: body.event || null
    };
  },

  async refund({ providerPaymentId, amount }) {
    if (
      typeof providerPaymentId !== 'string' ||
      !providerPaymentId.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error('Invalid payment ID or refund amount.');
    }

    return {
      status: 'refunded',
      providerPaymentId,
      providerRefundId: `mock_refund_${crypto.randomUUID()}`,
      amount
    };
  }
};

// ---------------------------------------------------------------------------
// Razorpay provider
// ---------------------------------------------------------------------------

const razorpayProvider = {
  name: 'razorpay',

  _authHeader() {
    if (
      !process.env.RAZORPAY_KEY_ID ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      throw new Error(
        'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set.'
      );
    }

    const basic = Buffer
      .from(
        `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
      )
      .toString('base64');

    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json'
    };
  },

  async createPaymentIntent({ amount, currency, orderId }) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Invalid payment amount.');
    }

    const res = await fetch(
      'https://api.razorpay.com/v1/orders',
      {
        method: 'POST',
        headers: this._authHeader(),
        body: JSON.stringify({
          amount: Math.round(amount * 100),
          currency,
          receipt: String(orderId),
          notes: {
            quickgift_order_id: String(orderId)
          }
        })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(
        data.error?.description ||
        'Razorpay order creation failed.'
      );
    }

    // Backward compatibility:
    // Existing checkout code reads providerPaymentId.
    // For order creation, this value is the ORDER ID, not a payment ID.
    return {
      provider: 'razorpay',
      providerPaymentId: data.id,
      providerOrderId: data.id,
      amount,
      currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    };
  },

  verifyWebhookSignature(rawBody, signatureHeader) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (
      !secret ||
      !Buffer.isBuffer(rawBody) ||
      typeof signatureHeader !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(signatureHeader)
    ) {
      return false;
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest();

    const received = Buffer.from(signatureHeader, 'hex');

    if (received.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(expected, received);
  },

  parseWebhookEvent(rawBody) {
    const body = JSON.parse(rawBody.toString('utf8'));

    const paymentEntity = body.payload?.payment?.entity;
    const refundEntity = body.payload?.refund?.entity;

    const statusMap = {
      'payment.captured': 'captured',
      'payment.failed': 'failed',
      'refund.processed': 'refunded'
    };

    return {
      providerOrderId: paymentEntity?.order_id || null,

      providerPaymentId:
        paymentEntity?.id ||
        refundEntity?.payment_id ||
        null,

      providerRefundId: refundEntity?.id || null,

      // Razorpay amounts are in the smallest currency unit.
      // Convert to major units for compatibility with existing routes.
      refundAmount:
        Number.isFinite(refundEntity?.amount) &&
        refundEntity.amount >= 0
          ? refundEntity.amount / 100
          : null,

      // Ignore unsupported event types instead of trusting arbitrary status.
      status: statusMap[body.event] || null,

      event: body.event || null
    };
  },

  async refund({ providerPaymentId, amount }) {
    if (
      typeof providerPaymentId !== 'string' ||
      !providerPaymentId.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error('Invalid payment ID or refund amount.');
    }

    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(providerPaymentId)}/refund`,
      {
        method: 'POST',
        headers: this._authHeader(),
        body: JSON.stringify({
          amount: Math.round(amount * 100)
        })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(
        data.error?.description ||
        'Razorpay refund failed.'
      );
    }

    return {
      status: data.status || 'pending',
      providerPaymentId: data.payment_id || providerPaymentId,
      providerRefundId: data.id || null,
      amount:
        Number.isFinite(data.amount)
          ? data.amount / 100
          : amount
    };
  }
};

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

const providers = {
  mock: mockProvider,
  razorpay: razorpayProvider
};

if (!Object.prototype.hasOwnProperty.call(providers, activeProviderName)) {
  throw new Error(
    `Unsupported PAYMENT_PROVIDER: ${activeProviderName}`
  );
}

if (
  process.env.NODE_ENV === 'production' &&
  activeProviderName === 'mock'
) {
  throw new Error(
    'Mock payments are disabled in production. Configure Razorpay.'
  );
}

module.exports = providers[activeProviderName];
