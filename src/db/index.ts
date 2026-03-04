import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "@/db/schema";

export const db = drizzle({
  logger: true,
  schema: schema,
  casing: "snake_case",
  connection: { url: process.env.DATABASE_URL! },
});
