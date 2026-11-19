import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';
import { MIGRATION_TABLE_ORDER, POSTGRES_SCHEMA_SQL } from '../server/schema.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this migration.`);
  return value;
}

function copySqliteDatabase(sourcePath: string): { directory: string; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartattend-migrate-'));
  const databasePath = path.join(directory, path.basename(sourcePath));
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${sourcePath}${suffix}`;
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${databasePath}${suffix}`);
    }
  }
  return { directory, databasePath };
}

async function main(): Promise<void> {
  const connectionString = requireEnv('DATABASE_URL');
  const sqlitePath = path.resolve(process.env.SQLITE_DB_PATH || path.resolve(process.cwd(), 'smartattend.db'));
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}. Set SQLITE_DB_PATH to its location.`);
  }

  const temp = copySqliteDatabase(sqlitePath);
  const sqlite = new DatabaseSync(temp.databasePath);
  const postgres = new Client({ connectionString });
  let transactionOpen = false;

  try {
    await postgres.connect();
    await postgres.query('BEGIN');
    transactionOpen = true;
    await postgres.query(POSTGRES_SCHEMA_SQL);

    console.log(`Migrating ${sqlitePath} to PostgreSQL (existing rows are never overwritten).`);

    const tableExists = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'companies'")
      .get();
    if (!tableExists) {
      console.warn('The SQLite database has no application tables. PostgreSQL schema is ready; no data was copied.');
      await postgres.query('COMMIT');
      transactionOpen = false;
      return;
    }

    const summary: Array<{ table: string; source: number; inserted: number; target: number }> = [];

    const tableExistsInSqlite = sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    );

    for (const table of MIGRATION_TABLE_ORDER) {
      if (!tableExistsInSqlite.get(table)) {
        console.log(`  ${table}: table not present in SQLite`);
        continue;
      }

      const columns = (
        sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;

      if (columns.length === 0 || rows.length === 0) {
        console.log(`  ${table}: no source rows`);
        continue;
      }

      const columnList = columns.map((column) => `"${column}"`).join(', ');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const statement = `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      let inserted = 0;
      for (const row of rows) {
        const values = columns.map((column) => row[column] ?? null);
        const result = await postgres.query(statement, values);
        inserted += result.rowCount ?? 0;
      }

      const countResult = await postgres.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}"`
      );
      summary.push({ table, source: rows.length, inserted, target: countResult.rows[0].count });
      console.log(
        `  ${table}: ${rows.length} source row(s), ${inserted} inserted, ${rows.length - inserted} already present`
      );
    }

    const sequences = tableExistsInSqlite.get('id_sequences')
      ? (sqlite.prepare('SELECT seq_name, last_value FROM id_sequences').all() as Array<{
          seq_name: string;
          last_value: number;
        }>)
      : [];
    for (const sequence of sequences) {
      await postgres.query(
        `INSERT INTO id_sequences (seq_name, last_value) VALUES ($1, $2)
         ON CONFLICT (seq_name) DO UPDATE SET last_value = GREATEST(id_sequences.last_value, excluded.last_value)`,
        [sequence.seq_name, sequence.last_value]
      );
    }

    await postgres.query('COMMIT');
    transactionOpen = false;

    const mismatches = summary.filter((row) => row.target < row.source);
    if (mismatches.length > 0) {
      console.warn(
        'Migration completed with row-count differences (usually pre-existing data with different keys):',
        mismatches
      );
    } else {
      console.log('Migration completed. All source rows are present in PostgreSQL.');
    }
  } catch (err) {
    if (transactionOpen) {
      await postgres.query('ROLLBACK');
    }
    throw err;
  } finally {
    await postgres.end();
    sqlite.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('SQLite to PostgreSQL migration failed:', err);
  process.exit(1);
});
