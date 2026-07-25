const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE,
    discord_tag TEXT,
    name TEXT,
    static TEXT UNIQUE,
    lvl INTEGER,
    skills TEXT,
    online TEXT,
    role_id TEXT,
    joined_at TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    discord_tag TEXT,
    name TEXT,
    static TEXT,
    lvl INTEGER,
    skills TEXT,
    online TEXT,
    status TEXT DEFAULT 'pending',
    message_id TEXT,
    created_at TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS kicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    discord_tag TEXT,
    name TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    message_id TEXT,
    created_at TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS extra_passports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    name TEXT,
    static TEXT UNIQUE,
    position INTEGER,
    created_at TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS vacations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    discord_tag TEXT,
    until TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    message_id TEXT,
    created_at TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    discord_tag TEXT,
    static TEXT,
    reason TEXT,
    added_by TEXT,
    created_at TEXT
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_participants_discord_id ON participants(discord_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_participants_static ON participants(static)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_kicks_status ON kicks(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_extra_passports_discord_id ON extra_passports(discord_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_vacations_status ON vacations(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_blacklist_discord_id ON blacklist(discord_id)`);

  // Миграция: если data.db был создан более старой версией схемы (без
  // столбца role_id), CREATE TABLE IF NOT EXISTS его не добавит — добавляем
  // вручную, чтобы не терять уже накопленные данные.
  await migrateColumn('participants', 'role_id', 'TEXT');
  await migrateColumn('participants', 'vacation_until', 'TEXT');
  await migrateColumn('participants', 'afk_since', 'TEXT');
}

async function migrateColumn(table, column, type) {
  const columns = await all(`PRAGMA table_info(${table})`);
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`Миграция: добавлен столбец ${column} в таблицу ${table}`);
  }
}

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

module.exports = { db, run, get, all, init, getSetting, setSetting };