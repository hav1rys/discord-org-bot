// Достижения (бейджи) участника. Общий модуль для сайта (показ на профиле)
// и бота (авто-роли). Логика намеренно лёгкая: compute() делает 4 запроса
// параллельно + считает стрик в памяти, результат кэшируется на 60 сек.
const db = require('./db');
const config = require('./config');
const contracts = require('./contracts');

const LABELS = {
  contracts10: '📄 10 контрактов',
  contracts50: '📚 50 контрактов',
  contracts100: '🏆 100 контрактов',
  invites5: '🤝 5 приглашений',
  invites15: '👑 15 приглашений',
  month: '🎖️ месяц в организации',
  veteran90: '🛡️ ветеран 90 дней',
  year1: '🎂 год в организации',
  winner: '🎉 победитель розыгрыша',
  winner3: '🍀 ×3 победитель розыгрыша',
  streak2: '🔥 стрик 2+ недели',
  streak4: '🔥 стрик 4+ недели',
};

const ROLE_META = {
  contracts10: { name: '📄 10 контрактов', color: 0x5865f2 },
  contracts50: { name: '📚 50 контрактов', color: 0x3ba55d },
  contracts100: { name: '🏆 100 контрактов', color: 0xf1c40f },
  invites5: { name: '🤝 5 приглашений', color: 0x5865f2 },
  invites15: { name: '👑 15 приглашений', color: 0xe67e22 },
  month: { name: '🎖️ Месяц в организации', color: 0x95a5a6 },
  veteran90: { name: '🛡️ Ветеран 90 дней', color: 0x2c3e50 },
  year1: { name: '🎂 Год в организации', color: 0xe91e63 },
  winner: { name: '🎉 Победитель розыгрыша', color: 0x9b59b6 },
  winner3: { name: '🍀 ×3 победитель розыгрыша', color: 0x1abc9c },
  streak2: { name: '🔥 Стрик 2+ недели', color: 0xe74c3c },
  streak4: { name: '🔥 Стрик 4+ недели', color: 0xc0392b },
};

// ---------- кэш расчёта (60 сек) ----------
const _cache = new Map(); // discordId -> { at, data }
const CACHE_MS = 60000;
function invalidate(discordId) { _cache.delete(discordId); }

async function compute(discordId) {
  const hit = _cache.get(discordId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const now = Date.now();
  const [p, fulRows, invRow, winRows] = await Promise.all([
    db.get('SELECT joined_at FROM participants WHERE discord_id = ?', [discordId]).catch(() => null),
    db.all("SELECT submitted_at FROM contracts WHERE discord_id = ? AND status = 'fulfilled'", [discordId]).catch(() => []),
    db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status = 'confirmed'", [discordId]).catch(() => null),
    db.all("SELECT winners FROM giveaways WHERE status = 'ended' AND winners LIKE ?", [`%${discordId}%`]).catch(() => []),
  ]);

  const fulfilled = fulRows.length;
  const invConfirmed = invRow ? invRow.c : 0;
  const wins = winRows.filter((r) => (r.winners || '').split(',').includes(discordId)).length;
  const days = p && p.joined_at ? Math.floor((now - new Date(p.joined_at)) / 864e5) : 0;

  // Стрик: раскладываем выполненные контракты по 26 календарным неделям
  // в памяти (одна выборка выше), без 26 отдельных запросов.
  const norm = config.WEEKLY_PROMOTION_CONTRACT_THRESHOLD || 3;
  const ranges = [];
  for (let w = 0; w < 26; w++) {
    const r = contracts.getWeekRange(w);
    ranges.push([r.start.getTime(), r.end.getTime()]);
  }
  const oldest = ranges[25][0];
  const perWeek = new Array(26).fill(0);
  for (const row of fulRows) {
    if (!row.submitted_at) continue;
    const t = new Date(row.submitted_at).getTime();
    if (t < oldest || t > ranges[0][1]) continue;
    for (let w = 0; w < 26; w++) {
      if (t >= ranges[w][0] && t <= ranges[w][1]) { perWeek[w]++; break; }
    }
  }
  let streak = 0;
  for (let w = 0; w < 26; w++) { if (perWeek[w] >= norm) streak++; else break; }

  const has = {
    contracts10: fulfilled >= 10,
    contracts50: fulfilled >= 50,
    contracts100: fulfilled >= 100,
    invites5: invConfirmed >= 5,
    invites15: invConfirmed >= 15,
    month: days >= 30,
    veteran90: days >= 90,
    year1: days >= 365,
    winner: wins >= 1,
    winner3: wins >= 3,
    streak2: streak >= 2,
    streak4: streak >= 4,
  };
  const badges = Object.keys(has).filter((k) => has[k]).map((k) => LABELS[k]);

  // Фиксируем момент первого получения каждого бейджа (дата приблизительная —
  // когда compute впервые увидел бейдж заработанным), отдаём карту awardedAt.
  const awardedAt = {};
  try {
    const rows = await db.all('SELECT badge_key, awarded_at FROM badge_awards WHERE discord_id = ?', [discordId]);
    for (const r of rows) awardedAt[r.badge_key] = r.awarded_at;
    const nowIso = new Date().toISOString();
    for (const k of Object.keys(has)) {
      if (has[k] && !awardedAt[k]) {
        awardedAt[k] = nowIso;
        await db.run('INSERT INTO badge_awards (discord_id, badge_key, awarded_at) VALUES (?, ?, ?)', [discordId, k, nowIso]).catch(() => {});
      }
    }
  } catch (_) { /* таблицы может не быть при первом запуске — не критично */ }

  const data = { has, badges, LABELS, awardedAt, streak, fulfilled, wins, invConfirmed, days };
  _cache.set(discordId, { at: now, data });
  return data;
}

// ---------- авто-роли ----------
let _warned = false;

// Карта badge_key -> role_id: ручные переопределения + сохранённые в БД
// (только те роли, что ещё существуют на сервере). Одна выборка на весь проход.
async function loadRoleMap(guild) {
  const map = {};
  for (const [k, v] of Object.entries(config.BADGE_ROLES || {})) if (v) map[k] = v;
  const rows = await db.all('SELECT badge_key, role_id FROM badge_roles').catch(() => []);
  for (const r of rows) {
    if (!map[r.badge_key] && r.role_id && guild.roles.cache.has(r.role_id)) map[r.badge_key] = r.role_id;
  }
  return map;
}

// Создаёт роль под бейдж (лениво) и запоминает id.
async function ensureRole(guild, key, roleMap) {
  if (roleMap && roleMap[key]) return roleMap[key];
  const meta = ROLE_META[key] || { name: LABELS[key] || key, color: 0x99aab5 };
  try {
    const role = await guild.roles.create({
      name: meta.name, color: meta.color, hoist: false, mentionable: false,
      reason: 'Авто-роль за достижение (бейдж)',
    });
    await db.run(
      `INSERT INTO badge_roles (badge_key, role_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(badge_key) DO UPDATE SET role_id = excluded.role_id, created_at = excluded.created_at`,
      [key, role.id, new Date().toISOString()],
    );
    if (roleMap) roleMap[key] = role.id;
    console.log(`[badges] Создана роль за бейдж «${key}»: ${role.name} (${role.id})`);
    return role.id;
  } catch (err) {
    if (!_warned) {
      console.error('[badges] Не удалось создать роль за бейдж — нужно право бота «Управление ролями»:', err.message);
      _warned = true;
    }
    return null;
  }
}

// Приводит роли одного участника в соответствие его бейджам. roleMap
// (из loadRoleMap) передаётся при массовом проходе, чтобы не читать БД на
// каждый бейдж; при одиночном вызове строится сам.
async function syncRoles(guild, discordId, roleMap) {
  if (config.BADGE_AUTO_ROLES === false) return;
  const member = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const rm = roleMap || (await loadRoleMap(guild));
  const { has } = await compute(discordId);
  for (const key of Object.keys(ROLE_META)) {
    if (has[key]) {
      const roleId = rm[key] || (await ensureRole(guild, key, rm));
      if (roleId && !member.roles.cache.has(roleId)) await member.roles.add(roleId).catch(() => {});
    } else {
      const roleId = rm[key];
      if (roleId && member.roles.cache.has(roleId)) await member.roles.remove(roleId).catch(() => {});
    }
  }
}

async function syncAllRoles(guild) {
  if (config.BADGE_AUTO_ROLES === false) return;
  const rows = await db.all('SELECT discord_id FROM participants').catch(() => []);
  const roleMap = await loadRoleMap(guild);
  let i = 0;
  for (const r of rows) {
    await syncRoles(guild, r.discord_id, roleMap);
    // уступаем событийный цикл каждые 15 участников, без таймерных пауз —
    // discord.js сам очередит запросы к API и соблюдёт rate limit.
    if (++i % 15 === 0) await new Promise((res) => setImmediate(res));
  }
}

module.exports = { compute, invalidate, syncRoles, syncAllRoles, ensureRole, loadRoleMap, LABELS, ROLE_META };
