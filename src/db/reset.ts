import { sql } from "drizzle-orm";

import { db } from "@/db";
import { logger } from "@/lib/logger";

const FORCE_FLAG = "--force";

const RESET_SENTINEL = "yes do it";

const resetLogger = logger.child({ module: "db-reset" });

function isForceMode() {
  return process.argv.includes(FORCE_FLAG);
}

async function confirmReset() {
  if (isForceMode()) {
    return true;
  }

  resetLogger.warn("This will DELETE all data in the public schema.");

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
    resetLogger.info("Reset cancelled");
    process.exit(0);
  }

  resetLogger.info("Starting database reset");

  resetLogger.info("Dropping and recreating public schema");

  await resetSchema();

  resetLogger.info("Running migrations");

  await runMigrations();

  resetLogger.info("Database reset complete");
}

reset().catch((err) => {
  resetLogger.error({ err }, "Database reset failed");
  process.exit(1);
});
