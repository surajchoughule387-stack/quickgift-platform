// Run with: npm run seed  (from backend/), after schema.sql has been applied.
require('dotenv').config();
const db = require('./src/config/db');
const { hashPassword } = require('./src/utils/password');
const { generateOrderNumber } = require('./src/utils/orderNumber');

const ROLES = ['customer', 'seller', 'admin', 'super_admin', 'ops_manager', 'support_agent', 'finance_manager'];

const CURRENCIES = [
  { code: 'INR', symbol: '₹' }, { code: 'USD', symbol: '$' }, { code: 'AED', symbol: 'AED ' },
  { code: 'GBP', symbol: '£' }, { code: 'AUD', symbol: 'A$' }
];

const COUNTRIES = [
  { name: 'India', iso_code: 'IN', currency_code: 'INR', tax_rate: 18, supports_cod: true },
  { name: 'United States', iso_code: 'US', currency_code: 'USD', tax_rate: 0, supports_cod: false },
  { name: 'United Arab Emirates', iso_code: 'AE', currency_code: 'AED', tax_rate: 5, supports_cod: true },
  { name: 'United Kingdom', iso_code: 'GB', currency_code: 'GBP', tax_rate: 20, supports_cod: false },
  { name: 'Australia', iso_code: 'AU', currency_code: 'AUD', tax_rate: 10, supports_cod: false }
];

const CATEGORIES = [
  'Birthday', 'Anniversary', 'Wedding', "Valentine's Day", "Mother's Day", "Father's Day",
  'Friendship', 'Congratulations', 'Thank You', 'Get Well Soon', 'Baby Gifts', 'Corporate Gifts',
  'Flowers', 'Cakes', 'Chocolates', 'Electronics', 'Fashion', 'Beauty',
  'Personalized Gifts', 'Gift Cards', 'Digital Gifts', 'International Gifts'
];

const SELLERS = [
  { business_name: 'Bloom & Petal Co.', category: 'Flowers' },
  { business_name: 'Sugar Crumb Bakery', category: 'Cakes' },
  { business_name: 'Cocoa House Chocolatiers', category: 'Chocolates' },
  { business_name: 'GadgetNest Electronics', category: 'Electronics' },
  { business_name: 'Threads & Co. Fashion', category: 'Fashion' },
  { business_name: 'GlowUp Beauty Studio', category: 'Beauty' },
  { business_name: 'Memory Lane Personalised', category: 'Personalized Gifts' },
  { business_name: 'Little Steps Baby Store', category: 'Baby Gifts' },
  { business_name: 'Corporate Gifting Co.', category: 'Corporate Gifts' },
  { business_name: 'Global Gift Exports', category: 'International Gifts' }
];

// slugify helper (kept identical to the one in routes/products.routes.js)
function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.random().toString(36).slice(2, 7);
}

async function run() {
  console.log('Seeding QuickGift demo data...');

  // ---- roles ----
  const roleIds = {};
  for (const name of ROLES) {
    const { rows } = await db.query(
      `INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = $1 RETURNING id`, [name]
    );
    roleIds[name] = rows[0].id;
  }

  // ---- currencies ----
  const currencyIds = {};
  for (const c of CURRENCIES) {
    const { rows } = await db.query(
      `INSERT INTO currencies (code, symbol) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET symbol = $2 RETURNING id`,
      [c.code, c.symbol]
    );
    currencyIds[c.code] = rows[0].id;
  }

  // ---- countries ----
  const countryIds = {};
  for (const c of COUNTRIES) {
    const { rows } = await db.query(
      `INSERT INTO countries (name, iso_code, currency_id, tax_rate, supports_cod) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (iso_code) DO UPDATE SET tax_rate = $4 RETURNING id`,
      [c.name, c.iso_code, currencyIds[c.currency_code], c.tax_rate, c.supports_cod]
    );
    countryIds[c.iso_code] = rows[0].id;
  }

  // ---- categories ----
  const categoryIds = {};
  let sortOrder = 0;
  for (const name of CATEGORIES) {
    const { rows } = await db.query(
      `INSERT INTO categories (name, slug, sort_order) VALUES ($1,$2,$3) ON CONFLICT (slug) DO UPDATE SET sort_order = $3 RETURNING id`,
      [name, slugify(name).replace(/-[a-z0-9]{5}$/, ''), sortOrder++]
    );
    categoryIds[name] = rows[0].id;
  }

  // ---- super admin ----
  const adminHash = await hashPassword('Admin@123');
  await db.query(
    `INSERT INTO users (name, email, password_hash, role_id, email_verified) VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (email) DO NOTHING`,
    ['QuickGift Super Admin', 'admin@quickgift.com', adminHash, roleIds.super_admin]
  );
  console.log('Admin login -> email: admin@quickgift.com  password: Admin@123');

  // ---- 10 customers ----
  const customerIds = [];
  const customerHash = await hashPassword('Customer@123');
  for (let i = 1; i <= 10; i++) {
    const email = `customer${i}@example.com`;
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role_id, email_verified) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (email) DO UPDATE SET name = $1 RETURNING id`,
      [`Demo Customer ${i}`, email, customerHash, roleIds.customer]
    );
    const userId = rows[0].id;
    customerIds.push(userId);
    await db.query('INSERT INTO carts (user_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM carts WHERE user_id = $1)', [userId]);
    await db.query('INSERT INTO wishlists (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    await db.query(
      `INSERT INTO addresses (user_id, label, line1, city, state, postal_code, country_id, is_default)
       VALUES ($1,'Home',$2,$3,$4,$5,$6,true)`,
      [userId, `${100 + i} Demo Street`, i % 3 === 0 ? 'Dubai' : 'Mumbai', i % 3 === 0 ? 'Dubai' : 'Maharashtra',
       i % 3 === 0 ? '00000' : '400001', i % 3 === 0 ? countryIds.AE : countryIds.IN]
    );
  }
  console.log(`Customer logins -> email: customer1..10@example.com  password: Customer@123`);

  // ---- 10 sellers ----
  const sellerHash = await hashPassword('Seller@123');
  const sellerIds = [];
  for (let i = 0; i < SELLERS.length; i++) {
    const s = SELLERS[i];
    const email = `seller${i + 1}@example.com`;
    const userRes = await db.query(
      `INSERT INTO users (name, email, password_hash, role_id, email_verified) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (email) DO UPDATE SET name = $1 RETURNING id`,
      [s.business_name, email, sellerHash, roleIds.seller]
    );
    const userId = userRes.rows[0].id;
    const sellerRes = await db.query(
      `INSERT INTO sellers (user_id, business_name, business_email, country_id, status, commission_rate)
       VALUES ($1,$2,$3,$4,'approved',12) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, s.business_name, email, countryIds.IN]
    );
    let sellerId = sellerRes.rows[0]?.id;
    if (!sellerId) {
      const existing = await db.query('SELECT id FROM sellers WHERE user_id = $1', [userId]);
      sellerId = existing.rows[0].id;
    }
    sellerIds.push({ id: sellerId, category: s.category });
  }
  console.log(`Seller logins -> email: seller1..10@example.com  password: Seller@123`);

  // ---- warehouse per seller ----
  const warehouseIds = [];
  for (const s of sellerIds) {
    const { rows } = await db.query(
      `INSERT INTO warehouses (seller_id, country_id, name, address) VALUES ($1,$2,$3,$4) RETURNING id`,
      [s.id, countryIds.IN, `${s.category} Warehouse`, 'Mumbai Fulfilment Centre']
    );
    warehouseIds.push(rows[0].id);
  }

  // ---- 50 products ----
  const productCatalog = [
    // [name, basePrice, mrp, personalization]
    ['Rose Bouquet - 12 Stems', 599, 749, false], ['Tulip Bunch - Pastel Mix', 699, 899, false],
    ['Orchid Arrangement', 1099, 1399, false], ['Sunflower Basket', 649, 799, false],
    ['Mixed Seasonal Flowers', 549, 699, false],
    ['Chocolate Truffle Cake - Half Kg', 649, 799, false], ['Red Velvet Cake - 1Kg', 999, 1249, false],
    ['Black Forest Cake', 749, 949, false], ['Pineapple Cake', 599, 749, false], ['Photo Cake - Custom', 899, 1099, true],
    ['Belgian Chocolate Box - 24pc', 899, 1099, false], ['Dark Chocolate Truffles', 549, 699, false],
    ['Assorted Praline Box', 749, 949, false],
    ['Wireless Earbuds', 2499, 3499, false], ['Smart Watch', 4999, 6999, false],
    ['Bluetooth Speaker', 1999, 2799, false], ['Power Bank 20000mAh', 1299, 1699, false],
    ['Silk Scarf', 1450, 1799, false], ['Leather Wallet', 999, 1299, false],
    ['Designer Sunglasses', 1799, 2399, false], ['Cotton Kurta Set', 1599, 1999, false],
    ['Luxury Perfume Gift Set', 2299, 2999, false], ['Skincare Hamper', 1899, 2399, false],
    ['Makeup Kit', 1499, 1999, false],
    ['Engraved Photo Frame', 799, 999, true], ['Personalised Name Necklace', 1299, 1599, true],
    ['Custom Photo Mug', 449, 599, true], ['Monogrammed Cushion', 699, 899, true],
    ['Custom Caricature Portrait', 1499, 1899, true],
    ['Baby Welcome Hamper', 1799, 2199, false], ['Newborn Clothing Set', 999, 1299, false],
    ['Corporate Diwali Hamper', 2499, 2999, false], ['Executive Desk Organiser Set', 1899, 2399, false],
    ['Branded Notebook & Pen Combo', 799, 999, false],
    ['E-Gift Card ₹1000', 1000, 1000, false], ['E-Gift Card ₹2500', 2500, 2500, false],
    ['Digital Spotify Gift Card', 500, 500, false], ['Digital Steam Wallet Code', 1000, 1000, false],
    ['International Chocolate Hamper (Dubai)', 2999, 3699, false], ['International Rose Box (Dubai)', 1999, 2499, false],
    ['Luxury Gift Hamper - Premium Collection', 1499, 1899, false], ['Cake & Flowers Combo', 1099, 1399, false],
    ['Chocolate & Teddy Combo', 899, 1099, false], ['Anniversary Special Combo', 1799, 2199, false],
    ['Get Well Soon Fruit Basket', 799, 999, false], ['Thank You Chocolate Box', 649, 799, false],
    ['Congratulations Balloon Bouquet', 899, 1099, false], ['Friendship Day Bracelet Set', 599, 749, false],
    ['Wedding Gift Hamper', 2199, 2699, false], ['Valentine Rose & Chocolate Combo', 1299, 1599, false],
    ["Mother's Day Special Hamper", 1699, 2099, false], ["Father's Day Grooming Kit", 1499, 1899, false]
  ];

  const categoryList = Object.keys(categoryIds);
  const productIds = [];
  for (let i = 0; i < productCatalog.length; i++) {
    const [name, basePrice, mrp, personalization] = productCatalog[i];
    const seller = sellerIds[i % sellerIds.length];
    const categoryName = categoryList[i % categoryList.length];
    const { rows } = await db.query(
      `INSERT INTO products (seller_id, category_id, name, slug, description, base_price, mrp,
                              personalization_available, gift_wrap_available, preparation_time_minutes, status, is_featured, avg_rating, review_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,60,'approved',$9,$10,$11) RETURNING id`,
      [seller.id, categoryIds[categoryName], name, slugify(name),
       `${name} — a thoughtfully curated gift, delivered fresh and on time.`,
       basePrice, mrp, personalization, i % 7 === 0, (3.8 + Math.random() * 1.2).toFixed(1), Math.floor(Math.random() * 300)]
    );
    const productId = rows[0].id;
    productIds.push(productId);

    await db.query('INSERT INTO product_images (product_id, url, sort_order) VALUES ($1,$2,0)',
      [productId, `https://picsum.photos/seed/quickgift${productId}/600/600`]);

    await db.query('INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES ($1,$2,$3)',
      [productId, warehouseIds[i % warehouseIds.length], 20 + Math.floor(Math.random() * 80)]);

    await db.query('INSERT INTO product_countries (product_id, country_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, countryIds.IN]);
    if (name.includes('International') || i % 5 === 0) {
      await db.query('INSERT INTO product_countries (product_id, country_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, countryIds.AE]);
      await db.query('INSERT INTO product_countries (product_id, country_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, countryIds.US]);
    }
  }
  console.log(`Seeded ${productIds.length} products across ${sellerIds.length} sellers.`);

  // ---- coupons ----
  await db.query(
    `INSERT INTO coupons (code, type, value, min_order_value, first_order_only) VALUES ('WELCOME10','percentage',10,0,true)
     ON CONFLICT (code) DO NOTHING`
  );
  await db.query(
    `INSERT INTO coupons (code, type, value, min_order_value) VALUES ('FEST200','fixed',200,999)
     ON CONFLICT (code) DO NOTHING`
  );

  // ---- courier + shipping method (for tracking demo) ----
  const courierRes = await db.query(
    `INSERT INTO couriers (name, tracking_url_template, api_integration_key_env) VALUES ('QuickGift Logistics','https://track.quickgift.example/{tracking_number}','COURIER_API_KEY') RETURNING id`
  );
  const courierId = courierRes.rows[0].id;
  await db.query(
    `INSERT INTO shipping_methods (name, courier_id, base_cost, estimated_days_min, estimated_days_max) VALUES ('Standard',$1,0,2,4)`,
    [courierId]
  );

  // ---- 20 sample orders across different statuses ----
  const statuses = [
    'pending_payment', 'payment_confirmed', 'order_confirmed', 'seller_accepted', 'preparing',
    'packed', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered',
    'delivered', 'delivered', 'delivered', 'cancelled', 'refunded',
    'order_confirmed', 'preparing', 'out_for_delivery', 'delivered', 'delivered'
  ];

  for (let i = 0; i < 20; i++) {
    const userId = customerIds[i % customerIds.length];
    const status = statuses[i];
    const addr = await db.query('SELECT * FROM addresses WHERE user_id = $1 LIMIT 1', [userId]);
    const address = addr.rows[0];
    const countryRow = await db.query('SELECT c.*, cur.code AS currency_code FROM countries c JOIN currencies cur ON cur.id=c.currency_id WHERE c.id=$1', [address.country_id]);
    const country = countryRow.rows[0];

    const productId = productIds[Math.floor(Math.random() * productIds.length)];
    const product = (await db.query('SELECT * FROM products WHERE id = $1', [productId])).rows[0];
    const quantity = 1 + Math.floor(Math.random() * 2);
    const subtotal = parseFloat(product.base_price) * quantity;
    const taxAmount = Math.round(subtotal * (parseFloat(country.tax_rate) / 100) * 100) / 100;
    const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;
    const orderNumber = generateOrderNumber();

    const orderRes = await db.query(
      `INSERT INTO orders (order_number, user_id, delivery_address_id, country_id, currency_code, subtotal, tax_amount, total_amount, status, placed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - interval '1 day' * $10) RETURNING id`,
      [orderNumber, userId, address.id, country.id, country.currency_code, subtotal, taxAmount, totalAmount, status, 20 - i]
    );
    const orderId = orderRes.rows[0].id;

    const itemRes = await db.query(
      `INSERT INTO order_items (order_id, product_id, seller_id, product_name_snapshot, unit_price, quantity, item_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orderId, product.id, product.seller_id, product.name, product.base_price, quantity,
       status === 'delivered' ? 'packed' : 'pending']
    );

    await db.query(`INSERT INTO order_status_history (order_id, status, note) VALUES ($1,$2,'Seed data')`, [orderId, status]);

    if (['payment_confirmed', 'order_confirmed', 'seller_accepted', 'preparing', 'packed', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'].includes(status)) {
      await db.query(
        `INSERT INTO payments (order_id, provider, provider_payment_id, amount, currency_code, status, method, webhook_verified)
         VALUES ($1,'mock',$2,$3,$4,'captured','card',true)`,
        [orderId, `mock_seed_${orderId}`, totalAmount, country.currency_code]
      );
      await db.query(
        `INSERT INTO commissions (order_item_id, seller_id, rate, amount) VALUES ($1,$2,12,$3)`,
        [itemRes.rows[0].id, product.seller_id, Math.round(subtotal * 0.12 * 100) / 100]
      );
    }

    if (['picked_up', 'in_transit', 'out_for_delivery', 'delivered'].includes(status)) {
      const shipRes = await db.query(
        `INSERT INTO shipments (order_id, courier_id, tracking_number, status) VALUES ($1,$2,$3,$4) RETURNING id`,
        [orderId, courierId, `QGTRK${100000 + orderId}`, status]
      );
      await db.query(`INSERT INTO tracking_events (shipment_id, status, location, description) VALUES ($1,'picked_up','Mumbai Hub','Package picked up from seller')`, [shipRes.rows[0].id]);
      if (status !== 'picked_up') {
        await db.query(`INSERT INTO tracking_events (shipment_id, status, location, description) VALUES ($1,'in_transit','Regional Hub','In transit to destination')`, [shipRes.rows[0].id]);
      }
      if (['out_for_delivery', 'delivered'].includes(status)) {
        await db.query(`INSERT INTO tracking_events (shipment_id, status, location, description) VALUES ($1,'out_for_delivery','Local Facility','Out for delivery')`, [shipRes.rows[0].id]);
      }
      if (status === 'delivered') {
        await db.query(`INSERT INTO tracking_events (shipment_id, status, location, description) VALUES ($1,'delivered','Destination','Delivered successfully')`, [shipRes.rows[0].id]);
      }
    }

    if (status === 'refunded') {
      await db.query(
        `INSERT INTO refunds (order_id, amount, reason, status, processed_at) VALUES ($1,$2,'Customer requested cancellation','refunded', now())`,
        [orderId, totalAmount]
      );
    }

    // A couple of delivered orders get a review, demonstrating the "only delivered can be reviewed" rule.
    if (status === 'delivered' && i % 2 === 0) {
      await db.query(
        `INSERT INTO reviews (order_item_id, product_id, seller_id, user_id, product_rating, delivery_rating, review_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [itemRes.rows[0].id, product.id, product.seller_id, userId, 4 + (i % 2), 5, 'Arrived on time and exactly as pictured. Would order again.']
      );
    }
  }
  console.log('Seeded 20 sample orders across pending/confirmed/shipped/delivered/cancelled/refunded states.');

  console.log('\nSeed complete.');
  console.log('Sample logins:');
  console.log('  Admin:    admin@quickgift.com    / Admin@123');
  console.log('  Customer: customer1@example.com  / Customer@123');
  console.log('  Seller:   seller1@example.com     / Seller@123');
  process.exit(0);
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
