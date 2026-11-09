import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import Redis from 'ioredis';

const { Pool } = pg;
const STORAGE_KEY = 'connections.v1';
const pools = new Map();
const mssqlPools = new Map();
const redisClients = new Map();
const SQLITE_LIMIT = 500;

function safeError(error) {
  return String(error?.message || error || 'Unknown error').replace(/(password|pwd)=([^\s;]+)/ig, '$1=••••');
}
function jsonSafe(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}
function handle(orca, name, fn) {
  orca.panels.handle(name, async (input) => jsonSafe(await fn(input)));
}
function assertText(value, field, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${field}`);
  return value.trim();
}
function normalizeConnection(input) {
  const type = assertText(input.type, 'database type', 32).toLowerCase();
  if (!['postgres', 'mysql', 'mssql', 'sqlite', 'redis'].includes(type)) throw new Error('Unsupported database type');
  const name = assertText(input.name, 'connection name', 80);
  const id = input.id || crypto.randomUUID();
  const result = { id, type, name, createdAt: input.createdAt || new Date().toISOString() };
  if (type === 'sqlite') {
    result.filePath = assertText(input.filePath, 'SQLite file path', 2048);
  } else {
    result.host = assertText(input.host || '127.0.0.1', 'host', 255);
    result.port = Number(input.port || (type === 'postgres' ? 5432 : type === 'mssql' ? 1433 : type === 'redis' ? 6379 : 3306));
    if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('Invalid port');
    result.database = String(input.database || (type === 'redis' ? '0' : '')).slice(0, 128);
    result.username = String(input.username || '').slice(0, 128);
    result.ssl = Boolean(input.ssl);
  }
  return result;
}
async function readConnections(orca) {
  return (await orca.storage.get(STORAGE_KEY)) || [];
}
async function saveConnections(orca, items) {
  await orca.storage.set(STORAGE_KEY, items);
}
async function getPassword(orca, id) {
  return (await orca.secrets.get(`password:${id}`)) || '';
}
async function closeClient(id) {
  const pool = pools.get(id);
  if (pool) { await pool.end().catch(() => {}); pools.delete(id); }
  const mssqlPool = mssqlPools.get(id);
  if (mssqlPool) { await mssqlPool.close().catch(() => {}); mssqlPools.delete(id); }
  const redis = redisClients.get(id);
  if (redis) { redis.disconnect(); redisClients.delete(id); }
}
async function getPg(orca, c) {
  if (!pools.has(c.id)) {
    const password = await getPassword(orca, c.id);
    pools.set(c.id, new Pool({
      host: c.host, port: c.port, database: c.database || 'postgres',
      user: c.username, password, ssl: c.ssl ? { rejectUnauthorized: true } : false,
      max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000,
      statement_timeout: 30000
    }));
  }
  return pools.get(c.id);
}
async function getMysql(orca, c) {
  const password = await getPassword(orca, c.id);
  return mysql.createConnection({
    host: c.host, port: c.port, database: c.database || undefined,
    user: c.username, password, ssl: c.ssl ? {} : undefined,
    connectTimeout: 8000, decimalNumbers: false, dateStrings: true,
    enableKeepAlive: true
  });
}
async function getMssql(orca, c) {
  if (!mssqlPools.has(c.id)) {
    const password = await getPassword(orca, c.id);
    const pool = new mssql.ConnectionPool({
      server: c.host, port: c.port, database: c.database || undefined,
      user: c.username || undefined, password: password || undefined,
      options: { encrypt: Boolean(c.ssl), trustServerCertificate: !c.ssl, enableArithAbort: true },
      pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 8000, requestTimeout: 30000
    });
    pool.on('error', () => {});
    await pool.connect();
    mssqlPools.set(c.id, pool);
  }
  return mssqlPools.get(c.id);
}
async function getRedis(orca, c) {
  if (!redisClients.has(c.id)) {
    const password = await getPassword(orca, c.id);
    const client = new Redis({
      host: c.host, port: c.port, password: password || undefined, username: c.username || undefined,
      db: Math.max(0, Number(c.database || 0)),
      lazyConnect: true, connectTimeout: 8000, maxRetriesPerRequest: 1,
      retryStrategy: () => null, tls: c.ssl ? {} : undefined
    });
    await client.connect();
    redisClients.set(c.id, client);
  }
  const client = redisClients.get(c.id);
  if (client.status === 'end') await client.connect();
  return client;
}
async function getSqlite(c, readOnly = false) {
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite?.DatabaseSync) throw new Error('SQLite requiere una versión de Node.js con node:sqlite (Node 22.5+).');
  return new sqlite.DatabaseSync(c.filePath, { readOnly, enableForeignKeyConstraints: true, timeout: 5000 });
}
function rowsResult(rows, fields = []) {
  return { rows: rows.slice(0, 500), fields, rowCount: rows.length, truncated: rows.length > 500 };
}
async function querySql(orca, c, sql) {
  assertText(sql, 'SQL query', 100000);
  if (c.type === 'postgres') {
    const result = await (await getPg(orca, c)).query({ text: sql, rowMode: 'object' });
    return { rows: result.rows.slice(0, 500), fields: (result.fields || []).map(f => f.name), rowCount: Number(result.rowCount || result.rows.length), truncated: result.rows.length > 500, command: result.command };
  }
  if (c.type === 'mysql') {
    const db = await getMysql(orca, c);
    try {
      const [result] = await db.query(sql);
      if (Array.isArray(result)) return { rows: result.slice(0, 500), fields: Object.keys(result[0] || {}), rowCount: result.length, truncated: result.length > 500 };
      return { rows: [], fields: [], rowCount: result.affectedRows ?? 0, insertId: result.insertId, warningStatus: result.warningStatus };
    } finally { await db.end(); }
  }
  if (c.type === 'mssql') {
    const pool = await getMssql(orca, c);
    const result = await pool.request().query(sql);
    const recordset = result.recordset || [];
    const rows = Array.from(recordset);
    const fields = Object.keys(recordset.columns || {});
    const affected = Array.isArray(result.rowsAffected) ? result.rowsAffected.reduce((sum, n) => sum + Number(n || 0), 0) : 0;
    return { rows: rows.slice(0, 500), fields, rowCount: rows.length || affected, truncated: rows.length > 500 };
  }
  if (c.type === 'sqlite') {
    const db = await getSqlite(c);
    try {
      const statement = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql)) {
        const rows = statement.all();
        return { rows: rows.slice(0, SQLITE_LIMIT), fields: Object.keys(rows[0] || {}), rowCount: rows.length, truncated: rows.length > SQLITE_LIMIT };
      }
      const result = statement.run();
      return { rows: [], fields: [], rowCount: Number(result.changes || 0), lastInsertRowid: String(result.lastInsertRowid ?? '') };
    } finally { db.close(); }
  }
  throw new Error('Use the Redis command console for Redis connections.');
}
async function listTree(orca, c) {
  if (c.type === 'postgres') {
    const result = await (await getPg(orca, c)).query(`SELECT current_database() AS db_name, table_schema AS schema, table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name`);
    return result.rows;
  }
  if (c.type === 'mysql') {
    const db = await getMysql(orca, c);
    try {
      const [rows] = c.database
        ? await db.query(`SELECT table_schema AS db_name, table_schema AS schema_name, table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [c.database])
        : await db.query(`SELECT table_schema AS db_name, table_schema AS schema_name, table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY table_schema, table_name`);
      return rows;
    } finally { await db.end(); }
  }
  if (c.type === 'mssql') {
    const pool = await getMssql(orca, c);
    const result = await pool.request().query(`SELECT TABLE_CATALOG AS db_name, TABLE_SCHEMA AS schema_name, TABLE_NAME AS name, TABLE_TYPE AS kind FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME`);
    return result.recordset || [];
  }
  if (c.type === 'sqlite') {
    const db = await getSqlite(c, true);
    try { return db.prepare("SELECT 'main' AS db_name, name, type AS kind FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all(); }
    finally { db.close(); }
  }
  if (c.type === 'redis') {
    const redis = await getRedis(orca, c);
    return [{ name: 'Keyspace', kind: 'redis' }, { name: 'DB ' + (c.database || '0'), kind: 'database' }];
  }
  return [];
}
async function redisCommand(orca, c, args) {
  if (!Array.isArray(args) || !args.length || args.length > 100) throw new Error('Invalid Redis command');
  const safeArgs = args.map(v => String(v).slice(0, 10000));
  const redis = await getRedis(orca, c);
  const result = await redis.call(...safeArgs);
  return { result: result === null ? null : result, type: Array.isArray(result) ? 'array' : typeof result };
}

export default async function activate(orca) {
  handle(orca, 'connections.list', async () => (await readConnections(orca)).map(({ id, type, name, host, port, database, username, filePath, ssl }) => ({ id, type, name, host, port, database, username, filePath, ssl })));
  handle(orca, 'connections.save', async (input) => {
    const c = normalizeConnection(input);
    if (typeof input.password === 'string' && input.password.length) {
      if (typeof orca.secrets.protection === 'function') {
        const protection = await orca.secrets.protection();
        const status = typeof protection === 'string' ? protection : protection?.status;
        if (status !== 'os-keyring') throw new Error('Orca no tiene un almacén seguro del sistema disponible; no se guardó la contraseña.');
      }
      try {
        await orca.secrets.set(`password:${c.id}`, input.password);
      } catch (error) {
        throw new Error(`No se pudo guardar la contraseña de forma segura: ${safeError(error)}`);
      }
    }
    const items = await readConnections(orca);
    const index = items.findIndex(x => x.id === c.id);
    if (index >= 0) items[index] = { ...c, createdAt: items[index].createdAt }; else items.push(c);
    await saveConnections(orca, items);
    await closeClient(c.id);
    return { id: c.id };
  });
  handle(orca, 'connections.delete', async ({ id }) => {
    const items = await readConnections(orca);
    await saveConnections(orca, items.filter(x => x.id !== id));
    await orca.secrets.delete(`password:${id}`).catch(() => {});
    await closeClient(id);
    return { deleted: true };
  });
  handle(orca, 'connections.test', async ({ id }) => {
    const c = (await readConnections(orca)).find(x => x.id === id);
    if (!c) throw new Error('Connection not found');
    if (c.type === 'postgres') { await (await getPg(orca, c)).query('SELECT 1'); }
    else if (c.type === 'mysql') { const db = await getMysql(orca, c); try { await db.query('SELECT 1'); } finally { await db.end(); } }
    else if (c.type === 'mssql') { await (await getMssql(orca, c)).request().query('SELECT 1'); }
    else if (c.type === 'sqlite') { const db = await getSqlite(c, true); try { db.prepare('SELECT 1').get(); } finally { db.close(); } }
    else { await (await getRedis(orca, c)).ping(); }
    return { ok: true, message: 'Connection successful' };
  });
  handle(orca, 'database.tree', async ({ id }) => {
    const c = (await readConnections(orca)).find(x => x.id === id);
    if (!c) throw new Error('Connection not found');
    return await listTree(orca, c);
  });
  handle(orca, 'database.query', async ({ id, sql }) => {
    const c = (await readConnections(orca)).find(x => x.id === id);
    if (!c) throw new Error('Connection not found');
    return await querySql(orca, c, sql);
  });
  handle(orca, 'redis.command', async ({ id, command }) => {
    const c = (await readConnections(orca)).find(x => x.id === id);
    if (!c || c.type !== 'redis') throw new Error('Select a Redis connection');
    const parts = String(command || '').trim().match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) || [];
    return await redisCommand(orca, c, parts.map(p => p.replace(/^['"]|['"]$/g, '')));
  });
  handle(orca, 'connections.closeAll', async () => {
    await Promise.all([...pools.keys(), ...mssqlPools.keys(), ...redisClients.keys()].map(closeClient));
    return { ok: true };
  });

  orca.log('Ork DBclient worker ready.');
}

export async function deactivate() {
  await Promise.all([...pools.values()].map(pool => pool.end().catch(() => {})));
  pools.clear();
  await Promise.all([...mssqlPools.values()].map(pool => pool.close().catch(() => {})));
  mssqlPools.clear();
  for (const client of redisClients.values()) client.disconnect();
  redisClients.clear();
}
