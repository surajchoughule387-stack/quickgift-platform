// ---------------------------------------------------------------------------
// Notification service (spec section 29).
// Always writes an in-app notification row (real, queryable by the customer
// app). Email and SMS are REAL integrations below (Resend + Twilio, both via
// plain HTTPS — no extra npm install needed) that activate automatically
// once you add their credentials to .env; until then they log to console so
// nothing breaks in local development.
// ---------------------------------------------------------------------------
const db = require('../config/db');

const EVENTS = {
  ORDER_PLACED: 'order_placed',
  PAYMENT_SUCCESS: 'payment_success',
  SELLER_ACCEPTED: 'seller_accepted',
  ORDER_PACKED: 'order_packed',
  SHIPMENT_PICKED_UP: 'shipment_picked_up',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REFUND: 'refund'
};

const TEMPLATES = {
  [EVENTS.ORDER_PLACED]: (o) => ({ title: 'Order placed', body: `Your order ${o.order_number} has been placed.` }),
  [EVENTS.PAYMENT_SUCCESS]: (o) => ({ title: 'Payment successful', body: `Payment received for order ${o.order_number}.` }),
  [EVENTS.SELLER_ACCEPTED]: (o) => ({ title: 'Order accepted', body: `The seller has accepted order ${o.order_number}.` }),
  [EVENTS.ORDER_PACKED]: (o) => ({ title: 'Order packed', body: `Order ${o.order_number} has been packed.` }),
  [EVENTS.SHIPMENT_PICKED_UP]: (o) => ({ title: 'Picked up', body: `Order ${o.order_number} has been picked up for delivery.` }),
  [EVENTS.OUT_FOR_DELIVERY]: (o) => ({ title: 'Out for delivery', body: `Order ${o.order_number} is out for delivery.` }),
  [EVENTS.DELIVERED]: (o) => ({ title: 'Delivered', body: `Order ${o.order_number} has been delivered. Enjoy!` }),
  [EVENTS.CANCELLED]: (o) => ({ title: 'Order cancelled', body: `Order ${o.order_number} has been cancelled.` }),
  [EVENTS.REFUND]: (o) => ({ title: 'Refund update', body: `A refund update is available for order ${o.order_number}.` })
};

// ---- Real email send via Resend's HTTP API (https://resend.com) ----
// Free tier available, no SDK needed. Set RESEND_API_KEY + RESEND_FROM_EMAIL in .env.
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[notify:email:stub] to=${to} subject="${subject}" — set RESEND_API_KEY in .env to send for real`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || 'QuickGift <onboarding@resend.dev>', to: [to], subject, html })
    });
    if (!res.ok) console.error('[notify:email] Resend API error:', await res.text());
  } catch (err) {
    console.error('[notify:email] send failed:', err.message);
  }
}

// ---- Real SMS send via Twilio's REST API (https://twilio.com) ----
// No SDK needed. Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER in .env.
async function sendSms(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) {
    console.log(`[notify:sms:stub] to=${to} — "${body}" — set TWILIO_ACCOUNT_SID etc. in .env to send for real`);
    return;
  }
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    if (!res.ok) console.error('[notify:sms] Twilio API error:', await res.text());
  } catch (err) {
    console.error('[notify:sms] send failed:', err.message);
  }
}

async function notifyOrderEvent(userId, event, order) {
  const template = TEMPLATES[event];
  if (!template) return;
  const { title, body } = template(order);

  await db.query(
    `INSERT INTO notifications (user_id, channel, event, title, body) VALUES ($1,'in_app',$2,$3,$4)`,
    [userId, event, title, body]
  );

  const userRes = await db.query('SELECT email, phone FROM users WHERE id = $1', [userId]);
  const user = userRes.rows[0];
  if (user?.email) await sendEmail(user.email, title, `<p>${body}</p>`);
  if (user?.phone) await sendSms(user.phone, `QuickGift: ${body}`);
}

module.exports = { EVENTS, notifyOrderEvent, sendEmail, sendSms };
