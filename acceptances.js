const db = require('./db');
const config = require('./config');

const MIN_MS = config.INVITATION_MIN_DAYS * 24 * 60 * 60 * 1000;

async function recordAcceptance(staffDiscordId, applicantDiscordId, applicantName, applicantStatic, joinedAt) {
  const existing = await db.get('SELECT id FROM acceptances WHERE applicant_discord_id = ?', [applicantDiscordId]);
  if (existing) return;
  await db.run(
    `INSERT INTO acceptances (staff_discord_id, applicant_discord_id, applicant_name, applicant_static, joined_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [staffDiscordId, applicantDiscordId, applicantName, applicantStatic, joinedAt, new Date().toISOString()],
  );
}

// Вызывается при увольнении/выходе участника — решает: засчитывать (3+ дня) или нет.
async function resolveOnLeave(discordId) {
  const acc = await db.get(`SELECT * FROM acceptances WHERE applicant_discord_id = ? AND status = 'pending'`, [discordId]);
  if (!acc) return;
  const elapsed = Date.now() - new Date(acc.joined_at).getTime();
  const newStatus = elapsed >= MIN_MS ? 'confirmed' : 'disqualified';
  await db.run('UPDATE acceptances SET status = ?, resolved_at = ? WHERE id = ?', [newStatus, new Date().toISOString(), acc.id]);
}

// Раз в час — засчитывает тех, кто пробыл нужный срок и всё ещё в организации.
async function promotePendingToConfirmed() {
  const pending = await db.all(`SELECT * FROM acceptances WHERE status = 'pending'`);
  const now = Date.now();
  for (const acc of pending) {
    const elapsed = now - new Date(acc.joined_at).getTime();
    if (elapsed < MIN_MS) continue;
    const stillHere = await db.get('SELECT id FROM participants WHERE discord_id = ?', [acc.applicant_discord_id]);
    if (!stillHere) continue;
    await db.run('UPDATE acceptances SET status = ?, resolved_at = ? WHERE id = ?', ['confirmed', new Date().toISOString(), acc.id]);
  }
}

// Для недели: сколько принятых каждым сотрудником подтвердились (3+ дня) и
// сколько отсеялось (меньше 3 дней), считаем по дате вступления.
async function getStaffWeekStats(staffDiscordId, range) {
  const rows = await db.all(
    `SELECT * FROM acceptances WHERE staff_discord_id = ? AND status IN ('confirmed', 'disqualified')
     AND joined_at BETWEEN ? AND ?`,
    [staffDiscordId, range.start.toISOString(), range.end.toISOString()],
  );
  return {
    confirmed: rows.filter((r) => r.status === 'confirmed').length,
    disqualified: rows.filter((r) => r.status === 'disqualified').length,
  };
}

async function getActiveStaffForWeek(range) {
  const rows = await db.all(
    `SELECT DISTINCT staff_discord_id FROM acceptances WHERE status IN ('confirmed', 'disqualified')
     AND joined_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  );
  return rows.map((r) => r.staff_discord_id);
}

module.exports = {
  recordAcceptance,
  resolveOnLeave,
  promotePendingToConfirmed,
  getStaffWeekStats,
  getActiveStaffForWeek,
};
