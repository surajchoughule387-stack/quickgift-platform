const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET; // MUST be set in .env — no fallback in production
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload) {
  if (!SECRET) throw new Error('JWT_SECRET is not set. Add it to your .env file.');
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  if (!SECRET) throw new Error('JWT_SECRET is not set. Add it to your .env file.');
  return jwt.verify(token, SECRET);
}

module.exports = { signToken, verifyToken };
