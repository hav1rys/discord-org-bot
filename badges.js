// Достижения (бейджи) участника — считаются из БД. Используется и сайтом
// (показ на профиле), и ботом (выдача Discord-ролей по config.BADGE_ROLES).
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
  winner: '🎉 победитель розыгрыша',
  winner3: '🍀 ×3 победитель розыгрыша',
  streak2: '🔥 стрик 2+ недели',
  streak4: '🔥 стрик 4+ недели',
};

async function compute(discordId) {
  const p = await db.get('SELECT joined_at FROM participants WHERE discord_id = ?', [discordId]).catch(() => null);
  const fRow = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status = 'fulfilled'", [discordId]).catch(() => null);
  const fulfilled = fRow ? fRow.c : 0;
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status = 'confirmed'", [discordId]).catch(() => null);
  const invConfirmed = invRow ? invRow.c : 0;
  const winRows = await db.all("SELECT winners FROM giveaways WHERE status = 'ended' AND winners LIKE ?", [`%${discordId}%`]).catch(() => []);
  const wins = winRows.filter((r) => (r.winners || '').split(',').includes(discordId)).length;
  const days = p && p.joined_at ? Math.floor((Date.now() - new Date(p.joined_at)) / 864e5) : 0;

  const norm = config.WEEKLY_PROMOTION_CONTRACT_THRESHOLD || 3;
  let streak = 0;
  for (let w = 0; w < 26; w++) {
    const r = contracts.getWeekRange(w);
    const row = await db.get(
      "SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status = 'fulfilled' AND submitted_at BETWEEN ? AND ?",
      [discordId, r.start.toISOString(), r.end.toISOString()],
    ).catch(() => null);
    if ((row ? row.c : 0) >= norm) streak++;
    else break;
  }

  const has = {
    contracts10: fulfilled >= 10,
    contracts50: fulfilled >= 50,
    contracts100: fulfilled >= 100,
    invites5: invConfirmed >= 5,
    invites15: invConfirmed >= 15,
    month: days >= 30,
    veteran90: days >= 90,
    winner: wins >= 1,
    winner3: wins >= 3,
    streak2: streak >= 2,
    streak4: streak >= 4,
  };
  const badges = Object.keys(has).filter((k) => has[k]).map((k) => LABELS[k]);
  return { has, badges, LABELS, streak, fulfilled, wins, invConfirmed, days };
}

// Оформление авто-ролей за бейджи (имя + цвет). Ключи совпадают с LABELS.
const ROLE_META = {
  contracts10: { name: '📄 10 контрактов', color: 0x5865f2 },
  contracts50: { name: '📚 50 контрактов', color: 0x3ba55d },
  contracts100: { name: '🏆 100 контрактов', color: 0xf1c40f },
  invites5: { name: '🤝 5 приглашений', color: 0x5865f2 },
  invites15: { name: '👑 15 приглашений', color: 0xe67e22 },
  month: { name: '🎖️ Месяц в организации', color: 0x95a5a6 },
  veteran90: { name: '🛡️ Ветеран 90 дней', color: 0x2c3e50 },
  winner: { name: '🎉 Победитель розыгрыша', color: 0x9b59b6 },
  winner3: { name: '🍀 ×3 победитель розыгрыша', color: 0x1abc9c },
  streak2: { name: '🔥 Стрик 2+ недели', color: 0xe74c3c },
  streak4: { name: '🔥 Стрик 4+ недели', color: 0xc0392b },
};

let _warned = false;

// id роли под бейдж: ручное переопределение из config -> сохранённая в БД
// (если ещё существует на сервере) -> иначе null (значит, надо создать).
async function resolveRoleId(guild, key) {
  const manual = (config.BADGE_ROLES || {})[key];
  if (manual) return manual;
  const row = await db.get('SELECT role_id FROM badge_roles WHERE badge_key = ?', [key]).catch(() => null);
  if (row && row.role_id && guild.roles.cache.has(row.role_id)) return row.role_id;
  return null;
}

// Гарантирует, что роль под бейдж существует — создаёт при необходимости.
async function ensureRole(guild, key) {
  const existing = await resolveRoleId(guild, key);
  if (existing) return existing;
  const meta = ROLE_META[key] || { name: LABELS[key] || key, color: 0x99aab5 };
  try {
    const role = await guild.roles.create({
      name: meta.name,
      color: meta.color,
      hoist: false,
      mentionable: false,
      reason: 'Авто-роль за достижение (бейдж)',
    });
    await db.run(
      `INSERT INTO badge_roles (badge_key, role_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(badge_key) DO UPDATE SET role_id = excluded.role_id, created_at = excluded.created_at`,
      [key, role.id, new Date().toISOString()],
    );
    console.log(`[badges] Создана роль за бейдж «${key}»: ${role.name} (${role.id})`);
    return role.id;
  } catch (err) {
    if (!_warned) {
      console.error('[badges] Не удалось создать роль за бейдж — проверьте право бота «Управление ролями»:', err.message);
      _warned = true;
    }
    return null;
  }
}

// Приводит Discord-роли участника в соответствие его бейджам. Роли под
// заработанные бейджи бот создаёт сам (лениво).
async function syncRoles(guild, discordId) {
  if (config.BADGE_AUTO_ROLES === false) return;
  let member;
  try { member = await guild.members.fetch(discordId); } catch (_) { return; }
  const { has } = await compute(discordId);
  for (const key of Object.keys(ROLE_META)) {
    if (has[key]) {
      const roleId = await ensureRole(guild, key);
      if (roleId && !member.roles.cache.has(roleId)) await member.roles.add(roleId).catch(() => {});
    } else {
      const roleId = await resolveRoleId(guild, key);
      if (roleId && member.roles.cache.has(roleId)) await member.roles.remove(roleId).catch(() => {});
    }
  }
}

async function syncAllRoles(guild) {
  if (config.BADGE_AUTO_ROLES === false) return;
  const rows = await db.all('SELECT discord_id FROM participants').catch(() => []);
  for (const r of rows) {
    await syncRoles(guild, r.discord_id);
    await new Promise((res) => setTimeout(res, 250));
  }
}

module.exports = { compute, syncRoles, syncAllRoles, ensureRole, resolveRoleId, LABELS, ROLE_META };
