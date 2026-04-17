// src/controllers/agentController.js
// Handles Agent registration and heartbeat REST endpoints.

const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

/**
 * POST /api/agents/register
 * Called once by a new Python agent to get its persistent API key.
 * Body: { hostname, ip_address, os_info? }
 */
const registerAgent = async (req, res, next) => {
  try {
    const { hostname, ip_address, os_info } = req.body;

    if (!hostname || !ip_address) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '`hostname` and `ip_address` are required.',
      });
    }

    // Upsert so re-registrations from the same host are idempotent
    const agent = await prisma.agent.upsert({
      where: { api_key: uuidv4() }, // placeholder — real key generated below
      // NOTE: We use hostname+ip as a natural identity for upsert
      // A production system would use a machine UUID from the OS
      update: {
        ip_address,
        os_info,
        status: 'online',
        last_seen: new Date(),
      },
      create: {
        hostname,
        ip_address,
        os_info,
        api_key: uuidv4(),
        status: 'online',
      },
    });

    logger.info('Agent registered', { agentId: agent.id, hostname: agent.hostname });

    return res.status(201).json({
      message: 'Agent registered successfully.',
      agent_id: agent.id,
      api_key: agent.api_key,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/agents/register (simplified upsert by hostname)
 * Re-written to avoid upsert-by-generated-key antipattern.
 */
const registerAgentV2 = async (req, res, next) => {
  try {
    const { hostname, ip_address, os_info } = req.body;

    if (!hostname || !ip_address) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '`hostname` and `ip_address` are required.',
      });
    }

    // Check if an agent with this hostname already exists
    let agent = await prisma.agent.findFirst({ where: { hostname } });

    if (agent) {
      // Update connectivity info on re-registration
      agent = await prisma.agent.update({
        where: { id: agent.id },
        data: { ip_address, os_info, status: 'online', last_seen: new Date() },
      });
      logger.info('Agent re-registered', { agentId: agent.id, hostname });
    } else {
      // Create brand-new agent record with a fresh API key
      agent = await prisma.agent.create({
        data: {
          hostname,
          ip_address,
          os_info,
          api_key: uuidv4(),
          status: 'online',
        },
      });
      logger.info('Agent created', { agentId: agent.id, hostname });
    }

    return res.status(201).json({
      message: 'Agent registered successfully.',
      agent_id: agent.id,
      api_key: agent.api_key,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/agents
 * Admin-only: List all agents with their current status.
 */
const listAgents = async (req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      select: {
        id: true,
        hostname: true,
        ip_address: true,
        os_info: true,
        status: true,
        last_seen: true,
        created_at: true,
        _count: { select: { logs: true } },
      },
      orderBy: { last_seen: 'desc' },
    });

    return res.json({ agents });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/agents/:id
 * Admin-only: Get a single agent by ID.
 */
const getAgent = async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        hostname: true,
        ip_address: true,
        os_info: true,
        status: true,
        last_seen: true,
        created_at: true,
      },
    });

    if (!agent) {
      return res.status(404).json({ error: 'Not Found', message: 'Agent not found.' });
    }

    return res.json({ agent });
  } catch (err) {
    next(err);
  }
};

module.exports = { registerAgent: registerAgentV2, listAgents, getAgent };
