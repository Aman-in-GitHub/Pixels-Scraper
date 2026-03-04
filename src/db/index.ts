import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "@/db/schema";
import { logger } from "@/lib/logger";

const dbLogger = logger.child({ module: "db" });

export const db = drizzle({
  logger: {
    logQuery: (query: string, params: unknown[]) => {
      dbLogger.debug({ query, params }, "Executed SQL query");
    },
  },
  schema: schema,
  casing: "snake_case",
  connection: { url: process.env.DATABASE_URL! },
});
