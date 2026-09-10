const db = require('../config/db');

// Shared by POST /api/coupons/validate AND the checkout flow in orders.routes.js
// — one implementation, so "preview the discount" and "actually apply it at
// checkout" can never disagree.
async function validateCoupon(code, { userId, subtotal, categoryId = null, sellerId = null, countryId = null }) {
  const { rows } = await db.query('SELECT * FROM coupons WHERE code = $1 AND is_active = true', [code]);
  const coupon = rows[0];
  if (!coupon) return { valid: false, reason: 'Coupon code not found or inactive.' };

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return { valid: false, reason: 'This coupon has expired.' };
  }
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
    return { valid: false, reason: 'This coupon has reached its usage limit.' };
  }
  if (parseFloat(subtotal) < parseFloat(coupon.min_order_value)) {
    return { valid: false, reason: `Minimum order value for this coupon is ${coupon.min_order_value}.` };
  }
  if (coupon.category_id && coupon.category_id !== categoryId) {
    return { valid: false, reason: 'Coupon not valid for this product category.' };
  }
  if (coupon.seller_id && coupon.seller_id !== sellerId) {
    return { valid: false, reason: 'Coupon not valid for this seller.' };
  }
  if (coupon.country_id && coupon.country_id !== countryId) {
    return { valid: false, reason: 'Coupon not valid for this delivery country.' };
  }
  if (coupon.first_order_only) {
    const priorOrders = await db.query('SELECT COUNT(*) FROM orders WHERE user_id = $1', [userId]);
    if (parseInt(priorOrders.rows[0].count, 10) > 0) {
      return { valid: false, reason: 'This coupon is only valid on a first order.' };
    }
  }

  const discount = coupon.type === 'percentage'
    ? Math.round(subtotal * (parseFloat(coupon.value) / 100) * 100) / 100
    : Math.min(parseFloat(coupon.value), subtotal);

  return { valid: true, coupon, discount };
}

module.exports = { validateCoupon };
