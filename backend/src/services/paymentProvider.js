// ---------------------------------------------------------------------------
// Payment abstraction layer
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const activeProviderName = process.env.PAYMENT_PROVIDER || 'mock';

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
    return true;
  },

  parseWebhookEvent(rawBody) {
    const body = JSON.parse(rawBody.toString('utf8'));

    return {
      providerPaymentId: body.providerPaymentId,
      status: body.status
    };
  },

  async refund({ providerPaymentId, amount }) {
    return {
      status: 'refunded',
      providerPaymentId,
      amount
    };
  }
};

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

const razorpayProvider = {
  name: 'razorpay',

  _authHeader() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error(
        'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env to use PAYMENT_PROVIDER=razorpay'
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
        data.error?.description || 'Razorpay order creation failed'
      );
    }

    // This is Razorpay ORDER ID.
    // Actual PAYMENT ID comes later through the verified webhook.
    return {
      provider: 'razorpay',
      providerPaymentId: data.id,
      amount,
      currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    };
  },

  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error(
        'RAZORPAY_WEBHOOK_SECRET is not set — refusing to trust an unverifiable webhook.'
      );

      return false;
    }

    const expected = crypto
      .createHmac(
        'sha256',
        process.env.RAZORPAY_WEBHOOK_SECRET
      )
      .update(rawBody)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signatureHeader || '')
      );
    } catch {
      return false;
    }
  },

  // Keep both Razorpay IDs:
  // providerOrderId   = order_xxx
  // providerPaymentId = pay_xxx
  parseWebhookEvent(rawBody) {
    const body = JSON.parse(
      rawBody.toString('utf8')
    );

    const paymentEntity =
      body.payload?.payment?.entity;

    const refundEntity =
      body.payload?.refund?.entity;

    const entity =
      paymentEntity || refundEntity;

    const statusMap = {
      'payment.captured': 'captured',
      'payment.failed': 'failed',
      'refund.processed': 'refunded'
    };

    return {
      providerOrderId:
        paymentEntity?.order_id || null,

      providerPaymentId:
        paymentEntity?.id ||
        refundEntity?.payment_id ||
        null,

      status:
        statusMap[body.event] ||
        entity?.status ||
        null,

      event:
        body.event || null
    };
  },

  async refund({
    providerPaymentId,
    amount
  }) {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${providerPaymentId}/refund`,
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
        'Razorpay refund failed'
      );
    }

    return {
      status: 'refunded',
      providerPaymentId: data.id,
      amount
    };
  }
};

const providers = {
  mock: mockProvider,
  razorpay: razorpayProvider
};

module.exports =
  providers[activeProviderName] ||
  mockProvider;
