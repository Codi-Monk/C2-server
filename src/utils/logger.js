// src/utils/logger.js
// Structured logger using Winston. Writes JSON in production, pretty-prints in dev.

const { createLogger, format, transports } = require('winston');

const { combine, timestamp, errors, json, colorize, printf } = format;

const isDev = process.env.NODE_ENV !== 'production';

const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let log = `${timestamp} [${level}]: ${stack || message}`;
  if (Object.keys(meta).length) {
    log += `\n  ${JSON.stringify(meta, null, 2)}`;
  }
  return log;
});

const logger = createLogger({
  level: isDev ? 'debug' : 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    errors({ stack: true })
  ),
  transports: [
    new transports.Console({
      format: isDev
        ? combine(colorize(), devFormat)
        : combine(json()),
    }),
  ],
  // Prevent Winston from crashing the process on unhandled promise rejections
  exitOnError: false,
});

module.exports = logger;
