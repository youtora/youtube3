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

function isRetryableLibsql404(error) {
  const msg = String(error || "");
  return msg.includes("LibsqlError") && msg.includes("HTTP error! status: 404");
}

function makeClient(env) {
  if (!env.TURSO_DATABASE_URL) {
    throw new Error("Missing TURSO_DATABASE_URL");
  }

  if (!env.TURSO_AUTH_TOKEN) {
    throw new Error("Missing TURSO_AUTH_TOKEN");
  }

  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

async function execWithRetry(env, payload) {
  let client = makeClient(env);

  try {
    return await client.execute(payload);
  } catch (error) {
    if (!isRetryableLibsql404(error)) {
      throw error;
    }

    client = makeClient(env);
    return await client.execute(payload);
  }
}

export function getDB(env) {
  return {
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
          const rs = await execWithRetry(env, {
            sql: state.sql,
            args: state.args,
          });

          return {
            results: resultRows(rs),
          };
        },

        async first() {
          const rs = await execWithRetry(env, {
            sql: state.sql,
            args: state.args,
          });

          return resultRows(rs)[0] || null;
        },

        async run() {
          const rs = await execWithRetry(env, {
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
      let totalChanges = 0;
      let lastRowId = 0;

      for (const statement of statements) {
        const stmt = statement?.__toStmt ? statement.__toStmt() : statement;

        const rs = await execWithRetry(env, {
          sql: stmt.sql,
          args: stmt.args || [],
        });

        totalChanges += rs?.rowsAffected || 0;

        if (rs?.lastInsertRowid != null) {
          lastRowId = Number(rs.lastInsertRowid);
        }
      }

      return {
        meta: {
          changes: totalChanges,
          last_row_id: lastRowId,
        },
      };
    },
  };
}
