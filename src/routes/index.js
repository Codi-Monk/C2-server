// src/routes/index.js
// Assembles all route groups and exports a single Express Router.
// The `io` instance is passed in to allow controllers to broadcast via Socket.io.

const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const agentAuth = require('../middleware/agentAuth');
const adminAuth = require('../middleware/adminAuth');

const { registerAgent, listAgents, getAgent } = require('../controllers/agentController');
const { batchIngestLogs, getLogs, purgeAgentLogs } = require('../controllers/logController');
const { login, register, me } = require('../controllers/authController');

/**
 * @param {import('socket.io').Server} io
 * @returns {import('express').Router}
 */
const createRouter = (io) => {
  const router = Router();

  // ─── Rate limiters ──────────────────────────────────────────────────────────
  const agentLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too Many Requests', message: 'Slow down, agent.' },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { error: 'Too Many Requests', message: 'Too many auth attempts.' },
  });

  // ─── Health check (public) ──────────────────────────────────────────────────
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ─── Auth routes (public) ───────────────────────────────────────────────────
  router.post('/api/auth/login', authLimiter, login);
  router.post('/api/auth/register', authLimiter, register); // Lock down post-setup!
  router.get('/api/auth/me', adminAuth, me);

  // ─── Agent self-registration (public, but rate-limited) ────────────────────
  router.post('/api/agents/register', agentLimiter, registerAgent);

  // ─── Agent data ingestion (authenticated via API key) ──────────────────────
  router.post('/api/logs/batch', agentLimiter, agentAuth, batchIngestLogs(io));

  // ─── Admin-only routes (authenticated via JWT) ──────────────────────────────
  router.get('/api/agents', adminAuth, listAgents);
  router.get('/api/agents/:id', adminAuth, getAgent);
  router.get('/api/logs', adminAuth, getLogs);
  router.delete('/api/logs/:agentId', adminAuth, purgeAgentLogs);

  // ─── 404 fallthrough ───────────────────────────────────────────────────────
  router.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `${req.method} ${req.path} not found.` });
  });

  return router;
};

module.exports = createRouter;
