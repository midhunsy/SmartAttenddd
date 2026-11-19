import { Worker } from 'node:worker_threads';
import { Client } from 'pg';

const CONTROL_BYTES = 64;
const PAYLOAD_BYTES = 8 * 1024 * 1024;

const CTRL_STATE = 0;
const CTRL_REQUEST_LENGTH = 1;
const CTRL_RESPONSE_LENGTH = 2;
const CTRL_READY = 3;

const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const STATE_ERROR = 3;
const STATE_FATAL = 4;
const STATE_SHUTDOWN = 9;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const pg = require('pg');

pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

const sab = workerData.sab;
const payloadBytes = workerData.payloadBytes;
const ctrl = new Int32Array(sab, 0, 64);
const requestBytes = new Uint8Array(sab, 64, payloadBytes);
const responseBytes = new Uint8Array(sab, 64 + payloadBytes, payloadBytes);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const STATE = 0;
const REQUEST_LENGTH = 1;
const RESPONSE_LENGTH = 2;
const READY = 3;
const IDLE = 0;
const REQUEST = 1;
const RESPONSE = 2;
const ERROR = 3;
const FATAL = 4;
const SHUTDOWN = 9;

function writeResponse(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > payloadBytes) {
    throw new Error('PostgreSQL response exceeds the shared buffer limit.');
  }
  responseBytes.set(bytes, 0);
  Atomics.store(ctrl, RESPONSE_LENGTH, bytes.length);
}

function errorPayload(err) {
  return {
    error: {
      message: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
      detail: err && err.detail ? err.detail : undefined,
    },
  };
}

let client;
(async () => {
  try {
    const config = { connectionString: workerData.connectionString };
    if (workerData.searchPath) {
      config.options = '-c search_path=' + workerData.searchPath;
    }
    client = new pg.Client(config);
    await client.connect();
    Atomics.store(ctrl, READY, 1);
    Atomics.notify(ctrl, READY);
  } catch (err) {
    try {
      writeResponse(errorPayload(err));
    } catch {
    }
    Atomics.store(ctrl, STATE, FATAL);
    Atomics.store(ctrl, READY, 1);
    Atomics.notify(ctrl, STATE);
    Atomics.notify(ctrl, READY);
    return;
  }

  for (;;) {
    const state = Atomics.load(ctrl, STATE);
    if (state === SHUTDOWN) break;
    if (state !== REQUEST) {
      Atomics.wait(ctrl, STATE, state, 250);
      continue;
    }

    try {
      const length = Atomics.load(ctrl, REQUEST_LENGTH);
      const payload = JSON.parse(decoder.decode(requestBytes.subarray(0, length)));
      const result = payload.mode === 'exec'
        ? await client.query(payload.sql)
        : await client.query(payload.sql, payload.params || []);
      const results = Array.isArray(result) ? result : [result];
      const last = results[results.length - 1] || {};
      writeResponse({ rows: last.rows || [], rowCount: last.rowCount == null ? 0 : last.rowCount });
      Atomics.store(ctrl, STATE, RESPONSE);
    } catch (err) {
      try {
        writeResponse(errorPayload(err));
      } catch {
      }
      Atomics.store(ctrl, STATE, ERROR);
    }
    Atomics.notify(ctrl, STATE);
  }

  try {
    await client.end();
  } catch {
  }
})();
`;

export interface RunResult {
  rowCount: number;
  changes: number;
}

export interface PreparedStatement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): RunResult;
}

export interface ServerDatabase {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  close(): Promise<void>;
  readonly schemaName: string | null;
}

export interface PostgresDatabaseOptions {
  connectionString: string;
  schemaName?: string | null;
}

interface QueryResponse {
  rows?: any[];
  rowCount?: number;
  error?: { message: string; code?: string; detail?: string };
}

function validateSchemaName(schemaName: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid PostgreSQL schema name: ${schemaName}`);
  }
}

function convertPlaceholders(sql: string): string {
  let result = '';
  let index = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      result += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        result += '*/';
        i += 1;
        blockComment = false;
      } else {
        result += ch;
      }
      continue;
    }
    if (quote) {
      result += ch;
      if (ch === quote) {
        if (next === quote) {
          result += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      result += '--';
      i += 1;
      lineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      result += '/*';
      i += 1;
      blockComment = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === '?') {
      index += 1;
      result += `$${index}`;
      continue;
    }
    result += ch;
  }

  return result;
}

export function toPostgresSql(sql: string, convertParameters = true): string {
  let result = sql.replace(
    /([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*\?\s+COLLATE\s+NOCASE/gi,
    (_match, column: string) => `LOWER(${column}) = LOWER(?)`
  );
  result = result.replace(/\s+COLLATE\s+NOCASE/gi, '');
  result = result.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN');
  if (convertParameters) {
    result = convertPlaceholders(result);
  }
  return result;
}

export class PostgresDatabase implements ServerDatabase {
  private readonly sab: SharedArrayBuffer;
  private readonly ctrl: Int32Array;
  private readonly requestBytes: Uint8Array;
  private readonly responseBytes: Uint8Array;
  private readonly worker: Worker;
  private readonly connectionString: string;
  private ready = false;
  private closed = false;
  readonly schemaName: string | null;

  constructor(options: PostgresDatabaseOptions) {
    if (!options.connectionString) {
      throw new Error('DATABASE_URL is required to start SmartAttend.');
    }
    this.connectionString = options.connectionString;
    this.schemaName = options.schemaName ?? null;
    if (this.schemaName) validateSchemaName(this.schemaName);

    this.sab = new SharedArrayBuffer(CONTROL_BYTES + PAYLOAD_BYTES * 2);
    this.ctrl = new Int32Array(this.sab, 0, CONTROL_BYTES / 4);
    this.requestBytes = new Uint8Array(this.sab, CONTROL_BYTES, PAYLOAD_BYTES);
    this.responseBytes = new Uint8Array(this.sab, CONTROL_BYTES + PAYLOAD_BYTES, PAYLOAD_BYTES);

    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab: this.sab,
        payloadBytes: PAYLOAD_BYTES,
        connectionString: this.connectionString,
        searchPath: this.schemaName,
      },
    });
  }

  prepare(sql: string): PreparedStatement {
    const postgresSql = toPostgresSql(sql);
    return {
      get: (...params: unknown[]): any => {
        const result = this.execute('query', postgresSql, params);
        return result.rows?.[0];
      },
      all: (...params: unknown[]): any[] => {
        const result = this.execute('query', postgresSql, params);
        return result.rows ?? [];
      },
      run: (...params: unknown[]): RunResult => {
        const result = this.execute('query', postgresSql, params);
        const rowCount = result.rowCount ?? 0;
        return { rowCount, changes: rowCount };
      },
    };
  }

  exec(sql: string): void {
    this.execute('exec', toPostgresSql(sql, false), []);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    Atomics.store(this.ctrl, CTRL_STATE, STATE_SHUTDOWN);
    Atomics.notify(this.ctrl, CTRL_STATE);
    await this.worker.terminate();
    if (this.schemaName) {
      await dropPostgresSchema(this.connectionString, this.schemaName);
    }
  }

  private ensureReady(): void {
    if (this.ready) {
      if (Atomics.load(this.ctrl, CTRL_STATE) === STATE_FATAL) this.throwWorkerError();
      return;
    }

    const deadline = Date.now() + 30_000;
    while (Atomics.load(this.ctrl, CTRL_READY) !== 1) {
      if (Atomics.load(this.ctrl, CTRL_STATE) === STATE_FATAL) this.throwWorkerError();
      if (Date.now() > deadline) throw new Error('Timed out connecting to PostgreSQL.');
      Atomics.wait(this.ctrl, CTRL_READY, 0, 250);
    }
    this.ready = true;
    if (Atomics.load(this.ctrl, CTRL_STATE) === STATE_FATAL) this.throwWorkerError();
  }

  private throwWorkerError(): never {
    const response = this.readResponse();
    const message = response.error?.message ?? 'PostgreSQL worker failed to initialize.';
    const error = new Error(message) as Error & { code?: string; detail?: string };
    error.code = response.error?.code;
    error.detail = response.error?.detail;
    throw error;
  }

  private readResponse(): QueryResponse {
    const length = Atomics.load(this.ctrl, CTRL_RESPONSE_LENGTH);
    try {
      return JSON.parse(decoder.decode(this.responseBytes.subarray(0, length))) as QueryResponse;
    } catch {
      return {};
    }
  }

  private execute(mode: 'query' | 'exec', sql: string, params: unknown[]): QueryResponse {
    if (this.closed) throw new Error('Database connection is closed.');
    this.ensureReady();

    while (Atomics.load(this.ctrl, CTRL_STATE) !== STATE_IDLE) {
      const state = Atomics.load(this.ctrl, CTRL_STATE);
      if (state === STATE_FATAL) this.throwWorkerError();
      Atomics.wait(this.ctrl, CTRL_STATE, state, 250);
    }

    const payload = encoder.encode(JSON.stringify({ mode, sql, params }));
    if (payload.length > PAYLOAD_BYTES) {
      throw new Error('PostgreSQL request exceeds the shared buffer limit.');
    }
    this.requestBytes.set(payload, 0);
    Atomics.store(this.ctrl, CTRL_REQUEST_LENGTH, payload.length);
    Atomics.store(this.ctrl, CTRL_STATE, STATE_REQUEST);
    Atomics.notify(this.ctrl, CTRL_STATE);

    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const state = Atomics.load(this.ctrl, CTRL_STATE);
        if (state === STATE_RESPONSE || state === STATE_ERROR || state === STATE_FATAL) break;
        if (Date.now() > deadline) throw new Error('PostgreSQL query timed out.');
        Atomics.wait(this.ctrl, CTRL_STATE, state, 250);
      }

      const response = this.readResponse();
      if (response.error) {
        const error = new Error(response.error.message) as Error & {
          code?: string;
          detail?: string;
        };
        error.code = response.error.code;
        error.detail = response.error.detail;
        throw error;
      }
      return response;
    } finally {
      Atomics.store(this.ctrl, CTRL_STATE, STATE_IDLE);
      Atomics.notify(this.ctrl, CTRL_STATE);
    }
  }
}

export async function createPostgresSchema(connectionString: string, schemaName: string): Promise<void> {
  validateSchemaName(schemaName);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  } finally {
    await client.end();
  }
}

export async function dropPostgresSchema(connectionString: string, schemaName: string): Promise<void> {
  validateSchemaName(schemaName);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await client.end();
  }
}
