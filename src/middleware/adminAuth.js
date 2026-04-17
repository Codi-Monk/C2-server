// src/middleware/adminAuth.js
// Validates the Admin's Bearer JWT from the Authorization header.
// Attaches decoded payload to req.admin on success.

const { verifyToken } = require('../utils/jwt');
const logger = require('../utils/logger');

const adminAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header. Expected: Bearer <token>',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyToken(token);
    req.admin = decoded; // { id, email, role, iat, exp }
    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    logger.warn('Admin JWT validation failed', { reason: err.message });
    return res.status(401).json({
      error: 'Unauthorized',
      message: isExpired ? 'Token has expired.' : 'Invalid token.',
    });
  }
};

module.exports = adminAuth;
