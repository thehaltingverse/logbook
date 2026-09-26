import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createTestDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      const bound = (args) => ({
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async first() {
          return db.prepare(sql).get(...args) ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      });
      return {
        bind(...args) {
          return bound(args);
        },
        all() {
          return bound([]).all();
        },
        first() {
          return bound([]).first();
        },
        run() {
          return bound([]).run();
        },
      };
    },
  };
}
