// src/utils/prisma.js
// Exports a singleton PrismaClient instance.
// Prevents exhausting DB connections during hot-reload in development.

const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');

const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

// Surface Prisma warnings/errors through our structured logger
prisma.$on('warn', (e) => logger.warn('Prisma warning', { message: e.message }));
prisma.$on('error', (e) => logger.error('Prisma error', { message: e.message }));

module.exports = prisma;
