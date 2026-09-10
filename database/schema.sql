-- =====================================================================
-- QuickGift Platform — PostgreSQL Schema
-- Covers: customer app, seller/partner app, admin panel
-- Run with: psql -U postgres -d quickgift -f database/schema.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- CORE: Roles / Users / Addresses
-- ---------------------------------------------------------------
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL -- customer, seller, admin, super_admin, ops_manager, support_agent, finance_manager
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT,
  profile_photo_url TEXT,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_blocked BOOLEAN DEFAULT FALSE,
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  auth_provider TEXT DEFAULT 'password', -- password | google | otp
  reward_points INTEGER DEFAULT 0,
  preferred_language TEXT DEFAULT 'en',
  preferred_currency TEXT DEFAULT 'INR',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, -- Home, Office
  line1 TEXT NOT NULL,
  line2 TEXT,
  landmark TEXT,
  city TEXT NOT NULL,
  state TEXT,
  postal_code TEXT NOT NULL,
  country_id INTEGER,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE recipients (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  relationship TEXT,
  address_id INTEGER REFERENCES addresses(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- COUNTRIES / CURRENCIES (dynamic — never hardcode in app code)
-- ---------------------------------------------------------------
CREATE TABLE currencies (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,   -- INR, USD, AED...
  symbol TEXT NOT NULL,
  decimal_places INTEGER DEFAULT 2
);

CREATE TABLE countries (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  iso_code TEXT UNIQUE NOT NULL, -- IN, US, AE...
  currency_id INTEGER REFERENCES currencies(id),
  tax_rate NUMERIC(5,2) DEFAULT 0, -- simple flat tax %, extend to a tax_rules table for complex cases
  is_active BOOLEAN DEFAULT TRUE,
  supports_cod BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE addresses ADD CONSTRAINT fk_addr_country FOREIGN KEY (country_id) REFERENCES countries(id);

CREATE TABLE delivery_zones (
  id SERIAL PRIMARY KEY,
  country_id INTEGER REFERENCES countries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,          -- e.g. "Metro Mumbai", "Dubai Local"
  postal_prefixes TEXT[],      -- array of prefixes/pincodes this zone covers
  standard_delivery_days INTEGER DEFAULT 3,
  same_day_available BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- CATALOG: Categories / Brands / Sellers / Products
-- ---------------------------------------------------------------
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  parent_id INTEGER REFERENCES categories(id),
  icon TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE brands (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  logo_url TEXT
);

CREATE TABLE sellers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_email TEXT,
  business_phone TEXT,
  business_address TEXT,
  country_id INTEGER REFERENCES countries(id),
  tax_info TEXT,
  bank_account_info JSONB,        -- store only tokenized/non-sensitive refs in production
  status TEXT DEFAULT 'pending',  -- pending, under_review, approved, rejected, suspended
  commission_rate NUMERIC(5,2) DEFAULT 12.0,
  avg_rating NUMERIC(3,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE seller_documents (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL, -- business_license, id_proof, bank_proof
  file_url TEXT NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id),
  brand_id INTEGER REFERENCES brands(id),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  specifications JSONB,
  base_price NUMERIC(12,2) NOT NULL,   -- in seller's/base currency (usually INR)
  mrp NUMERIC(12,2),
  personalization_available BOOLEAN DEFAULT FALSE,
  gift_wrap_available BOOLEAN DEFAULT TRUE,
  preparation_time_minutes INTEGER DEFAULT 60,
  status TEXT DEFAULT 'pending_approval', -- pending_approval, approved, rejected, disabled
  is_featured BOOLEAN DEFAULT FALSE,
  avg_rating NUMERIC(3,2) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  variant_name TEXT NOT NULL,  -- e.g. "Size", "Color"
  variant_value TEXT NOT NULL, -- e.g. "Half Kg", "Red"
  price_delta NUMERIC(12,2) DEFAULT 0,
  sku TEXT UNIQUE
);

CREATE TABLE product_countries (
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  country_id INTEGER REFERENCES countries(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, country_id)
);

CREATE TABLE warehouses (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id),
  country_id INTEGER REFERENCES countries(id),
  name TEXT NOT NULL,
  address TEXT,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE inventory (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id),
  quantity INTEGER DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 5,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- CART / WISHLIST
-- ---------------------------------------------------------------
CREATE TABLE carts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  variant_id INTEGER REFERENCES product_variants(id),
  quantity INTEGER DEFAULT 1,
  gift_wrap BOOLEAN DEFAULT FALSE,
  gift_message TEXT,
  recipient_id INTEGER REFERENCES recipients(id),
  delivery_date DATE,
  saved_for_later BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE wishlists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE
);

CREATE TABLE wishlist_items (
  id SERIAL PRIMARY KEY,
  wishlist_id INTEGER REFERENCES wishlists(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(wishlist_id, product_id)
);

-- ---------------------------------------------------------------
-- COUPONS
-- ---------------------------------------------------------------
CREATE TABLE coupons (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL, -- percentage, fixed
  value NUMERIC(12,2) NOT NULL,
  min_order_value NUMERIC(12,2) DEFAULT 0,
  country_id INTEGER REFERENCES countries(id),
  category_id INTEGER REFERENCES categories(id),
  seller_id INTEGER REFERENCES sellers(id),
  first_order_only BOOLEAN DEFAULT FALSE,
  usage_limit INTEGER,
  used_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- ORDERS
-- ---------------------------------------------------------------
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id),
  recipient_id INTEGER REFERENCES recipients(id),
  delivery_address_id INTEGER REFERENCES addresses(id),
  country_id INTEGER REFERENCES countries(id),
  currency_code TEXT NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  discount_amount NUMERIC(12,2) DEFAULT 0,
  tax_amount NUMERIC(12,2) DEFAULT 0,
  shipping_amount NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL,
  coupon_id INTEGER REFERENCES coupons(id),
  delivery_date DATE,
  delivery_time_slot TEXT,
  status TEXT DEFAULT 'pending_payment',
  -- pending_payment, payment_confirmed, order_confirmed, seller_accepted, preparing,
  -- packed, ready_for_pickup, picked_up, in_transit, customs_clearance,
  -- out_for_delivery, delivered, cancelled, refund_initiated, refunded
  placed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  changed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  variant_id INTEGER REFERENCES product_variants(id),
  seller_id INTEGER REFERENCES sellers(id),
  product_name_snapshot TEXT NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL,
  gift_wrap BOOLEAN DEFAULT FALSE,
  gift_message TEXT,
  personalization JSONB,
  item_status TEXT DEFAULT 'pending' -- pending, accepted, rejected, preparing, packed
);

-- ---------------------------------------------------------------
-- PAYMENTS (abstraction layer — see backend/src/services/paymentProvider.js)
-- ---------------------------------------------------------------
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,          -- razorpay, stripe, mock...
  provider_payment_id TEXT,
  amount NUMERIC(12,2) NOT NULL,
  currency_code TEXT NOT NULL,
  status TEXT DEFAULT 'created',   -- created, authorized, captured, failed, refunded
  method TEXT,                     -- card, upi, wallet, netbanking, cod
  webhook_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER REFERENCES payments(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- charge, refund, payout
  amount NUMERIC(12,2) NOT NULL,
  status TEXT DEFAULT 'pending',
  provider_reference TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES payments(id),
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'requested', -- requested, approved, processing, refunded, rejected
  requested_by INTEGER REFERENCES users(id),
  processed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE commissions (
  id SERIAL PRIMARY KEY,
  order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
  seller_id INTEGER REFERENCES sellers(id),
  rate NUMERIC(5,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payouts (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, processing, paid, failed
  period_start DATE,
  period_end DATE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  invoice_number TEXT UNIQUE NOT NULL,
  pdf_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- SHIPPING / FULFILMENT
-- ---------------------------------------------------------------
CREATE TABLE couriers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  supported_countries INTEGER[],
  tracking_url_template TEXT, -- e.g. https://track.example.com/{tracking_number}
  api_integration_key_env TEXT -- name of the env var holding the API key (never store the key itself)
);

CREATE TABLE shipping_methods (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL, -- Standard, Express, Same-Day
  courier_id INTEGER REFERENCES couriers(id),
  base_cost NUMERIC(12,2) DEFAULT 0,
  cost_per_kg NUMERIC(12,2) DEFAULT 0,
  estimated_days_min INTEGER,
  estimated_days_max INTEGER
);

CREATE TABLE shipments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  courier_id INTEGER REFERENCES couriers(id),
  shipping_method_id INTEGER REFERENCES shipping_methods(id),
  tracking_number TEXT,
  fulfilment_model TEXT DEFAULT 'cross_border', -- cross_border | local_fulfilment
  origin_warehouse_id INTEGER REFERENCES warehouses(id),
  status TEXT DEFAULT 'label_created',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tracking_events (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  location TEXT,
  description TEXT,
  event_time TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- REVIEWS
-- ---------------------------------------------------------------
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  order_item_id INTEGER REFERENCES order_items(id),
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  seller_id INTEGER REFERENCES sellers(id),
  user_id INTEGER REFERENCES users(id),
  product_rating INTEGER CHECK (product_rating BETWEEN 1 AND 5),
  seller_rating INTEGER CHECK (seller_rating BETWEEN 1 AND 5),
  delivery_rating INTEGER CHECK (delivery_rating BETWEEN 1 AND 5),
  review_text TEXT,
  image_urls TEXT[],
  is_reported BOOLEAN DEFAULT FALSE,
  is_hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- GIFT CARDS
-- ---------------------------------------------------------------
CREATE TABLE gift_cards (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  balance NUMERIC(12,2) NOT NULL,
  currency_code TEXT NOT NULL,
  purchaser_id INTEGER REFERENCES users(id),
  recipient_email TEXT,
  recipient_phone TEXT,
  message TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE gift_card_redemptions (
  id SERIAL PRIMARY KEY,
  gift_card_id INTEGER REFERENCES gift_cards(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id),
  amount_used NUMERIC(12,2) NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- NOTIFICATIONS / SUPPORT / AUDIT
-- ---------------------------------------------------------------
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- in_app, email, sms, push
  event TEXT NOT NULL,   -- order_placed, payment_success, out_for_delivery...
  title TEXT,
  body TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE support_tickets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  order_id INTEGER REFERENCES orders(id),
  category TEXT NOT NULL, -- order_issue, payment_issue, delivery_issue, refund, product_issue, seller_issue, other
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open', -- open, in_progress, resolved, closed
  assigned_to INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE support_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_seller ON products(seller_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_seller ON order_items(seller_id);
CREATE INDEX idx_inventory_product ON inventory(product_id);
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX idx_tracking_events_shipment ON tracking_events(shipment_id);

-- ---------------------------------------------------------------
-- OTP CODES (added for real phone-verification support)
-- ---------------------------------------------------------------
CREATE TABLE otp_codes (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_otp_codes_phone ON otp_codes(phone, expires_at);
