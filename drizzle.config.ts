import { defineConfig } from "drizzle-kit";

export default defineConfig({
  strict: true,
  verbose: true,
  casing: "snake_case",
  dialect: "postgresql",
  out: "./src/db/migrations",
  schema: "./src/db/schema/index.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
