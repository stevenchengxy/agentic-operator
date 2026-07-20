import { Pool, type PoolClient, type QueryResultRow } from "pg";

/** Small structural surface used by the persistence and rule-context tools. */
export interface RaasPgSession {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

const pools = new Map<string, Pool>();

function poolFor(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 30_000,
      application_name: "agentic-operator-recruitment",
    });
    pools.set(connectionString, pool);
  }
  return pool;
}

export async function withRaasPgConnection<T>(
  connectionString: string,
  fn: (client: RaasPgSession) => Promise<T>,
): Promise<T> {
  const client = await poolFor(connectionString).connect();
  try {
    return await fn(client as PoolClient);
  } finally {
    client.release();
  }
}

export async function withRaasPgTransaction<T>(
  connectionString: string,
  fn: (client: RaasPgSession) => Promise<T>,
): Promise<T> {
  return withRaasPgConnection(connectionString, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original write failure; rollback failure is secondary.
      }
      throw error;
    }
  });
}
