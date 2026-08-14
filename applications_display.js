const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getSetting, setSetting, all } = require('./db');
const { CHANNEL_CONTRACTS_STATS } = require('./config');
const contracts = require('./contracts'); // переиспользуем недельную арифметику
const acceptances = require('./acceptances');
const weekRevert = require('./week_revert');

async function buildEmbeds(weeksAgo) {
  const range = contracts.getWeekRange(weeksAgo);
  const label = contracts.formatWeekLabel(range);
  const staffIds = await acceptances.getActiveStaffForWeek(range);

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Статистика по заявкам').setDescription(`за ${label}`);

  if (staffIds.length === 0) {
    embed.addFields({ name: '\u200b', value: 'За эту неделю принятых заявок нет.' });
  } else {
    for (const staffId of staffIds) {
      const { confirmed, disqualified } = await acceptances.getStaffWeekStats(staffId, range);
      embed.addFields({
        name: '\u200b',
        value: `<@${staffId}> — пробыло 3+ дня: **${confirmed}**, менее 3 дней: **${disqualified}**`,
      });
    }
  }

  // Отклонённые заявки за неделю — с причиной
  const rejected = await all(
    `SELECT * FROM applications WHERE status = 'rejected' AND created_at BETWEEN ? AND ? ORDER BY created_at ASC`,
    [range.start.toISOString(), range.end.toISOString()],
  );
  if (rejected.length > 0) {
    const lines = rejected.map((r) => `<@${r.discord_id}> (${r.name}) — ${r.reject_reason || 'без причины'}`).join('\n');
    embed.addFields({ name: 'Отклонённые заявки', value: lines.slice(0, 1024) });
  }

  return { range, embeds: [embed] };
}

function buildControlRows(weeksAgo) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('applications_prev_week').setLabel('◀ Пред. неделя').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('applications_this_week').setLabel('Эта неделя').setStyle(ButtonStyle.Primary).setDisabled(weeksAgo === 0),
    new ButtonBuilder().setCustomId('applications_next_week').setLabel('След. неделя ▶').setStyle(ButtonStyle.Secondary).setDisabled(weeksAgo <= 0),
  );
  return [row1];
}

async function getCurrentWeeksAgo() {
  const stored = await getSetting('applications_weeks_ago');
  return stored ? parseInt(stored, 10) : 0;
}

async function updateApplicationsStats(guild, weeksAgo = null) {
  const channel = await guild.channels.fetch(CHANNEL_CONTRACTS_STATS);
  if (!channel) return;

  const currentWeeksAgo = weeksAgo === null ? await getCurrentWeeksAgo() : weeksAgo;
  if (weeksAgo !== null) {
    await weekRevert.touchRevertTimer('applications', currentWeeksAgo);
  }

  const { embeds } = await buildEmbeds(currentWeeksAgo);
  const revertAt = await weekRevert.getRevertAt('applications');
  const line = weekRevert.revertLine(revertAt);
  if (line) embeds[embeds.length - 1].addFields({ name: '\u200b', value: line });

  const components = buildControlRows(currentWeeksAgo);

  const messageId = await getSetting('applications_stats_message_id');
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
    await setSetting('applications_stats_message_id', sent.id);
  }

  await setSetting('applications_weeks_ago', String(currentWeeksAgo));
}

async function changeApplicationsWeek(guild, direction) {
  const current = await getCurrentWeeksAgo();
  let next = current + direction;
  if (next < 0) next = 0;
  await updateApplicationsStats(guild, next);
}

async function jumpToCurrentWeek(guild) {
  await updateApplicationsStats(guild, 0);
}

async function safeUpdateApplicationsStats(guild) {
  try {
    await updateApplicationsStats(guild);
  } catch (err) {
    console.error('Не удалось обновить статистику заявок:', err);
  }
}

async function checkAndRevertIfExpired(guild) {
  if (await weekRevert.isExpired('applications')) {
    await updateApplicationsStats(guild, 0);
  }
}

module.exports = {
  updateApplicationsStats,
  changeApplicationsWeek,
  jumpToCurrentWeek,
  safeUpdateApplicationsStats,
  getCurrentWeeksAgo,
  checkAndRevertIfExpired,
};
