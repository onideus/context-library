import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  max: 5,
  connectionTimeoutMillis: 3_000, // fail fast when Postgres is unavailable
});

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}
