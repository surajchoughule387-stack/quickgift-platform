const db = require('../config/db');
const { notifyOrderEvent, EVENTS } = require('./notification');

// The full lifecycle from spec section 10. Kept here as the single source of
// truth so routes never hand-roll a status string.
const ORDER_STATUSES = [
  'pending_payment', 'payment_confirmed', 'order_confirmed', 'seller_accepted',
  'preparing', 'packed', 'ready_for_pickup', 'picked_up', 'in_transit',
  'customs_clearance', 'out_for_delivery', 'delivered', 'cancelled',
  'refund_initiated', 'refunded'
];

const STATUS_TO_EVENT = {
  payment_confirmed: EVENTS.PAYMENT_SUCCESS,
  seller_accepted: EVENTS.SELLER_ACCEPTED,
  packed: EVENTS.ORDER_PACKED,
  picked_up: EVENTS.SHIPMENT_PICKED_UP,
  out_for_delivery: EVENTS.OUT_FOR_DELIVERY,
  delivered: EVENTS.DELIVERED,
  cancelled: EVENTS.CANCELLED,
  refund_initiated: EVENTS.REFUND,
  refunded: EVENTS.REFUND
};

async function setOrderStatus(orderId, status, note, changedBy) {
  if (!ORDER_STATUSES.includes(status)) {
    const err = new Error(`Invalid order status: ${status}`);
    err.status = 400;
    throw err;
  }
  const { rows } = await db.query(
    `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [status, orderId]
  );
  const order = rows[0];
  if (!order) {
    const err = new Error('Order not found.');
    err.status = 404;
    throw err;
  }

  await db.query(
    `INSERT INTO order_status_history (order_id, status, note, changed_by) VALUES ($1,$2,$3,$4)`,
    [orderId, status, note || null, changedBy || null]
  );

  const event = STATUS_TO_EVENT[status];
  if (event) await notifyOrderEvent(order.user_id, event, order);

  return order;
}

module.exports = { ORDER_STATUSES, setOrderStatus };
