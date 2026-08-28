const { EmbedBuilder } = require('discord.js');
const { CHANNEL_AUDIT, CHANNEL_SYSTEM_LOG } = require('./config');
const db = require('./db');

// details может быть либо строкой (как раньше), либо массивом полей вида
// { name, value, inline } — тогда они лягут отдельными полями embed'а
// (пример: "Повышение" — Кто повысил | Кого повысил, каждое своей колонкой).
async function logAudit(guild, actor, action, details, extraEmbeds = [], files = []) {
  const isFields = Array.isArray(details);
  const detailsForDb = isFields
    ? details.map((f) => `${f.name}: ${f.value}`).join(' | ')
    : String(details);

  try {
    await db.run(
      'INSERT INTO audit_log (actor_id, actor_tag, action, details, at) VALUES (?, ?, ?, ?, ?)',
      [actor.id, actor.tag, action, detailsForDb.slice(0, 2000), new Date().toISOString()],
    );
  } catch (err) {
    console.error('Не удалось сохранить запись аудита в БД:', err);
  }

  try {
    const channel = await guild.channels.fetch(CHANNEL_AUDIT);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(action)
      .setTimestamp();

    if (isFields) {
      embed.addFields(details.slice(0, 25).map((f) => ({ ...f, value: String(f.value).slice(0, 1024) || '—' })));
    } else {
      embed.setDescription(String(details).slice(0, 4000));
      embed.setFooter({ text: `Инициатор: ${actor.tag} (${actor.id})` });
    }

    await channel.send({ embeds: [embed, ...extraEmbeds].slice(0, 10), files });
  } catch (err) {
    console.error('Ошибка логирования аудита:', err);
  }
}

// Для системных сообщений о самом боте (запуск/перезапуск, сбой бэкапа,
// нехватка места и т.д.) — НЕ пишется в audit_log/БД и не засоряет
// /аудит_поиск, идёт в отдельный канал, чтобы не мешаться с логом
// действий людей.
async function logSystem(guild, title, details) {
  try {
    const channel = await guild.channels.fetch(CHANNEL_SYSTEM_LOG);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0x99aab5)
      .setTitle(title)
      .setDescription(String(details).slice(0, 4000))
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Ошибка логирования системного события:', err);
  }
}

module.exports = { logAudit, logSystem };
