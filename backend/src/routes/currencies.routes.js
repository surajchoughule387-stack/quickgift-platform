const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { convert, getRates } = require('../services/exchangeRate');
const { ApiError } = require('../middleware/errorHandler');

// GET /api/currencies — public
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM currencies ORDER BY code');
    res.json({ currencies: rows });
  } catch (err) { next(err); }
});

// GET /api/currencies/rates — public, live/fallback exchange rates (base INR)
router.get('/rates', async (req, res, next) => {
  try {
    res.json({ base: 'INR', rates: await getRates() });
  } catch (err) { next(err); }
});

// GET /api/currencies/convert?amount=2499&to=USD
router.get('/convert', async (req, res, next) => {
  try {
    const amount = parseFloat(req.query.amount);
    const to = req.query.to;
    if (!amount || !to) throw new ApiError(400, 'amount and to are required.');
    res.json({ amount, from: 'INR', to, converted: await convert(amount, to) });
  } catch (err) { next(err); }
});

// POST /api/currencies — admin only
router.post('/', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { code, symbol, decimal_places = 2 } = req.body;
    if (!code || !symbol) throw new ApiError(400, 'code and symbol are required.');
    const { rows } = await db.query(
      'INSERT INTO currencies (code, symbol, decimal_places) VALUES ($1,$2,$3) RETURNING *',
      [code.toUpperCase(), symbol, decimal_places]
    );
    res.status(201).json({ currency: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
