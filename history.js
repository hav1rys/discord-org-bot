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

// Отпуск/AFK — выдача и снятие (п. "История AFK" / "История отпусков от руководства")
async function logStatusGranted(type, discordId, staticValue, name, reason, until, actorId) {
  await db.run(
    'INSERT INTO status_events (discord_id, static, name, type, action, reason, until, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [discordId, staticValue, name, type, 'granted', reason || '', until || null, actorId, new Date().toISOString()],
  );
}

async function logStatusRevoked(type, discordId, staticValue, name, actorId) {
  await db.run(
    'INSERT INTO status_events (discord_id, static, name, type, action, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [discordId, staticValue, name, type, 'revoked', actorId, new Date().toISOString()],
  );
}

async function getStatusHistory(discordId, type) {
  return db.all('SELECT * FROM status_events WHERE discord_id = ? AND type = ? ORDER BY at DESC LIMIT 10', [discordId, type]);
}

module.exports = { logJoined, logLeft, getLastJoined, getHistory, logStatusGranted, logStatusRevoked, getStatusHistory };
