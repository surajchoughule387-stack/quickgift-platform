// ---------------------------------------------------------------------------
// Payment abstraction layer (spec section 25).
// The rest of the app talks to `paymentProvider`, never to a gateway SDK
// directly — swapping providers means changing only this file.
//
// TWO REAL PROVIDERS ARE IMPLEMENTED BELOW, using plain HTTPS calls (Node's
// built-in fetch) so no extra npm install is required:
//   - mock: always succeeds — safe default so you can build/test with zero credentials
//   - razorpay: a real, working integration — set PAYMENT_PROVIDER=razorpay and
//     add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET to .env
//
// Payment status must NEVER be trusted from the frontend. Only a verified
// webhook (signature checked below) may mark a payment as captured/paid.
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
  verifyWebhookSignature() { return true; }, // mock always "verifies" — fine for local dev only
  // Dev-mode payload shape: { providerPaymentId, status } — matches what the
  // demo customer frontend sends to simulate a gateway callback.
  parseWebhookEvent(rawBody) {
    const body = JSON.parse(rawBody.toString('utf8'));
    return { providerPaymentId: body.providerPaymentId, status: body.status };
  },
  async refund({ providerPaymentId, amount }) {
    return { status: 'refunded', providerPaymentId, amount };
  }
};

// ---------------------------------------------------------------------------
// Razorpay — real REST integration (India's most common gateway for this kind
// of checkout). Docs: https://razorpay.com/docs/api/orders/ and
// https://razorpay.com/docs/webhooks/
// ---------------------------------------------------------------------------
const razorpayProvider = {
  name: 'razorpay',

  _authHeader() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env to use PAYMENT_PROVIDER=razorpay');
    }
    const basic = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
  },

  // Creates a real Razorpay order. The frontend uses providerPaymentId (Razorpay's
  // order id) with Razorpay Checkout.js to open the payment sheet.
  async createPaymentIntent({ amount, currency, orderId }) {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: this._authHeader(),
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Razorpay expects the smallest currency unit (paise)
        currency,
        receipt: String(orderId),
        notes: { quickgift_order_id: String(orderId) }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.description || 'Razorpay order creation failed');
    return { provider: 'razorpay', providerPaymentId: data.id, amount, currency, razorpayKeyId: process.env.RAZORPAY_KEY_ID };
  },

  // Verifies the HMAC-SHA256 signature Razorpay sends on every webhook call.
  // rawBody MUST be the exact raw bytes received (see server.js — mounted with express.raw()).
  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error('RAZORPAY_WEBHOOK_SECRET is not set — refusing to trust an unverifiable webhook.');
      return false;
    }
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
    // Constant-time comparison to avoid timing attacks on the signature check.
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader || ''));
    } catch {
      return false; // length mismatch etc. — never throw on attacker-controlled input
    }
  },

  // Razorpay's real webhook payload is nested — normalize it to the same
  // { providerPaymentId, status } shape the rest of the app expects.
  // Docs: https://razorpay.com/docs/webhooks/payloads/payments/
  parseWebhookEvent(rawBody) {
    const body = JSON.parse(rawBody.toString('utf8'));
    const entity = body.payload?.payment?.entity || body.payload?.refund?.entity;
    const statusMap = {
      'payment.captured': 'captured',
      'payment.failed': 'failed',
      'refund.processed': 'refunded'
    };
    return { providerPaymentId: entity?.id, status: statusMap[body.event] || entity?.status };
  },

  async refund({ providerPaymentId, amount }) {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${providerPaymentId}/refund`, {
      method: 'POST',
      headers: this._authHeader(),
      body: JSON.stringify({ amount: Math.round(amount * 100) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.description || 'Razorpay refund failed');
    return { status: 'refunded', providerPaymentId: data.id, amount };
  }
};

const providers = { mock: mockProvider, razorpay: razorpayProvider };

module.exports = providers[activeProviderName] || mockProvider;
