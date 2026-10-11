import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./src/db/schema";

// The developer keys file, by name, outside every checkout (SAA-227 part L
// decision 13). A DATABASE_URL already set wins: scratch-db.sh push sets the
// scratch branch's.
config({ path: join(homedir(), ".config", "clipwise", "dev.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

// drizzle-kit may only touch the tables src/db/schema.ts declares. Better
// Auth's tables (auth_*, jwks, oauth*) live in the same database but are
// created by src/auth/migrate.ts; without this allow-list, `db:push` would see
// them as unknown and propose dropping them. Derived from the schema so a new
// table here is covered the moment it is declared, and an unknown table is
// ignored rather than dropped.
const ownTables = Object.values(schema)
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableConfig(t).name);

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: ownTables,
  strict: true,
  verbose: true,
});
