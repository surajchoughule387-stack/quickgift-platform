const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { convert } = require('../services/exchangeRate');
const { ApiError } = require('../middleware/errorHandler');

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// GET /api/products — smart search & browse (spec section 3 & 4)
// Supports: q (text), category, minPrice, maxPrice, minRating, country,
//           seller, sort, page, limit, currency (for display conversion)
// Only status='approved' products are ever publicly visible (spec section 44).
// ---------------------------------------------------------------------------
router.get('/', optionalAuthenticate, async (req, res, next) => {
  try {
    const {
      q, category, minPrice, maxPrice, minRating, country, seller,
      sort = 'relevance', page = 1, limit = 20, currency = 'INR'
    } = req.query;

    const where = ["p.status = 'approved'"];
    const values = [];

    if (q) {
      values.push(`%${q}%`);
      where.push(`(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length})`);
    }
    if (category) { values.push(category); where.push(`c.slug = $${values.length}`); }
    if (minPrice) { values.push(minPrice); where.push(`p.base_price >= $${values.length}`); }
    if (maxPrice) { values.push(maxPrice); where.push(`p.base_price <= $${values.length}`); }
    if (minRating) { values.push(minRating); where.push(`p.avg_rating >= $${values.length}`); }
    if (seller) { values.push(seller); where.push(`s.id = $${values.length}`); }
    if (country) {
      values.push(country);
      where.push(`EXISTS (SELECT 1 FROM product_countries pc JOIN countries co ON co.id = pc.country_id
                           WHERE pc.product_id = p.id AND co.iso_code = $${values.length})`);
    }

    const sortMap = {
      relevance: 'p.is_featured DESC, p.avg_rating DESC',
      price_low: 'p.base_price ASC',
      price_high: 'p.base_price DESC',
      rating: 'p.avg_rating DESC',
      newest: 'p.created_at DESC'
    };
    const orderBy = sortMap[sort] || sortMap.relevance;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const listQuery = `
      SELECT p.id, p.name, p.slug, p.base_price, p.mrp, p.avg_rating, p.review_count,
             p.is_featured, p.preparation_time_minutes,
             c.name AS category_name, c.slug AS category_slug,
             s.id AS seller_id, s.business_name AS seller_name, s.avg_rating AS seller_rating,
             (SELECT url FROM product_images pi WHERE pi.product_id = p.id ORDER BY sort_order LIMIT 1) AS thumbnail,
             (SELECT SUM(quantity) FROM inventory i WHERE i.product_id = p.id) AS stock
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN sellers s ON s.id = p.seller_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${limitNum} OFFSET ${offset}`;

    const countQuery = `SELECT COUNT(*) FROM products p JOIN categories c ON c.id=p.category_id JOIN sellers s ON s.id=p.seller_id WHERE ${where.join(' AND ')}`;

    const [{ rows: products }, { rows: countRows }] = await Promise.all([
      db.query(listQuery, values),
      db.query(countQuery, values)
    ]);

    if (currency !== 'INR') {
      for (const p of products) {
        p.display_price = await convert(p.base_price, currency);
        p.display_mrp = p.mrp ? await convert(p.mrp, currency) : null;
      }
    } else {
      products.forEach((p) => { p.display_price = p.base_price; p.display_mrp = p.mrp; });
    }

    res.json({
      products,
      currency,
      pagination: { page: pageNum, limit: limitNum, total: parseInt(countRows[0].count, 10) }
    });
  } catch (err) { next(err); }
});

// GET /api/products/:slug — full product detail
router.get('/:slug', optionalAuthenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
              s.id AS seller_id, s.business_name AS seller_name, s.avg_rating AS seller_rating,
              b.name AS brand_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       JOIN sellers s ON s.id = p.seller_id
       LEFT JOIN brands b ON b.id = p.brand_id
       WHERE p.slug = $1 AND p.status = 'approved'`,
      [req.params.slug]
    );
    const product = rows[0];
    if (!product) throw new ApiError(404, 'Product not found or not available.');

    const [images, variants, countries, stock] = await Promise.all([
      db.query('SELECT id, url, sort_order FROM product_images WHERE product_id = $1 ORDER BY sort_order', [product.id]),
      db.query('SELECT id, variant_name, variant_value, price_delta, sku FROM product_variants WHERE product_id = $1', [product.id]),
      db.query(`SELECT co.name, co.iso_code FROM product_countries pc JOIN countries co ON co.id = pc.country_id WHERE pc.product_id = $1`, [product.id]),
      db.query('SELECT COALESCE(SUM(quantity),0) AS total FROM inventory WHERE product_id = $1', [product.id])
    ]);

    res.json({
      product: {
        ...product,
        images: images.rows,
        variants: variants.rows,
        available_countries: countries.rows,
        in_stock: parseInt(stock.rows[0].total, 10) > 0,
        stock_quantity: parseInt(stock.rows[0].total, 10)
      }
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// SELLER product management (spec section 17)
// ---------------------------------------------------------------------------

// POST /api/products — seller creates a product (goes to pending_approval)
router.post('/', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    const seller = await db.query('SELECT id, status FROM sellers WHERE user_id = $1', [req.user.id]);
    if (!seller.rows[0]) throw new ApiError(403, 'No seller profile found for this account.');
    if (seller.rows[0].status !== 'approved') throw new ApiError(403, 'Your seller account must be approved before you can list products.');

    const {
      name, category_id, brand_id = null, description = '', specifications = {},
      base_price, mrp = null, personalization_available = false,
      gift_wrap_available = true, preparation_time_minutes = 60,
      images = [], variants = [], country_ids = []
    } = req.body;

    if (!name || !category_id || !base_price) throw new ApiError(400, 'name, category_id and base_price are required.');

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO products (seller_id, category_id, brand_id, name, slug, description, specifications,
                                base_price, mrp, personalization_available, gift_wrap_available, preparation_time_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [seller.rows[0].id, category_id, brand_id, name, slugify(name), description, specifications,
         base_price, mrp, personalization_available, gift_wrap_available, preparation_time_minutes]
      );
      const product = rows[0];

      for (const [i, url] of images.entries()) {
        await client.query('INSERT INTO product_images (product_id, url, sort_order) VALUES ($1,$2,$3)', [product.id, url, i]);
      }
      for (const v of variants) {
        await client.query('INSERT INTO product_variants (product_id, variant_name, variant_value, price_delta, sku) VALUES ($1,$2,$3,$4,$5)',
          [product.id, v.variant_name, v.variant_value, v.price_delta || 0, v.sku || null]);
      }
      for (const cid of country_ids) {
        await client.query('INSERT INTO product_countries (product_id, country_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [product.id, cid]);
      }
      await client.query('COMMIT');
      res.status(201).json({ product, message: 'Product submitted for admin approval.' });
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  } catch (err) { next(err); }
});

// Helper to confirm a product belongs to the requesting seller
async function assertOwnership(productId, userId) {
  const { rows } = await db.query(
    `SELECT p.id FROM products p JOIN sellers s ON s.id = p.seller_id WHERE p.id = $1 AND s.user_id = $2`,
    [productId, userId]
  );
  if (!rows[0]) throw new ApiError(403, 'You do not own this product.');
}

// PUT /api/products/:id — seller edits their own product (re-enters pending_approval)
router.put('/:id', authenticate, requireRole('seller'), async (req, res, next) => {
  try {
    await assertOwnership(req.params.id, req.user.id);
    const fields = ['name', 'description', 'base_price', 'mrp', 'personalization_available', 'gift_wrap_available', 'preparation_time_minutes'];
    const updates = []; const values = [];
    fields.forEach((f) => { if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f} = $${values.length}`); } });
    updates.push(`status = 'pending_approval'`, 'updated_at = now()');
    values.push(req.params.id);
    const { rows } = await db.query(`UPDATE products SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    res.json({ product: rows[0], message: 'Product updated and resubmitted for approval.' });
  } catch (err) { next(err); }
});

// DELETE /api/products/:id — seller deletes their own product
router.delete('/:id', authenticate, requireRole('seller', 'admin', 'super_admin'), async (req, res, next) => {
  try {
    if (req.user.role === 'seller') await assertOwnership(req.params.id, req.user.id);
    await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ message: 'Product deleted.' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// ADMIN moderation (spec section 22)
// ---------------------------------------------------------------------------

// GET /api/products/admin/pending — admin queue of products awaiting approval
router.get('/admin/pending', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.base_price, p.status, p.created_at, s.business_name AS seller_name, c.name AS category_name
       FROM products p JOIN sellers s ON s.id = p.seller_id JOIN categories c ON c.id = p.category_id
       WHERE p.status = 'pending_approval' ORDER BY p.created_at ASC`
    );
    res.json({ products: rows });
  } catch (err) { next(err); }
});

// PATCH /api/products/:id/approve — admin approves a product
router.patch('/:id/approve', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`UPDATE products SET status='approved', updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'Product not found.');
    res.json({ product: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/products/:id/reject  { reason }
router.patch('/:id/reject', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`UPDATE products SET status='rejected', updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, 'Product not found.');
    res.json({ product: rows[0], reason: req.body.reason || null });
  } catch (err) { next(err); }
});

// PATCH /api/products/:id/feature — admin toggles homepage featuring
router.patch('/:id/feature', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`UPDATE products SET is_featured = $1 WHERE id = $2 RETURNING *`, [!!req.body.is_featured, req.params.id]);
    res.json({ product: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
