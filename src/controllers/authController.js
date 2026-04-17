// src/controllers/authController.js
// Handles Admin authentication: login and initial account seeding.

const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { signToken } = require('../utils/jwt');
const logger = require('../utils/logger');

const SALT_ROUNDS = 12;

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns a signed JWT on success.
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '`email` and `password` are required.',
      });
    }

    const admin = await prisma.admin.findUnique({ where: { email } });

    // Constant-time comparison avoids timing attacks even on unknown emails
    const dummyHash = '$2b$12$invalidhashfortimingprotection000000000000000000000000';
    const isValid = admin
      ? await bcrypt.compare(password, admin.password_hash)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!admin || !isValid) {
      logger.warn('Failed admin login attempt', { email });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password.',
      });
    }

    const token = signToken({ id: admin.id, email: admin.email, role: admin.role });
    logger.info('Admin logged in', { adminId: admin.id, email: admin.email });

    return res.json({
      message: 'Login successful.',
      token,
      admin: { id: admin.id, email: admin.email, role: admin.role },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/register
 * Creates the first superadmin account.
 * In production, secure this route behind an env-flag or remove after first use.
 * Body: { email, password, role? }
 */
const register = async (req, res, next) => {
  try {
    const { email, password, role = 'viewer' } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: '`email` and `password` are required.',
      });
    }

    if (password.length < 12) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Password must be at least 12 characters long.',
      });
    }

    const existing = await prisma.admin.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'An admin with this email already exists.',
      });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const admin = await prisma.admin.create({
      data: { email, password_hash, role },
      select: { id: true, email: true, role: true, created_at: true },
    });

    logger.info('Admin account created', { adminId: admin.id });
    return res.status(201).json({ message: 'Admin created.', admin });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/me
 * Returns the current admin's profile from their JWT.
 */
const me = (req, res) => {
  return res.json({ admin: req.admin });
};

module.exports = { login, register, me };
