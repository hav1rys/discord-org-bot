// Уведомления для «колокольчика» на сайте. Пишутся ботом на ключевых
// событиях; читаются web.js. Отдельный модуль, чтобы и бот, и сайт могли
// звать notify() без циклических зависимостей.
const db = require('./db');

// Типы, которые участник может отключить в настройках колокольчика.
async function isMuted(discordId, kind) {
  if (!kind) return false;
  try {
    const r = await db.get('SELECT muted FROM notif_prefs WHERE discord_id = ?', [String(discordId)]);
    if (!r || !r.muted) return false;
    return r.muted.split(',').map((s) => s.trim()).includes(kind);
  } catch (_) { return false; }
}

async function notify(discordId, kind, text, link) {
  if (!discordId || !text) return;
  if (await isMuted(discordId, kind)) return;
  try {
    await db.run(
      'INSERT INTO notifications (discord_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)',
      [String(discordId), kind || 'info', String(text).slice(0, 500), link || null, new Date().toISOString()],
    );
  } catch (e) {
    console.error('[notify] не удалось записать уведомление:', e.message);
  }
}

async function unreadCount(discordId) {
  try {
    const now = new Date().toISOString();
    const r = await db.get(
      'SELECT COUNT(*) c FROM notifications WHERE discord_id = ? AND read_at IS NULL AND (snooze_until IS NULL OR snooze_until <= ?)',
      [String(discordId), now],
    );
    return r ? r.c : 0;
  } catch (_) { return 0; }
}

module.exports = { notify, unreadCount, isMuted };
