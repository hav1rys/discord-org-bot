const db = require('./db');
const config = require('./config');

const MIN_MS = config.INVITATION_MIN_DAYS * 24 * 60 * 60 * 1000;

// Пытается найти участника (из текущего списка людей) по свободному тексту
// "Кто вас пригласил": точный Discord ID, точный № Паспорта, иначе LIKE по
// имени/тегу. Возвращает строку participants или null.
async function resolveInviter(text) {
  const value = (text || '').trim();
  if (!value) return null;

  let row = await db.get('SELECT * FROM participants WHERE discord_id = ?', [value]);
  if (row) return row;

  row = await db.get('SELECT * FROM participants WHERE static = ?', [value]);
  if (row) return row;

  const q = `%${value}%`;
  row = await db.get(
    `SELECT p.* FROM participants p
     LEFT JOIN extra_passports e ON e.discord_id = p.discord_id
     WHERE p.name LIKE ? OR p.discord_tag LIKE ? OR e.name LIKE ? OR e.static LIKE ?
     LIMIT 1`,
    [q, q, q, q],
  );
  return row || null;
}

// Есть ли у этого discord_id хоть какая-то запись о приглашении (в любом
// статусе) — если да, новую заводить нельзя (в т.ч. это реализует
// "постоянную блокировку": раз дисквалифицирован — запись останется навсегда).
async function hasExistingInvitationRecord(discordId) {
  const row = await db.get('SELECT id FROM invitations WHERE invitee_discord_id = ?', [discordId]);
  return !!row;
}

// Вызывается при принятии заявки, если поле "Кто вас пригласил" заполнено
// и удалось найти пригласившего среди текущих участников.
async function recordInvitation(inviterDiscordId, inviteeDiscordId, inviteeName, inviteeStatic, joinedAt) {
  if (inviterDiscordId === inviteeDiscordId) return; // нельзя пригласить самого себя
  if (await hasExistingInvitationRecord(inviteeDiscordId)) return;

  await db.run(
    `INSERT INTO invitations (inviter_discord_id, invitee_discord_id, invitee_name, invitee_static, joined_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [inviterDiscordId, inviteeDiscordId, inviteeName, inviteeStatic, joinedAt, new Date().toISOString()],
  );
}

// Вызывается при увольнении/выходе участника — если он был кем-то приглашён
// и приглашение ещё "pending", решает: засчитывать или дисквалифицировать.
async function resolveOnLeave(discordId) {
  const invite = await db.get(`SELECT * FROM invitations WHERE invitee_discord_id = ? AND status = 'pending'`, [discordId]);
  if (!invite) return;

  const elapsed = Date.now() - new Date(invite.joined_at).getTime();
  const newStatus = elapsed >= MIN_MS ? 'confirmed' : 'disqualified';
  await db.run('UPDATE invitations SET status = ?, resolved_at = ? WHERE id = ?', [newStatus, new Date().toISOString(), invite.id]);
}

// Периодическая проверка: те, кто пробыл нужный срок и всё ещё состоит в
// организации, засчитываются автоматически (не дожидаясь увольнения).
async function promotePendingToConfirmed() {
  const pending = await db.all(`SELECT * FROM invitations WHERE status = 'pending'`);
  const now = Date.now();
  for (const invite of pending) {
    const elapsed = now - new Date(invite.joined_at).getTime();
    if (elapsed < MIN_MS) continue;
    const stillHere = await db.get('SELECT id FROM participants WHERE discord_id = ?', [invite.invitee_discord_id]);
    if (!stillHere) continue; // если уже вышел — статус решает resolveOnLeave
    await db.run('UPDATE invitations SET status = ?, resolved_at = ? WHERE id = ?', ['confirmed', new Date().toISOString(), invite.id]);
  }
}

async function getInvitationById(id) {
  return db.get('SELECT * FROM invitations WHERE id = ?', [id]);
}

async function deleteInvitation(id) {
  await db.run('DELETE FROM invitations WHERE id = ?', [id]);
}

// Ручное добавление (сразу подтверждённое — HR добавляет по факту проверки).
async function addManualInvitation(inviterDiscordId, inviteeDiscordId, inviteeName, inviteeStatic, joinedAt) {
  if (await hasExistingInvitationRecord(inviteeDiscordId)) {
    throw new Error('У этого участника уже есть запись о приглашении.');
  }
  await db.run(
    `INSERT INTO invitations (inviter_discord_id, invitee_discord_id, invitee_name, invitee_static, joined_at, status, resolved_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
    [inviterDiscordId, inviteeDiscordId, inviteeName, inviteeStatic, joinedAt, new Date().toISOString(), new Date().toISOString()],
  );
}

// Подтверждённые приглашения конкретного пригласившего за неделю (по дате
// вступления приглашённого).
async function getInviterInviteesForWeek(inviterDiscordId, range) {
  return db.all(
    `SELECT * FROM invitations WHERE inviter_discord_id = ? AND status = 'confirmed'
     AND joined_at BETWEEN ? AND ? ORDER BY joined_at ASC`,
    [inviterDiscordId, range.start.toISOString(), range.end.toISOString()],
  );
}

// Все пригласившие, у кого есть хотя бы одно подтверждённое приглашение за неделю.
async function getActiveInvitersForWeek(range) {
  const rows = await db.all(
    `SELECT DISTINCT inviter_discord_id FROM invitations WHERE status = 'confirmed'
     AND joined_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  );
  return rows.map((r) => r.inviter_discord_id);
}

// Все приглашения (любой статус) конкретного пригласившего — для ручного удаления.
async function getInviterAllInvitations(inviterDiscordId) {
  return db.all('SELECT * FROM invitations WHERE inviter_discord_id = ? ORDER BY created_at DESC LIMIT 25', [inviterDiscordId]);
}

// Топ по приглашениям за всё время — для /invitations_leaderboard
async function getAllTimeLeaderboard() {
  return db.all(
    `SELECT inviter_discord_id, COUNT(*) as cnt FROM invitations WHERE status = 'confirmed'
     GROUP BY inviter_discord_id ORDER BY cnt DESC`,
  );
}

// Топ по приглашениям за конкретную неделю (по дате вступления приглашённого)
async function getWeekLeaderboard(range) {
  return db.all(
    `SELECT inviter_discord_id, COUNT(*) as cnt FROM invitations
     WHERE status = 'confirmed' AND joined_at BETWEEN ? AND ?
     GROUP BY inviter_discord_id ORDER BY cnt DESC`,
    [range.start.toISOString(), range.end.toISOString()],
  );
}

module.exports = {
  resolveInviter,
  hasExistingInvitationRecord,
  recordInvitation,
  resolveOnLeave,
  promotePendingToConfirmed,
  getInvitationById,
  deleteInvitation,
  addManualInvitation,
  getInviterInviteesForWeek,
  getActiveInvitersForWeek,
  getInviterAllInvitations,
  getAllTimeLeaderboard,
  getWeekLeaderboard,
};
