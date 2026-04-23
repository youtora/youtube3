import { createClient } from "@tursodatabase/serverless/compat";

function rowToObject(row, columns) {
  if (!row) return null;

  if (typeof row === "object" && !Array.isArray(row)) {
    return { ...row };
  }

  const out = {};
  for (let i = 0; i < columns.length; i++) {
    out[columns[i]] = row[i];
  }
  return out;
}

function resultRows(rs) {
  const rows = rs?.rows || [];
  const columns = rs?.columns || [];
  return rows.map((row) => rowToObject(row, columns));
}

export function getDB(env) {
  if (env.__TURSO_DB__) return env.__TURSO_DB__;

  if (!env.TURSO_DATABASE_URL) {
    throw new Error("Missing TURSO_DATABASE_URL");
  }

  if (!env.TURSO_AUTH_TOKEN) {
    throw new Error("Missing TURSO_AUTH_TOKEN");
  }

  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = client.execute("PRAGMA foreign_keys = ON");
    }
    await readyPromise;
  }

  const db = {
    prepare(sql) {
      const state = {
        sql,
        args: [],
      };

      return {
        bind(...args) {
          state.args = args;
          return this;
        },

        async all() {
          await ensureReady();
          const rs = await client.execute({
            sql: state.sql,
            args: state.args,
          });

          return {
            results: resultRows(rs),
          };
        },

        async first() {
          await ensureReady();
          const rs = await client.execute({
            sql: state.sql,
            args: state.args,
          });

          return resultRows(rs)[0] || null;
        },

        async run() {
          await ensureReady();
          const rs = await client.execute({
            sql: state.sql,
            args: state.args,
          });

          return {
            meta: {
              changes: rs?.rowsAffected || 0,
              last_row_id: rs?.lastInsertRowid != null ? Number(rs.lastInsertRowid) : 0,
            },
          };
        },

        __toStmt() {
          return {
            sql: state.sql,
            args: state.args,
          };
        },
      };
    },

    async batch(statements) {
      await ensureReady();

      const stmts = statements.map((statement) => {
        if (statement?.__toStmt) return statement.__toStmt();
        return statement;
      });

      return client.batch(stmts, "write");
    },
  };

  env.__TURSO_DB__ = db;
  return db;
}
