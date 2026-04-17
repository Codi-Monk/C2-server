// src/middleware/errorHandler.js
// Centralised Express error handler. Must be registered LAST in server.js.

const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const isDev = process.env.NODE_ENV !== 'production';

  logger.error('Unhandled Express error', {
    status,
    message: err.message,
    path: req.originalUrl,
    method: req.method,
    stack: isDev ? err.stack : undefined,
  });

  return res.status(status).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.',
    ...(isDev && { stack: err.stack }),
  });
};

module.exports = errorHandler;
