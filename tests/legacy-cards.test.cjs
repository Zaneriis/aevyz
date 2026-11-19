const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('les collections stockées en liste d\'ids sont converties au démarrage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aevyz-legacy-'));
  const old = new DatabaseSync(path.join(dir, 'aevyz.db'));
  old.exec(`CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, active_at INTEGER, wishes TEXT, read_at INTEGER, cards TEXT);
    INSERT INTO players (id, cards) VALUES ('ancien', '["c1","c2"]'), ('vide', '[]'), ('neuf', '{"c3":2}'), ('prive', NULL);`);
  old.close();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PASSWORD: 'x', PORT: '18790', DATA_DIR: dir, AEVYZ_ORIGIN: 'http://127.0.0.1:9', STATS_READS: '0' } });
  try {
    for (let i = 0; i < 100 && !(await fetch('http://127.0.0.1:18790/').then(() => true, () => false)); i++) await new Promise(r => setTimeout(r, 50));
    const db = new DatabaseSync(path.join(dir, 'aevyz.db'), { readOnly: true }); // serveur démarré = migration faite
    const cards = Object.fromEntries(db.prepare('SELECT id, cards FROM players').all().map(r => [r.id, r.cards && JSON.parse(r.cards)]));
    db.close();
    assert.deepEqual(cards, { ancien: { c1: 1, c2: 1 }, vide: {}, neuf: { c3: 2 }, prive: null });
  } finally { app.kill(); }
});
