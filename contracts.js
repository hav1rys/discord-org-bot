const db = require('./db');
const dates = require('./dates');

function formatDate(date) {
  return dates.formatDateOnly(date);
}

// Понедельник 00:00:00 — воскресенье 23:59:59 недели по МОСКОВСКОМУ
// времени, смещённой на weeksAgo недель назад от текущей (0 = эта неделя).
function getWeekRange(weeksAgo = 0) {
  const now = dates.mskNow(); // сдвинутый Date — читаем через getUTC*()
  const day = now.getUTCDay(); // 0=вс..6=сб (уже по МСК)
  const diffToMonday = day === 0 ? 6 : day - 1;

  const mondayMsk = new Date(now);
  mondayMsk.setUTCHours(0, 0, 0, 0);
  mondayMsk.setUTCDate(mondayMsk.getUTCDate() - diffToMonday - weeksAgo * 7);

  const sundayMsk = new Date(mondayMsk);
  sundayMsk.setUTCDate(sundayMsk.getUTCDate() + 6);
  sundayMsk.setUTCHours(23, 59, 59, 999);

  // mondayMsk/sundayMsk сейчас представляют московские Ч:М:С, но как будто
  // они UTC — переводим обратно в реальный UTC-момент (вычитаем сдвиг),
  // чтобы дальше сравнивать с датами из БД (которые хранятся в UTC ISO).
  return {
    start: new Date(mondayMsk.getTime() - dates.MSK_OFFSET_MS),
    end: new Date(sundayMsk.getTime() - dates.MSK_OFFSET_MS),
  };
}

function formatWeekLabel(range) {
  return `${formatDate(range.start)} — ${formatDate(range.end)}`;
}

// Скриншот прислан участником — ждёт проверки руководством.
async function recordPendingContract(discordId, threadId, messageId, messageUrl, submittedAt) {
  const result = await db.run(
    `INSERT INTO contracts (discord_id, thread_id, message_id, message_url, submitted_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [discordId, threadId, messageId, messageUrl, submittedAt],
  );
  return result.lastID;
}

// status: 'fulfilled' | 'unfulfilled' | 'rejected' (rejected = это вообще не
// контракт, просто скриншот — в статистику не попадает).
async function reviewContract(contractId, status, reviewerId) {
  await db.run(
    'UPDATE contracts SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
    [status, reviewerId, new Date().toISOString(), contractId],
  );
}

async function setReviewMessageId(contractId, reviewMessageId) {
  await db.run('UPDATE contracts SET review_message_id = ? WHERE id = ?', [reviewMessageId, contractId]);
}

async function setTakenInfo(contractId, takenUrl, takenAt) {
  await db.run('UPDATE contracts SET taken_message_url = ?, taken_submitted_at = ? WHERE id = ?', [takenUrl, takenAt, contractId]);
}

async function setLocalPaths(contractId, takenLocalPath, completedLocalPath) {
  await db.run('UPDATE contracts SET taken_local_path = ?, completed_local_path = ? WHERE id = ?', [takenLocalPath, completedLocalPath, contractId]);
}

async function getContractById(id) {
  return db.get('SELECT * FROM contracts WHERE id = ?', [id]);
}

// Ручное добавление контракта (без скриншота в форуме — прямая запись).
// threadId — канал-профиль конкретного паспорта, если известен (нужен,
// чтобы контракт учитывался в авто-повышении по контрактам, как и обычные
// со скриншотом); null, если паспорт не выбирали (например, старый вызов).
async function recordManualContract(discordId, messageUrl, submittedAt, status, reviewerId, threadId = null) {
  const syntheticMessageId = `manual-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const result = await db.run(
    `INSERT INTO contracts (discord_id, thread_id, message_id, message_url, submitted_at, status, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [discordId, threadId, syntheticMessageId, messageUrl, submittedAt, status, reviewerId, new Date().toISOString()],
  );
  return result.lastID;
}

async function deleteContract(id) {
  await db.run('DELETE FROM contracts WHERE id = ?', [id]);
}

// Обработанные контракты (выполнен/невыполнен — НЕ pending, НЕ rejected)
// участника за неделю, разбитые по статусу.
async function getUserWeekStats(discordId, range) {
  const rows = await db.all(
    `SELECT * FROM contracts WHERE discord_id = ? AND status IN ('fulfilled', 'unfulfilled')
     AND submitted_at BETWEEN ? AND ? ORDER BY submitted_at ASC`,
    [discordId, range.start.toISOString(), range.end.toISOString()],
  );
  return {
    fulfilled: rows.filter((r) => r.status === 'fulfilled'),
    unfulfilled: rows.filter((r) => r.status === 'unfulfilled'),
  };
}

// Список всех discord_id, у которых есть хоть один засчитанный контракт за неделю.
async function getActiveDiscordIdsForWeek(range) {
  const rows = await db.all(
    `SELECT DISTINCT discord_id FROM contracts WHERE status IN ('fulfilled', 'unfulfilled')
     AND submitted_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  );
  return rows.map((r) => r.discord_id);
}

// Список контрактов участника за неделю (для ручного удаления) — включает и rejected,
// чтобы можно было почистить ошибочно отклонённое тоже.
async function getUserContractsForWeek(discordId, range) {
  return db.all(
    `SELECT * FROM contracts WHERE discord_id = ? AND status != 'pending'
     AND submitted_at BETWEEN ? AND ? ORDER BY submitted_at DESC LIMIT 25`,
    [discordId, range.start.toISOString(), range.end.toISOString()],
  );
}

// Топ по контрактам за всё время (не по неделям) — для /contracts_leaderboard
async function getAllTimeLeaderboard() {
  return db.all(
    `SELECT discord_id,
            SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as fulfilled,
            SUM(CASE WHEN status = 'unfulfilled' THEN 1 ELSE 0 END) as unfulfilled
     FROM contracts
     WHERE status IN ('fulfilled', 'unfulfilled')
     GROUP BY discord_id
     ORDER BY fulfilled DESC, unfulfilled DESC`,
  );
}

// Топ по контрактам за конкретную неделю (range из getWeekRange)
async function getWeekLeaderboard(range) {
  return db.all(
    `SELECT discord_id,
            SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as fulfilled,
            SUM(CASE WHEN status = 'unfulfilled' THEN 1 ELSE 0 END) as unfulfilled
     FROM contracts
     WHERE status IN ('fulfilled', 'unfulfilled') AND submitted_at BETWEEN ? AND ?
     GROUP BY discord_id
     ORDER BY fulfilled DESC, unfulfilled DESC`,
    [range.start.toISOString(), range.end.toISOString()],
  );
}

module.exports = {
  getWeekRange,
  formatWeekLabel,
  formatDate,
  recordPendingContract,
  reviewContract,
  setReviewMessageId,
  setTakenInfo,
  setLocalPaths,
  getContractById,
  recordManualContract,
  deleteContract,
  getUserWeekStats,
  getActiveDiscordIdsForWeek,
  getUserContractsForWeek,
  getAllTimeLeaderboard,
  getWeekLeaderboard,
};
