const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getSetting, setSetting } = require('./db');
const { CHANNEL_CONTRACTS_STATS } = require('./config');
const contracts = require('./contracts');
const weekRevert = require('./week_revert');

async function buildStatsEmbeds(weeksAgo) {
  const range = contracts.getWeekRange(weeksAgo);
  const label = contracts.formatWeekLabel(range);
  const discordIds = await contracts.getActiveDiscordIdsForWeek(range);

  if (discordIds.length === 0) {
    return {
      range,
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Статистика по контрактам').setDescription(`за ${label}\n\nОбработанных контрактов за эту неделю нет.`)],
    };
  }

  const embeds = [];
  let current = new EmbedBuilder().setColor(0x5865f2).setTitle('Статистика по контрактам').setDescription(`за ${label}`);
  let fieldCount = 0;

  for (const discordId of discordIds) {
    const { fulfilled, unfulfilled } = await contracts.getUserWeekStats(discordId, range);

    const fulfilledLines = fulfilled.map((c) => `[Скриншот](${c.message_url}) | ${contracts.formatDate(new Date(c.submitted_at))}`);
    fulfilledLines.push(`Всего: ${fulfilled.length}`);

    const unfulfilledLines = unfulfilled.map((c) => `[Скриншот](${c.message_url}) | ${contracts.formatDate(new Date(c.submitted_at))}`);
    unfulfilledLines.push(`Всего: ${unfulfilled.length}`);

    if (fieldCount + 3 > 25) {
      embeds.push(current);
      current = new EmbedBuilder().setColor(0x5865f2).setTitle('Статистика по контрактам (продолжение)').setDescription(`за ${label}`);
      fieldCount = 0;
    }

    current.addFields(
      { name: 'Участник', value: `<@${discordId}>\nВсего контрактов: ${fulfilled.length + unfulfilled.length}`, inline: true },
      { name: 'Выполненные контракты', value: fulfilledLines.join('\n').slice(0, 1024) || '—', inline: true },
      { name: 'Не выполненные контракты', value: unfulfilledLines.join('\n').slice(0, 1024) || '—', inline: true },
    );
    fieldCount += 3;
  }
  embeds.push(current);

  return { range, embeds };
}

function buildControlRows(weeksAgo) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('contracts_prev_week').setLabel('◀ Пред. неделя').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('contracts_this_week').setLabel('Эта неделя').setStyle(ButtonStyle.Primary).setDisabled(weeksAgo === 0),
    new ButtonBuilder().setCustomId('contracts_next_week').setLabel('След. неделя ▶').setStyle(ButtonStyle.Secondary).setDisabled(weeksAgo <= 0),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('contracts_add').setLabel('➕ Добавить контракт').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('contracts_remove').setLabel('➖ Удалить контракт').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('contracts_search').setLabel('🔍 Найти').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

async function getCurrentWeeksAgo() {
  const stored = await getSetting('contracts_weeks_ago');
  return stored ? parseInt(stored, 10) : 0;
}

async function updateContractsStats(guild, weeksAgo = null) {
  const channel = await guild.channels.fetch(CHANNEL_CONTRACTS_STATS);
  if (!channel) return;

  const currentWeeksAgo = weeksAgo === null ? await getCurrentWeeksAgo() : weeksAgo;
  if (weeksAgo !== null) {
    await weekRevert.touchRevertTimer('contracts', currentWeeksAgo);
  }

  const { embeds } = await buildStatsEmbeds(currentWeeksAgo);
  const revertAt = await weekRevert.getRevertAt('contracts');
  const line = weekRevert.revertLine(revertAt);
  if (line) embeds[embeds.length - 1].addFields({ name: '\u200b', value: line });

  const components = buildControlRows(currentWeeksAgo);

  const messageId = await getSetting('contracts_stats_message_id');
  let message = null;

  if (messageId) {
    try {
      message = await channel.messages.fetch(messageId);
    } catch (_) {
      message = null;
    }
  }

  if (message) {
    await message.edit({ embeds, components });
  } else {
    const sent = await channel.send({ embeds, components });
    await setSetting('contracts_stats_message_id', sent.id);
  }

  await setSetting('contracts_weeks_ago', String(currentWeeksAgo));
}

async function changeContractsWeek(guild, direction) {
  const current = await getCurrentWeeksAgo();
  let next = current + direction;
  if (next < 0) next = 0;
  await updateContractsStats(guild, next);
}

async function jumpToCurrentWeek(guild) {
  await updateContractsStats(guild, 0);
}

async function safeUpdateContractsStats(guild) {
  try {
    await updateContractsStats(guild);
  } catch (err) {
    console.error('Не удалось обновить статистику контрактов:', err);
  }
}

async function checkAndRevertIfExpired(guild) {
  if (await weekRevert.isExpired('contracts')) {
    await updateContractsStats(guild, 0);
  }
}

module.exports = {
  updateContractsStats,
  changeContractsWeek,
  jumpToCurrentWeek,
  safeUpdateContractsStats,
  getCurrentWeeksAgo,
  checkAndRevertIfExpired,
};
