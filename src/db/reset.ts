import { sql } from "drizzle-orm";

import { db } from "@/db";

const FORCE_FLAG = "--force";

const RESET_SENTINEL = "yes do it";

function isForceMode() {
  return process.argv.includes(FORCE_FLAG);
}

async function confirmReset() {
  if (isForceMode()) {
    return true;
  }

  console.log("This will DELETE all data in the public schema.");

  const answer = prompt(`Type "${RESET_SENTINEL}" to continue: `);

  return (answer ?? "").trim().toLowerCase() === RESET_SENTINEL;
}

async function resetSchema() {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE;`);

  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE;`);

  await db.execute(sql`CREATE SCHEMA public;`);
}

async function runMigrations() {
  const { $ } = await import("bun");

  await $`bun x --bun drizzle-kit migrate`;
}

async function reset() {
  const confirmed = await confirmReset();

  if (!confirmed) {
    console.log("Reset cancelled.");
    process.exit(0);
  }

  console.log("Starting database reset...");

  console.log("Dropping and recreating public schema...");

  await resetSchema();

  console.log("Running migrations...");

  await runMigrations();

  console.log("Database reset complete.");
}

reset().catch((err) => {
  console.error("Database reset failed.");
  console.error(err);
  process.exit(1);
});
