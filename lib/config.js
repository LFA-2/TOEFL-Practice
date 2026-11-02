// Loads .env (if present) and exposes typed config.

// node:sqlite prints an "experimental" warning on every start; it's stable enough for us.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/.test(String(w?.message ?? w)) ? undefined : emitWarning.call(process, w, ...rest));

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'toefl.db'),
  password: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  aiMock: process.env.AI_MOCK === '1',
};

module.exports = config;
