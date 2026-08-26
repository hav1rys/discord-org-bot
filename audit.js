const { EmbedBuilder } = require('discord.js');
const { CHANNEL_AUDIT, CHANNEL_SYSTEM_LOG } = require('./config');
const db = require('./db');

async function logAudit(guild, actor, action, details, extraEmbeds = []) {
  try {
    await db.run(
      'INSERT INTO audit_log (actor_id, actor_tag, action, details, at) VALUES (?, ?, ?, ?, ?)',
      [actor.id, actor.tag, action, details, new Date().toISOString()],
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
      .setDescription(String(details).slice(0, 4000))
      .setFooter({ text: `Инициатор: ${actor.tag} (${actor.id})` })
      .setTimestamp();

    await channel.send({ embeds: [embed, ...extraEmbeds].slice(0, 10) });
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
