// src/middleware/agentAuth.js
// Authenticates Python Agent requests via the X-Agent-API-Key header.
// Attaches the full Agent DB record to req.agent on success.

const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

const agentAuth = async (req, res, next) => {
  const apiKey = req.headers['x-agent-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing X-Agent-API-Key header.',
    });
  }

  try {
    const agent = await prisma.agent.findUnique({
      where: { api_key: apiKey },
    });

    if (!agent) {
      logger.warn('Agent auth failed: unknown API key', { apiKey: `${apiKey.slice(0, 8)}...` });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid API key.',
      });
    }

    req.agent = agent;
    next();
  } catch (err) {
    logger.error('Agent auth middleware DB error', { error: err.message });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = agentAuth;
