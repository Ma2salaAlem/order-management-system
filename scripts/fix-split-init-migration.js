// Runs before `prisma migrate deploy` on the Render deploy (see render.yaml).
//
// Older copies of this app had no separate "init" migration: the whole
// starting schema lived in 20260731131959_add_item_customization. Later it
// was split into 20260731102504_init + a smaller add_item_customization,
// which ends in the same database. A database built from the old copy has
// the tables already but no "init" row in its migration history, so
// `migrate deploy` would try to create them again and fail.
//
// For such a database this marks "init" as applied (nothing else changes).
// On a fresh database, or one already on the new history, it does nothing.
const path = require('path');
const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const INIT = '20260731102504_init';
const OLD_FIRST = '20260731131959_add_item_customization';

async function main() {
  const prisma = new PrismaClient();
  let rows;
  try {
    const [{ exists }] = await prisma.$queryRaw`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS "exists"`;
    if (!exists) {
      console.log('[migrations] fresh database — nothing to fix');
      return;
    }
    rows = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name IN (${INIT}, ${OLD_FIRST}) AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  } finally {
    await prisma.$disconnect();
  }

  const applied = new Set(rows.map((r) => r.migration_name));
  if (!applied.has(OLD_FIRST) || applied.has(INIT)) {
    console.log('[migrations] history already matches — nothing to fix');
    return;
  }

  console.log(`[migrations] old history found — marking ${INIT} as applied`);
  const prismaCli = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'resolve', '--applied', INIT], { stdio: 'inherit' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
