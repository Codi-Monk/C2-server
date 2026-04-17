// src/utils/jwt.js
// Thin wrappers around jsonwebtoken for signing and verifying Admin JWTs.

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

if (!SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

/**
 * Signs a JWT for an Admin user.
 * @param {object} payload - Data to embed (e.g. { id, email, role })
 * @returns {string} Signed JWT string
 */
const signToken = (payload) => {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
};

/**
 * Verifies and decodes a JWT.
 * @param {string} token
 * @returns {object} Decoded payload
 * @throws {JsonWebTokenError | TokenExpiredError}
 */
const verifyToken = (token) => {
  return jwt.verify(token, SECRET);
};

module.exports = { signToken, verifyToken };
