#!/usr/bin/env node
/**
 * 用 .env 的 DATABASE_URL 执行 SQL（文件或 stdin / -e 表达式）。
 *
 * 用法:
 *   node scripts/run-sql.js path/to/migration.sql
 *   node scripts/run-sql.js -e "select 1"
 *   cat migration.sql | node scripts/run-sql.js -
 *
 * 依赖: pg（devDependency）。无则: npm i -D pg
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/run-sql.js <file.sql | - | -e "sql">');
  process.exit(2);
}

let sql = '';
if (args[0] === '-e') {
  sql = args.slice(1).join(' ');
} else if (args[0] === '-') {
  sql = fs.readFileSync(0, 'utf8');
} else {
  sql = fs.readFileSync(path.resolve(args[0]), 'utf8');
}

if (!sql.trim()) {
  console.error('empty SQL');
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in env');
  process.exit(1);
}

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('Need package "pg". Run: npm i -D pg');
  process.exit(1);
}

const client = new pg.default.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const res = await client.query(sql);
  // 多语句时 pg 返回数组
  const results = Array.isArray(res) ? res : [res];
  for (const r of results) {
    if (r.command) console.log(`${r.command} ok` + (r.rowCount != null ? ` (rowCount=${r.rowCount})` : ''));
    if (r.rows?.length && r.fields?.length) {
      console.table(r.rows.slice(0, 50));
    }
  }
  console.log('SQL applied.');
} finally {
  await client.end();
}
