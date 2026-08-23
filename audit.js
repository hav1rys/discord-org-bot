const { EmbedBuilder } = require('discord.js');
const { CHANNEL_AUDIT } = require('./config');
const db = require('./db');

async function logAudit(guild, actor, action, details) {
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
      .setDescription(details)
      .setFooter({ text: `Инициатор: ${actor.tag} (${actor.id})` })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Ошибка логирования аудита:', err);
  }
}

module.exports = { logAudit };
