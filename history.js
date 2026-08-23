const db = require('./db');

async function logJoined(discordId, staticValue, name, note = '', atOverride = null) {
  await db.run(
    'INSERT INTO membership_events (discord_id, static, name, event, note, at) VALUES (?, ?, ?, ?, ?, ?)',
    [discordId, staticValue, name, 'joined', note, atOverride || new Date().toISOString()],
  );
}

async function logLeft(discordId, staticValue, name, note = '', atOverride = null) {
  await db.run(
    'INSERT INTO membership_events (discord_id, static, name, event, note, at) VALUES (?, ?, ?, ?, ?, ?)',
    [discordId, staticValue, name, 'left', note, atOverride || new Date().toISOString()],
  );
}

// Последнее событие "вступил" для конкретного паспорта (или null)
async function getLastJoined(discordId, staticValue) {
  return db.get(
    `SELECT * FROM membership_events WHERE discord_id = ? AND static = ? AND event = 'joined' ORDER BY id DESC LIMIT 1`,
    [discordId, staticValue],
  );
}

// Вся история конкретного Discord ID (все паспорта, вступления/выходы)
async function getHistory(discordId) {
  return db.all('SELECT * FROM membership_events WHERE discord_id = ? ORDER BY at ASC', [discordId]);
}

module.exports = { logJoined, logLeft, getLastJoined, getHistory };
