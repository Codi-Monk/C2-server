// src/server.js
// C2 Server Entry Point — RMM Platform
// Composes Express, Socket.io, Prisma, and all middleware in the correct order.

'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server: SocketIOServer } = require('socket.io');

const logger = require('./utils/logger');
const prisma = require('./utils/prisma');
const createRouter = require('./routes/index');
const registerSockets = require('./sockets/index');
const errorHandler = require('./middleware/errorHandler');

// ─── Validate critical environment variables ────────────────────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  logger.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── CORS configuration ─────────────────────────────────────────────────────
// Parse ALLOWED_ORIGINS from env; fall back to permissive "*" for dev
const rawOrigins = process.env.ALLOWED_ORIGINS;
const allowedOrigins = rawOrigins
  ? rawOrigins.split(',').map((o) => o.trim())
  : '*';

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-API-Key'],
  credentials: true,
};

// ─── Express app setup ──────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1); // Required on Render.com (sits behind a reverse proxy)

app.use(helmet({
  // Allow cross-origin requests from the dashboard
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight for all routes

app.use(express.json({ limit: '10mb' }));    // Accept large batch log payloads
app.use(express.urlencoded({ extended: false }));

// HTTP request logging — skip health-check noise in production
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => process.env.NODE_ENV === 'production' && req.path === '/health',
  })
);

// ─── HTTP server + Socket.io ────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: corsOptions,
  // Tune transport options for reliability
  transports: ['websocket', 'polling'], // prefer WS, fall back to polling
  pingTimeout: 20_000,
  pingInterval: 25_000,
  connectTimeout: 10_000,
  // Allow large keystroke payloads
  maxHttpBufferSize: 1e6, // 1 MB
});

// ─── Routes ─────────────────────────────────────────────────────────────────
// Routes need `io` so controllers can broadcast to /admin namespace
app.use('/', createRouter(io));

// ─── Socket.io namespaces ────────────────────────────────────────────────────
registerSockets(io);

// ─── Global error handler (must be LAST middleware) ──────────────────────────
app.use(errorHandler);

// ─── Database connection + Server boot ──────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

const start = async () => {
  try {
    // Verify Prisma can reach Postgres before accepting traffic
    await prisma.$connect();
    logger.info('PostgreSQL connection established via Prisma.');

    httpServer.listen(PORT, () => {
      logger.info(`C2 Server listening on port ${PORT}`, {
        env: process.env.NODE_ENV || 'development',
        pid: process.pid,
      });
    });
  } catch (err) {
    logger.error('Failed to start C2 Server', { error: err.message });
    await prisma.$disconnect();
    process.exit(1);
  }
};

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// On Render.com, SIGTERM is sent before the process is killed.
const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);

  httpServer.close(async () => {
    logger.info('HTTP server closed.');
    await prisma.$disconnect();
    logger.info('Database disconnected. Goodbye.');
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled promise rejections — log and keep running (do NOT crash)
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — process will exit', { error: err.message, stack: err.stack });
  process.exit(1);
});

start();

module.exports = { app, io }; // Export for testing
