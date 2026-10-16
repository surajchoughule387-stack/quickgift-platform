const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { hashPassword } = require('../utils/password');
const { ApiError } = require('../middleware/errorHandler');

const ADMIN_ROLES = ['admin', 'super_admin', 'ops_manager', 'support_agent', 'finance_manager'];

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard — spec section 19/35
// ---------------------------------------------------------------------------
router.get('/dashboard', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const [users, sellers, products, orders, revenue, commission, refunds, intlOrders, countrySales, sellerPerf] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name = 'customer'`),
      db.query(`SELECT COUNT(*) FROM sellers`),
      db.query(`SELECT COUNT(*) FROM products WHERE status = 'approved'`),
      db.query(`SELECT COUNT(*) FROM orders`),
      db.query(`SELECT COALESCE(SUM(total_amount),0) AS total FROM orders WHERE status NOT IN ('cancelled','pending_payment')`),
      db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM commissions`),
      db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM refunds WHERE status = 'refunded'`),
      db.query(`SELECT COUNT(*) FROM orders o JOIN countries c ON c.id = o.country_id WHERE c.iso_code != 'IN'`),
      db.query(`SELECT c.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount),0) AS revenue
                 FROM orders o JOIN countries c ON c.id = o.country_id
                 WHERE o.status NOT IN ('cancelled','pending_payment') GROUP BY c.name ORDER BY revenue DESC LIMIT 10`),
      db.query(`SELECT s.business_name, COUNT(oi.id) AS items_sold, COALESCE(SUM(oi.unit_price * oi.quantity),0) AS revenue
                 FROM order_items oi JOIN sellers s ON s.id = oi.seller_id
                 JOIN orders o ON o.id = oi.order_id WHERE o.status NOT IN ('cancelled','pending_payment')
                 GROUP BY s.business_name ORDER BY revenue DESC LIMIT 10`)
    ]);

    res.json({
      total_users: parseInt(users.rows[0].count, 10),
      total_sellers: parseInt(sellers.rows[0].count, 10),
      total_products: parseInt(products.rows[0].count, 10),
      total_orders: parseInt(orders.rows[0].count, 10),
      revenue: parseFloat(revenue.rows[0].total),
      commission: parseFloat(commission.rows[0].total),
      refunds: parseFloat(refunds.rows[0].total),
      international_orders: parseInt(intlOrders.rows[0].count, 10),
      country_wise_sales: countrySales.rows,
      top_sellers: sellerPerf.rows
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// USER MANAGEMENT — spec section 20
// ---------------------------------------------------------------------------
router.get('/users', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { search, role } = req.query;
    const where = []; const values = [];
    if (search) { values.push(`%${search}%`); where.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length})`); }
    if (role) { values.push(role); where.push(`r.name = $${values.length}`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.is_blocked, u.created_at, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id ${whereClause} ORDER BY u.created_at DESC LIMIT 200`,
      values
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

router.get('/users/:id/orders', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY placed_at DESC', [req.params.id]);
    res.json({ orders: rows });
  } catch (err) { next(err); }
});

router.patch('/users/:id/block', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query('UPDATE users SET is_blocked = true WHERE id = $1 RETURNING id, name, is_blocked', [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'User not found.');
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/users/:id/unblock', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query('UPDATE users SET is_blocked = false WHERE id = $1 RETURNING id, name, is_blocked', [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'User not found.');
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

// Only super_admin may change roles — this is a privilege escalation risk otherwise.
router.patch('/users/:id/role', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    const { role } = req.body;
    const roleRow = await db.query('SELECT id FROM roles WHERE name = $1', [role]);
    if (!roleRow.rows[0]) throw new ApiError(400, 'Unknown role.');
    const { rows } = await db.query('UPDATE users SET role_id = $1 WHERE id = $2 RETURNING id, name', [roleRow.rows[0].id, req.params.id]);
    res.json({ user: rows[0], new_role: role });
  } catch (err) { next(err); }
});

// Admins are provisioned here by a super_admin — never via public registration.
router.post('/create-staff', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!ADMIN_ROLES.includes(role)) throw new ApiError(400, `role must be one of: ${ADMIN_ROLES.join(', ')}`);
    const roleRow = await db.query('SELECT id FROM roles WHERE name = $1', [role]);
    const passwordHash = await hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role_id, email_verified) VALUES ($1,$2,$3,$4,true) RETURNING id, name, email`,
      [name, email, passwordHash, roleRow.rows[0].id]
    );
    res.status(201).json({ user: { ...rows[0], role } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// SELLER MANAGEMENT — spec section 21
// ---------------------------------------------------------------------------
router.get('/sellers', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE s.status = $1' : '';
    const values = status ? [status] : [];
    const { rows } = await db.query(
      `SELECT s.*, u.name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM products WHERE seller_id = s.id) AS product_count,
              (SELECT COALESCE(SUM(oi.unit_price*oi.quantity),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.seller_id = s.id AND o.status NOT IN ('cancelled','pending_payment')) AS revenue
       FROM sellers s JOIN users u ON u.id = s.user_id ${where} ORDER BY s.created_at DESC`,
      values
    );
    res.json({ sellers: rows });
  } catch (err) { next(err); }
});

router.patch('/sellers/:id/approve', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query(`UPDATE sellers SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'Seller not found.');
    res.json({ seller: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/sellers/:id/reject', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query(`UPDATE sellers SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'Seller not found.');
    res.json({ seller: rows[0], reason: req.body.reason || null });
  } catch (err) { next(err); }
});

router.patch('/sellers/:id/suspend', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query(`UPDATE sellers SET status = 'suspended', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'Seller not found.');
    res.json({ seller: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/sellers/:id/commission', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { commission_rate } = req.body;
    const { rows } = await db.query('UPDATE sellers SET commission_rate = $1 WHERE id = $2 RETURNING *', [commission_rate, req.params.id]);
    res.json({ seller: rows[0] });
  } catch (err) { next(err); }
});

router.get('/sellers/:id/payouts', authenticate, requireRole('admin', 'super_admin', 'finance_manager'), async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM payouts WHERE seller_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ payouts: rows });
  } catch (err) { next(err); }
});

router.post('/sellers/:id/payouts', authenticate, requireRole('admin', 'super_admin', 'finance_manager'), async (req, res, next) => {
  try {
    const { amount, period_start, period_end } = req.body;
    const { rows } = await db.query(
      `INSERT INTO payouts (seller_id, amount, period_start, period_end, status) VALUES ($1,$2,$3,$4,'processing') RETURNING *`,
      [req.params.id, amount, period_start, period_end]
    );
    res.status(201).json({ payout: rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// ORDERS OVERSIGHT
// ---------------------------------------------------------------------------
router.get('/orders', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { status, country } = req.query;
    const where = []; const values = [];
    if (status) { values.push(status); where.push(`o.status = $${values.length}`); }
    if (country) { values.push(country); where.push(`c.iso_code = $${values.length}`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT o.*, u.name AS customer_name, c.name AS country_name
       FROM orders o JOIN users u ON u.id = o.user_id JOIN countries c ON c.id = o.country_id
       ${whereClause} ORDER BY o.placed_at DESC LIMIT 200`,
      values
    );
    res.json({ orders: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// SETTINGS (spec section 26/49 — legal pages, feature flags etc.)
// ---------------------------------------------------------------------------
router.get('/settings/:key', authenticate, requireRole(...ADMIN_ROLES), async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM settings WHERE key = $1', [req.params.key]);
    res.json({ setting: rows[0] || null });
  } catch (err) { next(err); }
});

router.put('/settings/:key', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now() RETURNING *`,
      [req.params.key, req.body.value]
    );
    res.json({ setting: rows[0] });
  } catch (err) { next(err); }
});


/* WAREHOUSE APPROVAL */

router.get(
  '/warehouses',
  authenticate,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const { status = 'pending' } = req.query;
      const allowed = ['pending', 'approved', 'rejected', 'all'];

      if (!allowed.includes(status)) {
        throw new ApiError(400, 'Invalid warehouse status.');
      }

      const values = [];
      let filter = '';

      if (status !== 'all') {
        values.push(status);
        filter = 'WHERE w.approval_status = $1';
      }

      const { rows } = await db.query(
        `SELECT w.*, s.business_name
         FROM warehouses w
         LEFT JOIN sellers s ON s.id = w.seller_id
         ${filter}
         ORDER BY w.id DESC`,
        values
      );

      res.json({ warehouses: rows });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/warehouses/:id/approve',
  authenticate,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new ApiError(400, 'Invalid warehouse ID.');
      }
      

      

const { rows } = await db.query(
  `UPDATE warehouses
   SET approval_status = 'approved',
       is_active = TRUE
   WHERE id = $1
     AND approval_status = 'pending'
   RETURNING *`,
  [id]
);


      if (!rows[0]) {
        throw new ApiError(404, 'Warehouse not found.');
      }

      res.json({
        message: 'Warehouse approved.',
        warehouse: rows[0]
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/warehouses/:id/reject',
  authenticate,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new ApiError(400, 'Invalid warehouse ID.');
      }



      
const { rows } = await db.query(
  `UPDATE warehouses
   SET approval_status = 'rejected',
       is_active = FALSE
   WHERE id = $1
     AND approval_status = 'pending'
   RETURNING *`,
  [id]
);

      
      if (!rows[0]) {
        throw new ApiError(404, 'Warehouse not found.');
      }

      res.json({
        message: 'Warehouse rejected.',
        warehouse: rows[0]
      });
    } catch (err) {
      next(err);
    }
  }
);

/* STOCK REQUEST APPROVAL */

// List stock requests for admin review.
// GET /api/admin/stock-requests?status=pending
router.get(
  '/stock-requests',
  authenticate,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    try {
      const status = req.query.status || 'pending';
      const allowed = ['pending', 'approved', 'rejected', 'all'];

      if (!allowed.includes(status)) {
        throw new ApiError(400, 'Invalid stock request status.');
      }

      const values = [];
      let filter = '';

      if (status !== 'all') {
        values.push(status);
        filter = 'WHERE iar.status = $1';
      }

      const { rows } = await db.query(
        `SELECT
           iar.id,
           iar.seller_id,
           iar.product_id,
           iar.variant_id,
           iar.warehouse_id,
           iar.requested_by,
           iar.requested_quantity,
           iar.reason,
           iar.status,
           iar.reviewed_by,
           iar.reviewed_at,
           iar.admin_note,
           iar.created_at,
           s.business_name,
           p.name AS product_name,
           w.name AS warehouse_name
         FROM inventory_adjustment_requests iar
         JOIN sellers s ON s.id = iar.seller_id
         JOIN products p ON p.id = iar.product_id
         JOIN warehouses w ON w.id = iar.warehouse_id
         ${filter}
         ORDER BY iar.created_at DESC
         LIMIT 200`,
        values
      );

      res.json({ requests: rows });
    } catch (err) {
      next(err);
    }
  }
);

// Approve request and update inventory atomically.
// requested_quantity is the final stock quantity, not an increment.
router.patch(
  '/stock-requests/:id/approve',
  authenticate,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    let client;

    try {
      const id = Number(req.params.id);

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new ApiError(400, 'Invalid stock request ID.');
      }

      const adminNote =
        typeof req.body.admin_note === 'string'
          ? req.body.admin_note.trim() || null
          : null;

      client = await db.getClient();
      await client.query('BEGIN');

      const requestResult = await client.query(
        `SELECT *
         FROM inventory_adjustment_requests
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );

      const request = requestResult.rows[0];

      if (!request) {
        throw new ApiError(404, 'Stock request not found.');
      }

      if (request.status !== 'pending') {
        throw new ApiError(409, 'Stock request has already been reviewed.');
      }

      const productResult = await client.query(
        `SELECT id
         FROM products
         WHERE id = $1
           AND seller_id = $2`,
        [request.product_id, request.seller_id]
      );

      if (!productResult.rows[0]) {
        throw new ApiError(
          409,
          'Product does not belong to the requesting seller.'
        );
      }

      const warehouseResult = await client.query(
        `SELECT id
         FROM warehouses
         WHERE id = $1
           AND seller_id = $2
           AND is_active = TRUE
           AND approval_status = 'approved'
         FOR UPDATE`,
        [request.warehouse_id, request.seller_id]
      );

      if (!warehouseResult.rows[0]) {
        throw new ApiError(
          409,
          'Warehouse is not active and approved for this seller.'
        );
      }

      if (request.variant_id !== null) {
        const variantResult = await client.query(
          `SELECT id
           FROM product_variants
           WHERE id = $1
             AND product_id = $2`,
          [request.variant_id, request.product_id]
        );

        if (!variantResult.rows[0]) {
          throw new ApiError(
            409,
            'Requested variant does not belong to this product.'
          );
        }

        await client.query(
          `INSERT INTO inventory
             (product_id, variant_id, warehouse_id, quantity)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (product_id, variant_id, warehouse_id)
           WHERE variant_id IS NOT NULL
             AND product_id IS NOT NULL
             AND warehouse_id IS NOT NULL
           DO UPDATE SET
             quantity = EXCLUDED.quantity,
             updated_at = now()`,
          [
            request.product_id,
            request.variant_id,
            request.warehouse_id,
            request.requested_quantity
          ]
        );
      } else {
        await client.query(
          `INSERT INTO inventory
             (product_id, variant_id, warehouse_id, quantity)
           VALUES ($1, NULL, $2, $3)
           ON CONFLICT (product_id, warehouse_id)
           WHERE variant_id IS NULL
             AND product_id IS NOT NULL
             AND warehouse_id IS NOT NULL
           DO UPDATE SET
             quantity = EXCLUDED.quantity,
             updated_at = now()`,
          [
            request.product_id,
            request.warehouse_id,
            request.requested_quantity
          ]
        );
      }

      const updated = await client.query(
        `UPDATE inventory_adjustment_requests
         SET status = 'approved',
             reviewed_by = $1,
             reviewed_at = now(),
             admin_note = $2,
             updated_at = now()
         WHERE id = $3
           AND status = 'pending'
         RETURNING *`,
        [req.user.id, adminNote, id]
      );

      if (!updated.rows[0]) {
        throw new ApiError(409, 'Stock request was already reviewed.');
      }

      await client.query('COMMIT');

      res.json({
        message: 'Stock request approved and inventory updated.',
        request: updated.rows[0]
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Stock approval rollback failed:', rollbackErr);
        }
      }

      next(err);
    } finally {
      if (client) client.release();
    }
  }
);

// Reject request without changing inventory.
// PATCH /api/admin/stock-requests/:id/reject
router.patch(
  '/stock-requests/:id/reject',
  authenticate,
  requireRole(...ADMIN_ROLES),
  async (req, res, next) => {
    let client;

    try {
      const id = Number(req.params.id);

      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new ApiError(400, 'Invalid stock request ID.');
      }

      const adminNote =
        typeof req.body.admin_note === 'string'
          ? req.body.admin_note.trim() || null
          : null;

      client = await db.getClient();
      await client.query('BEGIN');

      const requestResult = await client.query(
        `SELECT id, status
         FROM inventory_adjustment_requests
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );

      const request = requestResult.rows[0];

      if (!request) {
        throw new ApiError(404, 'Stock request not found.');
      }

      if (request.status !== 'pending') {
        throw new ApiError(409, 'Stock request has already been reviewed.');
      }

      const { rows } = await client.query(
        `UPDATE inventory_adjustment_requests
         SET status = 'rejected',
             reviewed_by = $1,
             reviewed_at = now(),
             admin_note = $2,
             updated_at = now()
         WHERE id = $3
           AND status = 'pending'
         RETURNING *`,
        [req.user.id, adminNote, id]
      );

      await client.query('COMMIT');

      res.json({
        message: 'Stock request rejected. Inventory was not changed.',
        request: rows[0]
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Stock rejection rollback failed:', rollbackErr);
        }
      }

      next(err);
    } finally {
      if (client) client.release();
    }
  }
);




module.exports = router;
