// Уведомления для «колокольчика» на сайте. Пишутся ботом на ключевых
// событиях; читаются web.js. Отдельный модуль, чтобы и бот, и сайт могли
// звать notify() без циклических зависимостей.
const db = require('./db');

async function notify(discordId, kind, text, link) {
  if (!discordId || !text) return;
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
    const r = await db.get('SELECT COUNT(*) c FROM notifications WHERE discord_id = ? AND read_at IS NULL', [String(discordId)]);
    return r ? r.c : 0;
  } catch (_) { return 0; }
}

module.exports = { notify, unreadCount };
