import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
});

export const db = drizzle(pool, { schema });

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
