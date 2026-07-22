// prisma/seed.js
// Run with: npx prisma db seed
// Creates the initial superadmin account on first deploy.
// Reads credentials from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD env vars.

'use strict';

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

// --- TEMPORARY ADMIN INJECTION ---
prisma.admin.upsert({
  where: { email: 'admin@monk.com' },
  update: { password: '$2a$12$qK4v1fZwSz11xXQ1ECcpVejxDdoCExVpu5jHZTInB1gKKEqeZqTN6' }, // <-- PASTE HASH HERE
  create: { email: 'admin@monk.com', password: '$2a$12$qK4v1fZwSz11xXQ1ECcpVejxDdoCExVpu5jHZTInB1gKKEqeZqTN6' } // <-- AND HERE
})
.then(() => console.log("🔥 INJECTION SUCCESS: Admin account created!"))
.catch((err) => console.error("INJECTION FAILED:", err));
// ----------------------------------

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@rmm.local';
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD env var is required. Set it before running the seed.'
    );
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    console.log(`ℹ️  Superadmin '${email}' already exists — skipping.`);
    return;
  }

  const password_hash = await bcrypt.hash(password, 12);

  const admin = await prisma.admin.create({
    data: { email, password_hash, role: 'superadmin' },
    select: { id: true, email: true, role: true },
  });

  console.log(`✅ Superadmin created: ${admin.email} (id: ${admin.id})`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
