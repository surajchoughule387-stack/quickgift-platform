
const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { getShiprocketToken } = require('../services/shiprocket');

// GET /api/shiprocket/status
// Safe connection test — does NOT create an order or shipment.
router.get('/status', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    await getShiprocketToken();

    res.json({
      connected: true,
      service: 'Shiprocket',
      message: 'Shiprocket API authentication successful.'
    });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
