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
  const now = new Date().toISOString();
  try {
    // Группировка: если по тому же адресу/типу уже есть непрочитанное
    // уведомление за последние 6 часов — обновляем его, а не плодим новые.
    if (link) {
      const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const dup = await db.get(
        'SELECT id FROM notifications WHERE discord_id = ? AND kind = ? AND link = ? AND read_at IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 1',
        [String(discordId), kind || 'info', link, since],
      );
      if (dup) {
        await db.run('UPDATE notifications SET text = ?, created_at = ? WHERE id = ?', [String(text).slice(0, 500), now, dup.id]);
        invalidateUnread(discordId);
        return;
      }
    }
    await db.run(
      'INSERT INTO notifications (discord_id, kind, text, link, created_at) VALUES (?, ?, ?, ?, ?)',
      [String(discordId), kind || 'info', String(text).slice(0, 500), link || null, now],
    );
    invalidateUnread(discordId);
  } catch (e) {
    console.error('[notify] не удалось записать уведомление:', e.message);
  }
}

// Короткий кэш счётчика непрочитанных — вызывается на КАЖДОЙ странице сайта.
// 8 сек лага у «колокольчика» не важны, а запрос экономится.
const _ucCache = new Map(); // discordId -> { at, n }
function invalidateUnread(discordId) { _ucCache.delete(String(discordId)); }

async function unreadCount(discordId) {
  const key = String(discordId);
  const hit = _ucCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.n;
  try {
    const now = new Date().toISOString();
    const r = await db.get(
      'SELECT COUNT(*) c FROM notifications WHERE discord_id = ? AND read_at IS NULL AND (snooze_until IS NULL OR snooze_until <= ?)',
      [key, now],
    );
    const n = r ? r.c : 0;
    _ucCache.set(key, { at: Date.now(), n });
    if (_ucCache.size > 3000) _ucCache.clear();
    return n;
  } catch (_) { return 0; }
}

module.exports = { notify, unreadCount, isMuted, invalidateUnread };
