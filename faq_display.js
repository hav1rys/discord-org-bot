const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { getSetting, setSetting } = require('./db');
const config = require('./config');
const faq = require('./faq');

function channelFor(category) {
  if (category === 'hr') return config.CHANNEL_FAQ_HR;
  if (category === 'public') return config.CHANNEL_FAQ_PUBLIC;
  return config.CHANNEL_FAQ_MEMBERS;
}

function titleFor(category) {
  if (category === 'hr') return '❓ FAQ для HR-Менеджеров';
  if (category === 'public') return '❓ FAQ — общие вопросы (для всех)';
  return '❓ FAQ для участников организации';
}

async function buildPayload(category) {
  const entries = await faq.listEntries(category);
  const bannerEmbed = new EmbedBuilder().setColor(0x5865f2).setTitle(titleFor(category));
  const searchRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('faq_search').setLabel('🔍 Поиск по гайдам').setStyle(ButtonStyle.Secondary),
  );

  if (entries.length === 0) {
    bannerEmbed.setDescription('Пока нет гайдов.');
    return { embeds: [bannerEmbed], components: [searchRow] };
  }

  bannerEmbed.setDescription('Выберите вопрос из списка ниже или нажмите «Поиск».');

  // Discord позволяет максимум 25 пунктов в одном select-меню
  const select = new StringSelectMenuBuilder()
    .setCustomId(`faq_view:${category}`)
    .setPlaceholder('Выберите необходимый вопрос')
    .addOptions(
      entries.slice(0, 25).map((e) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(e.title.slice(0, 100))
          .setDescription('Ответ на данный вопрос (Нажмите)')
          .setValue(String(e.id))
          .setEmoji('❓'),
      ),
    );

  return { embeds: [bannerEmbed], components: [new ActionRowBuilder().addComponents(select), searchRow] };
}

async function updateFaqChannel(guild, category) {
  const channel = await guild.channels.fetch(channelFor(category));
  if (!channel) return;

  const payload = await buildPayload(category);
  const key = `faq_${category}_message_id`;
  const messageId = await getSetting(key);
  let message = null;

  if (messageId) {
    try {
      message = await channel.messages.fetch(messageId);
    } catch (_) {
      message = null;
    }
  }

  // На случай, если раньше стояла старая версия FAQ (несколько отдельных
  // сообщений-эмбедов) — подчищаем их, теперь всё в одном сообщении.
  const oldIdsKey = `faq_${category}_message_ids`;
  const oldIdsRaw = await getSetting(oldIdsKey);
  if (oldIdsRaw) {
    for (const oldId of JSON.parse(oldIdsRaw)) {
      if (oldId === messageId) continue;
      try {
        const msg = await channel.messages.fetch(oldId);
        await msg.delete();
      } catch (_) {}
    }
    await setSetting(oldIdsKey, '');
  }

  if (message) {
    await message.edit(payload);
  } else {
    const sent = await channel.send(payload);
    await setSetting(key, sent.id);
  }
}

async function safeUpdateFaqChannel(guild, category) {
  try {
    await updateFaqChannel(guild, category);
  } catch (err) {
    console.error(`Не удалось обновить канал FAQ (${category}):`, err);
  }
}

module.exports = { updateFaqChannel, safeUpdateFaqChannel };
