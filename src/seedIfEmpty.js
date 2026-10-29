require('dotenv').config();
const path = require('path');
const { execFileSync } = require('child_process');
const prisma = require('./prisma/client');

// Used by hosted deploys (see render.yaml): seed demo data on the first boot
// only. Re-running seed.js on every deploy would overwrite menu items edited
// from the Manager Dashboard, since its menu upserts refresh existing rows.
async function main() {
  const userCount = await prisma.user.count();
  await prisma.$disconnect();
  if (userCount > 0) {
    console.log(`Database already has ${userCount} user(s) — skipping seed.`);
    return;
  }
  console.log('Empty database — seeding demo data...');
  execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: 'inherit' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
