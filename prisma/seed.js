// prisma/seed.js
// Run with: npx prisma db seed
// Upserts the superadmin account. 
// If the email exists, it updates the password to match your .env variable.

'use strict';

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

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

  // Hash the password from the .env file
  const password_hash = await bcrypt.hash(password, 12);

  // Upsert: Update if exists, Create if it does not
  const admin = await prisma.admin.upsert({
    where: { email },
    update: { password_hash, role: 'superadmin' },
    create: { email, password_hash, role: 'superadmin' },
    select: { id: true, email: true, role: true },
  });

  console.log(`✅ Superadmin synced (created or password updated): ${admin.email} (id: ${admin.id})`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());