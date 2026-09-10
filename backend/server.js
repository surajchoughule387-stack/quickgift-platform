require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { errorHandler, notFound } = require('./src/middleware/errorHandler');

const authRoutes = require('./src/routes/auth.routes');
const productsRoutes = require('./src/routes/products.routes');
const categoriesRoutes = require('./src/routes/categories.routes');
const cartRoutes = require('./src/routes/cart.routes');
const wishlistRoutes = require('./src/routes/wishlist.routes');
const ordersRoutes = require('./src/routes/orders.routes');
const addressesRoutes = require('./src/routes/addresses.routes');
const paymentsRoutes = require('./src/routes/payments.routes');
const sellersRoutes = require('./src/routes/sellers.routes');
const adminRoutes = require('./src/routes/admin.routes');
const countriesRoutes = require('./src/routes/countries.routes');
const currenciesRoutes = require('./src/routes/currencies.routes');
const couponsRoutes = require('./src/routes/coupons.routes');
const reviewsRoutes = require('./src/routes/reviews.routes');
const notificationsRoutes = require('./src/routes/notifications.routes');
const supportRoutes = require('./src/routes/support.routes');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Rate limiting — protects auth and checkout endpoints from abuse.
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(generalLimiter);
app.use('/api/auth', authLimiter);

// The payment webhook needs the RAW request body to verify the provider's
// signature, so it must be mounted BEFORE express.json() with express.raw().
app.use('/api/payments/webhook', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// API routes — matches the /api/* structure from the spec (section 34)
// ---------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/addresses', addressesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/countries', countriesRoutes);
app.use('/api/currencies', currenciesRoutes);
app.use('/api/coupons', couponsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/support', supportRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`QuickGift API listening on port ${PORT}`);
  if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET is not set in .env — auth will fail until you set one.');
  }
});

module.exports = app;
