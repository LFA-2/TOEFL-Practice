// SQLite storage using Node's built-in node:sqlite (Node >= 22.13).
const config = require('./config'); // first: installs the warning filter
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL,
  difficulty  REAL NOT NULL,          -- on the 1-6 band scale
  content     TEXT NOT NULL,          -- JSON, shape depends on type
  source      TEXT NOT NULL DEFAULT 'ai',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(type, difficulty);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  type        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'practice',   -- practice | diagnostic
  response    TEXT NOT NULL,                      -- JSON
  score       REAL NOT NULL,                      -- normalised 0..1
  raw_score   REAL,
  max_score   REAL,
  feedback    TEXT,                               -- JSON
  seconds     INTEGER,
  day         TEXT NOT NULL,                      -- local date YYYY-MM-DD
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_day ON attempts(day);
CREATE INDEX IF NOT EXISTS idx_attempts_item ON attempts(item_id);

CREATE TABLE IF NOT EXISTS skills (
  type        TEXT PRIMARY KEY,
  rating      REAL NOT NULL,
  n           INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_history (
  id      INTEGER PRIMARY KEY,
  type    TEXT NOT NULL,
  rating  REAL NOT NULL,
  day     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  day    TEXT PRIMARY KEY,
  tasks  TEXT NOT NULL                -- JSON [{type, target, minutes}]
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, getSetting, setSetting, tx };
