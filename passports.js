const db = require('./db');
const config = require('./config');

// Возвращает [{name, static, position}] — позиция 0 это основной паспорт
// из participants, 1 и 2 — дополнительные из extra_passports.
async function getAllPassports(discordId) {
  const participant = await db.get('SELECT name, static FROM participants WHERE discord_id = ?', [discordId]);
  const list = [];
  if (participant) list.push({ name: participant.name, static: participant.static, position: 0 });
  const extras = await db.all('SELECT name, static, position FROM extra_passports WHERE discord_id = ? ORDER BY position', [discordId]);
  for (const e of extras) list.push({ name: e.name, static: e.static, position: e.position });
  return list;
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

async function addExtraPassport(discordId, name, staticValue) {
  const current = await getAllPassports(discordId);
  if (current.length >= config.MAX_PASSPORTS_PER_USER) {
    throw new Error(`Максимум ${config.MAX_PASSPORTS_PER_USER} паспорта на одного участника.`);
  }
  const nextPosition = current.length; // 0 занят основным, значит extras начинаются с 1
  await db.run(
    'INSERT INTO extra_passports (discord_id, name, static, position, created_at) VALUES (?, ?, ?, ?, ?)',
    [discordId, name, staticValue, nextPosition, new Date().toISOString()],
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

module.exports = { getAllPassports, isStaticTaken, addExtraPassport, removeExtraPassport };