const { EmbedBuilder } = require('discord.js');
const { CHANNEL_AUDIT } = require('./config');

async function logAudit(guild, actor, action, details) {
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
