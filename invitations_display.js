const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getSetting, setSetting, get: dbGet } = require('./db');
const { CHANNEL_INVITATIONS, ROLE_HR } = require('./config');
const contracts = require('./contracts'); // переиспользуем недельную арифметику
const invitations = require('./invitations');
const weekRevert = require('./week_revert');

async function buildGroupEmbeds(guild, inviterIds, range, label, title) {
  const embeds = [];
  let current = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(`за ${label}`);
  let fieldCount = 0;
  let index = 1;
  let any = false;

  for (const inviterId of inviterIds) {
    const invitees = await invitations.getInviterInviteesForWeek(inviterId, range);
    if (invitees.length === 0) continue;
    any = true;

    const inviterRow = await dbGet('SELECT discord_tag FROM participants WHERE discord_id = ?', [inviterId]);
    const inviterTag = inviterRow ? inviterRow.discord_tag : inviterId;

    const idValue = `<@${inviterId}> | ${inviterTag} | \`${inviterId}\``;
    const inviteesValue = invitees.map((inv) => `- <@${inv.invitee_discord_id}> | ${inv.invitee_name}, № ${inv.invitee_static}`).join('\n');

    if (fieldCount + 3 > 25) {
      embeds.push(current);
      current = new EmbedBuilder().setColor(0x5865f2).setTitle(`${title} (продолжение)`).setDescription(`за ${label}`);
      fieldCount = 0;
    }

    current.addFields(
      { name: '№.', value: String(index), inline: true },
      { name: 'Упоминание | Тег | ID', value: idValue.slice(0, 1024), inline: true },
      { name: 'Пригласил:', value: inviteesValue.slice(0, 1024) || '—', inline: true },
    );
    fieldCount += 3;
    index++;
  }
  embeds.push(current);
  return { embeds, any };
}

async function buildEmbeds(guild, weeksAgo) {
  const range = contracts.getWeekRange(weeksAgo);
  const label = contracts.formatWeekLabel(range);
  const inviterIds = await invitations.getActiveInvitersForWeek(range);

  if (inviterIds.length === 0) {
    return { range, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Статистика по приглашениям').setDescription(`за ${label}\n\nЗа эту неделю подтверждённых приглашений нет.`)] };
  }

  // Разделяем на HR-Менеджеров и всех остальных (п.4)
  const hrIds = [];
  const otherIds = [];
  for (const id of inviterIds) {
    let isHr = false;
    try {
      const member = await guild.members.fetch(id);
      isHr = member.roles.cache.has(ROLE_HR);
    } catch (_) {}
    (isHr ? hrIds : otherIds).push(id);
  }

  let embeds = [];

  const hrResult = await buildGroupEmbeds(guild, hrIds, range, label, '📋 Статистика по приглашениям — HR-Менеджеры');
  if (hrResult.any) embeds = embeds.concat(hrResult.embeds);

  const otherResult = await buildGroupEmbeds(guild, otherIds, range, label, 'Статистика по приглашениям');
  if (otherResult.any) embeds = embeds.concat(otherResult.embeds);

  if (embeds.length === 0) {
    embeds = [new EmbedBuilder().setColor(0x5865f2).setTitle('Статистика по приглашениям').setDescription(`за ${label}\n\nЗа эту неделю подтверждённых приглашений нет.`)];
  }

  return { range, embeds };
}

function buildControlRows(weeksAgo) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('invitations_prev_week').setLabel('◀ Пред. неделя').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('invitations_this_week').setLabel('Эта неделя').setStyle(ButtonStyle.Primary).setDisabled(weeksAgo === 0),
    new ButtonBuilder().setCustomId('invitations_next_week').setLabel('След. неделя ▶').setStyle(ButtonStyle.Secondary).setDisabled(weeksAgo <= 0),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('invitations_add').setLabel('➕ Добавить').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('invitations_remove').setLabel('➖ Удалить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('invitations_search').setLabel('🔍 Найти').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

async function getCurrentWeeksAgo() {
  const stored = await getSetting('invitations_weeks_ago');
  return stored ? parseInt(stored, 10) : 0;
}

async function updateInvitations(guild, weeksAgo = null) {
  const channel = await guild.channels.fetch(CHANNEL_INVITATIONS);
  if (!channel) return;

  const currentWeeksAgo = weeksAgo === null ? await getCurrentWeeksAgo() : weeksAgo;
  if (weeksAgo !== null) {
    await weekRevert.touchRevertTimer('invitations', currentWeeksAgo);
  }

  const { embeds } = await buildEmbeds(guild, currentWeeksAgo);
  const revertAt = await weekRevert.getRevertAt('invitations');
  const line = weekRevert.revertLine(revertAt);
  if (line) embeds[embeds.length - 1].addFields({ name: '\u200b', value: line });

  const components = buildControlRows(currentWeeksAgo);

  const messageId = await getSetting('invitations_message_id');
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
    await setSetting('invitations_message_id', sent.id);
  }

  await setSetting('invitations_weeks_ago', String(currentWeeksAgo));
}

async function changeInvitationsWeek(guild, direction) {
  const current = await getCurrentWeeksAgo();
  let next = current + direction;
  if (next < 0) next = 0;
  await updateInvitations(guild, next);
}

async function jumpToCurrentWeek(guild) {
  await updateInvitations(guild, 0);
}

async function safeUpdateInvitations(guild) {
  try {
    await updateInvitations(guild);
  } catch (err) {
    console.error('Не удалось обновить сообщение с приглашениями:', err);
  }
}

async function checkAndRevertIfExpired(guild) {
  if (await weekRevert.isExpired('invitations')) {
    await updateInvitations(guild, 0);
  }
}

module.exports = {
  updateInvitations,
  changeInvitationsWeek,
  jumpToCurrentWeek,
  safeUpdateInvitations,
  getCurrentWeeksAgo,
  checkAndRevertIfExpired,
};
