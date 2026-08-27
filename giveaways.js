const db = require('./db');

const WEEKDAY_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// "30m", "2h", "1d", "1w" и т.д. -> миллисекунды, либо null при неверном формате
function parseDuration(input) {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec((input || '').trim());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };
  return amount * multipliers[unit];
}

async function createGiveaway(channelId, prize, winnersCount, hostId, endsAtIso, requiredRoleId = null, recurringRuleId = null) {
  const result = await db.run(
    `INSERT INTO giveaways (channel_id, message_id, prize, winners_count, host_id, ends_at, status, required_role_id, recurring_rule_id, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [channelId, prize, winnersCount, hostId, endsAtIso, requiredRoleId, recurringRuleId, new Date().toISOString()],
  );
  return result.lastID;
}

async function setMessageId(giveawayId, messageId) {
  await db.run('UPDATE giveaways SET message_id = ? WHERE id = ?', [messageId, giveawayId]);
}

async function getGiveaway(id) {
  return db.get('SELECT * FROM giveaways WHERE id = ?', [id]);
}

async function getActiveExpired() {
  return db.all(`SELECT * FROM giveaways WHERE status = 'active' AND ends_at <= ?`, [new Date().toISOString()]);
}

async function setStatus(id, status) {
  await db.run('UPDATE giveaways SET status = ? WHERE id = ?', [status, id]);
}

async function addEntry(giveawayId, discordId) {
  await db.run('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, discord_id) VALUES (?, ?)', [giveawayId, discordId]);
}

async function removeEntry(giveawayId, discordId) {
  await db.run('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND discord_id = ?', [giveawayId, discordId]);
}

async function hasEntry(giveawayId, discordId) {
  return !!(await db.get('SELECT id FROM giveaway_entries WHERE giveaway_id = ? AND discord_id = ?', [giveawayId, discordId]));
}

async function getEntries(giveawayId) {
  const rows = await db.all('SELECT discord_id FROM giveaway_entries WHERE giveaway_id = ?', [giveawayId]);
  return rows.map((r) => r.discord_id);
}

async function countEntries(giveawayId) {
  const row = await db.get('SELECT COUNT(*) as cnt FROM giveaway_entries WHERE giveaway_id = ?', [giveawayId]);
  return row ? row.cnt : 0;
}

// Случайные победители без повторов
function pickWinners(entries, count) {
  const pool = [...entries];
  const winners = [];
  while (winners.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}

// ---------- Повторяющиеся розыгрыши ----------

async function createRecurringRule(channelId, prize, winnersCount, durationMs, weekday, hostId, requiredRoleId = null) {
  const result = await db.run(
    `INSERT INTO giveaway_recurring_rules (channel_id, prize, winners_count, duration_ms, weekday, required_role_id, host_id, status, last_run_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
    [channelId, prize, winnersCount, durationMs, weekday, requiredRoleId, hostId, new Date().toISOString()],
  );
  return result.lastID;
}

async function getRecurringRule(id) {
  return db.get('SELECT * FROM giveaway_recurring_rules WHERE id = ?', [id]);
}

async function getActiveRecurringRules() {
  return db.all(`SELECT * FROM giveaway_recurring_rules WHERE status = 'active'`);
}

async function setRecurringRuleLastRun(id, dateStr) {
  await db.run('UPDATE giveaway_recurring_rules SET last_run_date = ? WHERE id = ?', [dateStr, id]);
}

async function setRecurringRuleStatus(id, status) {
  await db.run('UPDATE giveaway_recurring_rules SET status = ? WHERE id = ?', [status, id]);
}

module.exports = {
  WEEKDAY_NAMES,
  parseDuration,
  createGiveaway,
  setMessageId,
  getGiveaway,
  getActiveExpired,
  setStatus,
  addEntry,
  removeEntry,
  hasEntry,
  getEntries,
  countEntries,
  pickWinners,
  createRecurringRule,
  getRecurringRule,
  getActiveRecurringRules,
  setRecurringRuleLastRun,
  setRecurringRuleStatus,
};
