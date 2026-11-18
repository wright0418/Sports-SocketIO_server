import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbConnection {
  pool: Pool;
  db: Database;
  close: () => Promise<void>;
}

export function createDbConnection(databaseUrl: string): DbConnection {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
}

export { schema };
