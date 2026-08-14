const { EmbedBuilder } = require('discord.js');
const { getSetting, setSetting } = require('./db');
const config = require('./config');
const faq = require('./faq');

function channelFor(category) {
  return category === 'hr' ? config.CHANNEL_FAQ_HR : config.CHANNEL_FAQ_MEMBERS;
}

function titleFor(category) {
  return category === 'hr' ? '❓ FAQ для HR-Менеджеров' : '❓ FAQ для участников организации';
}

async function buildEmbeds(category) {
  const entries = await faq.listEntries(category);
  if (entries.length === 0) {
    return [new EmbedBuilder().setColor(0x5865f2).setTitle(titleFor(category)).setDescription('Пока нет гайдов.')];
  }
  const embeds = entries.map((e) =>
    new EmbedBuilder().setColor(0x5865f2).setTitle(e.title).setDescription(e.content.slice(0, 4000)),
  );
  embeds[0].setAuthor({ name: titleFor(category) });
  return embeds;
}

// Discord позволяет максимум 10 embed'ов в одном сообщении — если гайдов
// больше, разбиваем на несколько сообщений подряд в этом же канале.
async function updateFaqChannel(guild, category) {
  const channel = await guild.channels.fetch(channelFor(category));
  if (!channel) return;

  const allEmbeds = await buildEmbeds(category);
  const chunks = [];
  for (let i = 0; i < allEmbeds.length; i += 10) chunks.push(allEmbeds.slice(i, i + 10));
  if (chunks.length === 0) chunks.push([]);

  const key = `faq_${category}_message_ids`;
  const stored = await getSetting(key);
  const storedIds = stored ? JSON.parse(stored) : [];
  const newIds = [];

  for (let i = 0; i < chunks.length; i++) {
    const payload = { embeds: chunks[i] };
    if (storedIds[i]) {
      try {
        const msg = await channel.messages.fetch(storedIds[i]);
        await msg.edit(payload);
        newIds.push(storedIds[i]);
        continue;
      } catch (_) {
        // сообщение удалили вручную — отправим новое
      }
    }
    const sent = await channel.send(payload);
    newIds.push(sent.id);
  }

  for (let i = chunks.length; i < storedIds.length; i++) {
    try {
      const msg = await channel.messages.fetch(storedIds[i]);
      await msg.delete();
    } catch (_) {}
  }

  await setSetting(key, JSON.stringify(newIds));
}

async function safeUpdateFaqChannel(guild, category) {
  try {
    await updateFaqChannel(guild, category);
  } catch (err) {
    console.error(`Не удалось обновить канал FAQ (${category}):`, err);
  }
}

module.exports = { updateFaqChannel, safeUpdateFaqChannel };
