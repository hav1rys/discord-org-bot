// Уведомления: «колокольчик» на сайте и (по желанию участника) ЛС в Discord.
// Пишутся ботом и сайтом на ключевых событиях; читаются web.js. Отдельный модуль,
// чтобы и бот, и сайт могли звать notify() без циклических зависимостей.
const db = require('./db');

// Типы уведомлений (единый список для сайта и команды /уведомления в Discord).
const KINDS = [
  ['ticket', 'Тикеты'], ['giveaway', 'Розыгрыши'], ['vacation', 'Отпуска'],
  ['apply', 'Заявки'], ['passport', 'Паспорта'], ['appeal', 'Апелляции'],
  ['kick', 'Увольнения'], ['contract', 'Контракты'],
  ['thanks', 'Благодарности'], ['guestbook', 'Гостевая книга'],
  ['security', 'Безопасность (входы)'], ['info', 'Прочее'],
];
const KIND_ICONS = {
  ticket: '🎫', kick: '⚠️', passport: '🪪', appeal: '⚖️', vacation: '🏖️', giveaway: '🎉', apply: '📩',
  contract: '📄', data_change: '✏️', thanks: '🙏', guestbook: '✍️', security: '🔐', info: '🔔',
};

const csv = (v) => new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean));

// Настройки участника. Короткий кэш: notify() зовётся часто.
const _prefCache = new Map();
async function getPrefs(discordId) {
  const key = String(discordId);
  const hit = _prefCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.v;
  let row = null;
  try { row = await db.get('SELECT muted, dm_kinds, dm_off, weekly_report FROM notif_prefs WHERE discord_id = ?', [key]); } catch (_) {}
  const v = {
    muted: csv(row && row.muted),
    dmKinds: csv(row && row.dm_kinds),
    dmOff: !!(row && row.dm_off),
    weekly: !!(row && row.weekly_report),
  };
  _prefCache.set(key, { at: Date.now(), v });
  if (_prefCache.size > 3000) _prefCache.clear();
  return v;
}
async function setPrefs(discordId, { muted, dmKinds, dmOff, weekly }) {
  const cur = await getPrefs(discordId);
  const m = muted !== undefined ? [...muted] : [...cur.muted];
  const d = dmKinds !== undefined ? [...dmKinds] : [...cur.dmKinds];
  const off = dmOff !== undefined ? (dmOff ? 1 : 0) : (cur.dmOff ? 1 : 0);
  const wk = weekly !== undefined ? (weekly ? 1 : 0) : (cur.weekly ? 1 : 0);
  await db.run(
    `INSERT INTO notif_prefs (discord_id, muted, dm_kinds, dm_off, weekly_report) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET muted = excluded.muted, dm_kinds = excluded.dm_kinds, dm_off = excluded.dm_off, weekly_report = excluded.weekly_report`,
    [String(discordId), m.join(','), d.join(','), off, wk],
  );
  _prefCache.delete(String(discordId));
}

// Типы, которые участник может отключить в настройках колокольчика.
async function isMuted(discordId, kind) {
  if (!kind) return false;
  return (await getPrefs(discordId)).muted.has(kind);
}
// ЛС от бота выключены совсем (кроме принудительных — вход с нового устройства).
async function isDmOff(discordId) {
  return (await getPrefs(discordId)).dmOff;
}

// Отправка ЛС подключается ботом (index.js): у этого модуля нет доступа к Discord.
let _dmSender = null;
function setDmSender(fn) { _dmSender = fn; }
// Чтобы не дублировать: если человеку только что ушло «прямое» ЛС (по тому же событию),
// дополнительное из notify() пропускаем.
const _recentDm = new Map();
function markDirectDm(discordId) { _recentDm.set(String(discordId), Date.now()); if (_recentDm.size > 3000) _recentDm.clear(); }
function recentlyDmed(discordId) { const t = _recentDm.get(String(discordId)); return !!t && Date.now() - t < 15000; }

function siteBase() {
  const d = process.env.DOMAIN;
  return d ? `https://${d}` : `http://localhost:${process.env.PORT || 3000}`;
}

async function notify(discordId, kind, text, link) {
  if (!discordId || !text) return;
  const prefs = await getPrefs(discordId);
  const bellOn = !prefs.muted.has(kind || 'info');
  const dmOn = !prefs.dmOff && prefs.dmKinds.has(kind || 'info') && !String(discordId).startsWith('local:') && !String(discordId).startsWith('nodiscord-');
  if (!bellOn && !dmOn) return;
  const now = new Date().toISOString();
  if (dmOn && _dmSender && !recentlyDmed(discordId)) {
    const url = link ? (/^https?:/i.test(link) ? link : siteBase() + link) : '';
    const body = `${KIND_ICONS[kind] || '🔔'} ${String(text).slice(0, 1500)}${url ? `\n${url}` : ''}\n_Настроить уведомления: команда /уведомления или сайт → «Уведомления»._`;
    Promise.resolve(_dmSender(String(discordId), body)).catch(() => {});
  }
  if (!bellOn) return;
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

module.exports = { notify, unreadCount, isMuted, isDmOff, invalidateUnread, KINDS, KIND_ICONS, getPrefs, setPrefs, setDmSender, markDirectDm };
