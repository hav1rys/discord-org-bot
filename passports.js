const db = require('./db');
const config = require('./config');

// Возвращает [{name, static, position, role_id, vacation_until, afk_since,
// profile_thread_id}] — позиция 0 это основной паспорт из participants,
// 1 и 2 — дополнительные из extra_passports. Отсортировано по позиции.
async function getAllPassports(discordId) {
  const participant = await db.get(
    'SELECT name, static, role_id, vacation_until, afk_since, profile_thread_id FROM participants WHERE discord_id = ?',
    [discordId],
  );
  const list = [];
  if (participant) {
    list.push({
      name: participant.name,
      static: participant.static,
      position: 0,
      role_id: participant.role_id,
      vacation_until: participant.vacation_until,
      afk_since: participant.afk_since,
      profile_thread_id: participant.profile_thread_id,
    });
  }
  const extras = await db.all(
    'SELECT name, static, position, role_id, vacation_until, afk_since, profile_thread_id FROM extra_passports WHERE discord_id = ? ORDER BY position',
    [discordId],
  );
  for (const e of extras) list.push(e);
  return list;
}

// Проставляет discord-канал для конкретного паспорта — сам определяет,
// лежит ли этот паспорт в participants (позиция 0) или в extra_passports.
async function setPassportChannel(discordId, staticValue, channelId) {
  const inParticipants = await db.get('SELECT id FROM participants WHERE discord_id = ? AND static = ?', [discordId, staticValue]);
  if (inParticipants) {
    await db.run('UPDATE participants SET profile_thread_id = ? WHERE discord_id = ?', [channelId, discordId]);
  } else {
    await db.run('UPDATE extra_passports SET profile_thread_id = ? WHERE discord_id = ? AND static = ?', [channelId, discordId, staticValue]);
  }
}

// Проверяет, занят ли номер паспорта где-либо в системе (кроме самого discordId, если передан)
async function isStaticTaken(staticValue, excludeDiscordId = null) {
  const inParticipants = await db.get(
    excludeDiscordId ? 'SELECT id FROM participants WHERE static = ? AND discord_id != ?' : 'SELECT id FROM participants WHERE static = ?',
    excludeDiscordId ? [staticValue, excludeDiscordId] : [staticValue],
  );
  if (inParticipants) return true;

  const inExtras = await db.get(
    excludeDiscordId ? 'SELECT id FROM extra_passports WHERE static = ? AND discord_id != ?' : 'SELECT id FROM extra_passports WHERE static = ?',
    excludeDiscordId ? [staticValue, excludeDiscordId] : [staticValue],
  );
  return !!inExtras;
}

// Новый доп. паспорт по умолчанию получает самый низкий ранг (Стажер) —
// дальше его можно повысить отдельно от остальных паспортов человека.
async function addExtraPassport(discordId, name, staticValue, actorId = null) {
  const current = await getAllPassports(discordId);
  const bypassLimit = actorId === config.OWNER_USER_ID;
  if (!bypassLimit && current.length >= config.MAX_PASSPORTS_PER_USER) {
    throw new Error(`Максимум ${config.MAX_PASSPORTS_PER_USER} паспорта на одного участника.`);
  }
  const nextPosition = current.length;
  await db.run(
    'INSERT INTO extra_passports (discord_id, name, static, position, role_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [discordId, name, staticValue, nextPosition, config.ROLE_APPLY, new Date().toISOString()],
  );
}

async function removeExtraPassport(discordId, staticValue) {
  await db.run('DELETE FROM extra_passports WHERE discord_id = ? AND static = ?', [discordId, staticValue]);
  // Пересчитываем позиции оставшихся дополнительных паспортов, чтобы не было дыр
  const remaining = await db.all('SELECT id FROM extra_passports WHERE discord_id = ? ORDER BY position', [discordId]);
  for (let i = 0; i < remaining.length; i++) {
    await db.run('UPDATE extra_passports SET position = ? WHERE id = ?', [i + 1, remaining[i].id]);
  }
}

// Универсальный сеттер полей одного конкретного паспорта (по discordId +
// номеру паспорта) — сам определяет, лежит ли этот паспорт в participants
// (позиция 0) или в extra_passports, и обновляет нужную таблицу.
async function updatePassportFields(discordId, staticValue, fields) {
  const inParticipants = await db.get('SELECT id FROM participants WHERE discord_id = ? AND static = ?', [discordId, staticValue]);
  const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  if (inParticipants) {
    await db.run(`UPDATE participants SET ${setClause} WHERE discord_id = ?`, [...values, discordId]);
  } else {
    await db.run(`UPDATE extra_passports SET ${setClause} WHERE discord_id = ? AND static = ?`, [...values, discordId, staticValue]);
  }
}

function rankIndexOf(roleId) {
  return config.ROLE_IDS.indexOf(roleId);
}

// Вычисляет "эффективную личность" аккаунта — какое Имя Фамилия | Паспорт
// и какая роль должны быть у него на сервере (ник + фактическая роль),
// когда у человека несколько паспортов с разными рангами:
// - Если ВСЕ паспорта на одном ранге → используется паспорт, с которым
//   человек вступил (самый первый по порядку добавления, НЕ по повышениям).
// - Если ранги разные → используется паспорт с самым высоким рангом.
// Возвращает null, если у аккаунта вообще нет паспортов.
async function computeEffectiveIdentity(discordId) {
  const passports = await getAllPassports(discordId);
  if (passports.length === 0) return null;

  const ranked = passports.map((p) => ({ ...p, rankIndex: rankIndexOf(p.role_id) }));
  const allSameRank = ranked.every((p) => p.rankIndex === ranked[0].rankIndex);

  if (allSameRank) {
    const first = passports.reduce((a, b) => (a.position <= b.position ? a : b));
    return { name: first.name, static: first.static, roleId: first.role_id };
  }

  // Наименьший индекс в ROLE_IDS = самый высокий ранг. Паспорта без
  // распознанного ранга (rankIndex === -1) в расчёт "самого высокого" не берём.
  const withRank = ranked.filter((p) => p.rankIndex !== -1);
  const pool = withRank.length > 0 ? withRank : ranked;
  const highest = pool.reduce((a, b) => (a.rankIndex <= b.rankIndex ? a : b));
  return { name: highest.name, static: highest.static, roleId: highest.role_id };
}

// Удаляет ОДИН конкретный паспорт, оставляя аккаунт — если удаляется
// основной (позиция 0), следующий по порядку становится новым основным
// (п.6.1). Бросает исключение, если это последний паспорт (тогда нужно
// полное увольнение, не частичное).
async function removePassportKeepAccount(discordId, targetStatic) {
  const passports = await getAllPassports(discordId);
  if (passports.length <= 1) {
    throw new Error('Это последний паспорт участника — используйте полное увольнение.');
  }

  const removed = passports.find((p) => p.static === targetStatic);
  const isPrimary = passports[0].static === targetStatic;

  if (isPrimary) {
    const next = passports[1];
    await db.run(
      'UPDATE participants SET name = ?, static = ?, role_id = ?, vacation_until = ?, afk_since = ?, profile_thread_id = ? WHERE discord_id = ?',
      [next.name, next.static, next.role_id, next.vacation_until, next.afk_since, next.profile_thread_id, discordId],
    );
    await db.run('DELETE FROM extra_passports WHERE discord_id = ? AND static = ?', [discordId, next.static]);
  } else {
    await db.run('DELETE FROM extra_passports WHERE discord_id = ? AND static = ?', [discordId, targetStatic]);
  }

  const remaining = await db.all('SELECT id FROM extra_passports WHERE discord_id = ? ORDER BY position', [discordId]);
  for (let i = 0; i < remaining.length; i++) {
    await db.run('UPDATE extra_passports SET position = ? WHERE id = ?', [i + 1, remaining[i].id]);
  }

  return { archivedChannelId: removed ? removed.profile_thread_id : null };
}

module.exports = {
  getAllPassports,
  isStaticTaken,
  addExtraPassport,
  removeExtraPassport,
  removePassportKeepAccount,
  updatePassportFields,
  setPassportChannel,
  rankIndexOf,
  computeEffectiveIdentity,
};
