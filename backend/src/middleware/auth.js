const { verifyToken } = require('../utils/jwt');
const db = require('../config/db');

// Verifies the JWT and attaches the current user (with role name) to req.user.
// Every protected route uses this — role checks happen server-side only,
// never trust a role claimed by the frontend.
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    const decoded = verifyToken(token);

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.is_blocked, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [decoded.userId]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User no longer exists.' });
    if (user.is_blocked) return res.status(403).json({ error: 'This account has been blocked.' });

    req.user = user; // { id, name, email, phone, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// Optional auth: attaches req.user if a valid token is present, but doesn't
// reject the request if it's missing (used for public browse-with-personalization routes).
async function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  return authenticate(req, res, next);
}

module.exports = { authenticate, optionalAuthenticate };
