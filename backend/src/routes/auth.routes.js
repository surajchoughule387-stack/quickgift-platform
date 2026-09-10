const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const { hashPassword, comparePassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/auth');
const { ApiError } = require('../middleware/errorHandler');
const { sendSms } = require('../services/notification');

async function getRoleId(roleName) {
  const { rows } = await db.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  if (!rows[0]) throw new ApiError(500, `Role "${roleName}" is not seeded in the database.`);
  return rows[0].id;
}

// POST /api/auth/register  { name, email, phone, password, role? }
// role defaults to 'customer'. Sellers/admins are provisioned separately
// (sellers via /api/sellers/register which starts a verification flow;
// admins are created directly in the DB or by a super_admin — never via
// public self-registration).
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !password || (!email && !phone)) {
      throw new ApiError(400, 'name, password and at least one of email/phone are required.');
    }
    const existing = await db.query('SELECT id FROM users WHERE email = $1 OR phone = $2', [email || null, phone || null]);
    if (existing.rows.length) throw new ApiError(409, 'An account with this email or phone already exists.');

    const roleId = await getRoleId('customer');
    const passwordHash = await hashPassword(password);

    const { rows } = await db.query(
      `INSERT INTO users (name, email, phone, password_hash, role_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, phone`,
      [name, email || null, phone || null, passwordHash, roleId]
    );
    const user = rows[0];

    // Every customer gets a cart and wishlist row on signup.
    await db.query('INSERT INTO carts (user_id) VALUES ($1)', [user.id]);
    await db.query('INSERT INTO wishlists (user_id) VALUES ($1)', [user.id]);

    const token = signToken({ userId: user.id });
    res.status(201).json({ token, user: { ...user, role: 'customer' } });
  } catch (err) { next(err); }
});

// POST /api/auth/login  { email OR phone, password }
router.post('/login', async (req, res, next) => {
  try {
    const { email, phone, password } = req.body;
    if ((!email && !phone) || !password) throw new ApiError(400, 'email/phone and password are required.');

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.password_hash, u.is_blocked, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.email = $1 OR u.phone = $2`,
      [email || null, phone || null]
    );
    const user = rows[0];
    if (!user) throw new ApiError(401, 'Invalid credentials.');
    if (user.is_blocked) throw new ApiError(403, 'This account has been blocked. Contact support.');

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) throw new ApiError(401, 'Invalid credentials.');

    const token = signToken({ userId: user.id });
    delete user.password_hash;
    res.json({ token, user });
  } catch (err) { next(err); }
});

function hashOtp(phone, code) {
  return crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

// POST /api/auth/otp/request { phone }
// Generates a real, server-stored, expiring OTP and sends it via Twilio when
// configured. Without Twilio credentials it logs to console and returns the
// code in the response so local development still works end-to-end.
router.post('/otp/request', async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) throw new ApiError(400, 'phone is required.');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    await db.query('INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2,$3)', [phone, hashOtp(phone, code), expiresAt]);

    if (process.env.TWILIO_ACCOUNT_SID) {
      await sendSms(phone, `Your QuickGift verification code is ${code}. It expires in 5 minutes.`);
      return res.json({ message: 'OTP sent.' });
    }
    console.log(`[otp:dev] phone=${phone} code=${code} (Twilio not configured — shown here for local testing only)`);
    res.json({ message: 'OTP provider not configured — returning the code directly for local development only. Set TWILIO_ACCOUNT_SID etc. in .env to send real SMS.', devOtp: code });
  } catch (err) { next(err); }
});

// POST /api/auth/otp/verify { phone, otp } — pairs with /otp/request, checked against the real stored+hashed code.
router.post('/otp/verify', async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) throw new ApiError(400, 'phone and otp are required.');

    const otpRow = await db.query(
      `SELECT id FROM otp_codes WHERE phone = $1 AND code_hash = $2 AND consumed = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone, hashOtp(phone, otp)]
    );
    if (!otpRow.rows[0]) throw new ApiError(401, 'Invalid or expired OTP.');
    await db.query('UPDATE otp_codes SET consumed = true WHERE id = $1', [otpRow.rows[0].id]);

    let { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, r.name AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.phone = $1`,
      [phone]
    );
    let user = rows[0];
    if (!user) {
      const roleId = await getRoleId('customer');
      const created = await db.query(
        `INSERT INTO users (name, phone, role_id, phone_verified, auth_provider) VALUES ($1,$2,$3,true,'otp') RETURNING id, name, phone`,
        ['New User', phone, roleId]
      );
      user = { ...created.rows[0], role: 'customer' };
      await db.query('INSERT INTO carts (user_id) VALUES ($1)', [user.id]);
      await db.query('INSERT INTO wishlists (user_id) VALUES ($1)', [user.id]);
    }
    const token = signToken({ userId: user.id });
    res.json({ token, user });
  } catch (err) { next(err); }
});

// POST /api/auth/google { idToken } — stub: verify with google-auth-library in production.
router.post('/google', async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      throw new ApiError(501, 'Google login is not configured. Set GOOGLE_CLIENT_ID and implement token verification (google-auth-library) in this route.');
    }
    // Real integration point: verify req.body.idToken with google-auth-library,
    // then find-or-create the user exactly like the OTP flow above.
    res.status(501).json({ error: 'Not implemented — add google-auth-library verification here.' });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
