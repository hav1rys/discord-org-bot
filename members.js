const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { all, getSetting, setSetting } = require('./db');
const { CHANNEL_MEMBERS, ROLE_IDS } = require('./config');
const { getAllPassports } = require('./passports');
const { formatDateTime } = require('./dates');

const GROUPS_PER_PAGE = 10; // лимит embed-сообщений в одном сообщении Discord
const FIELD_ID = '№. Упоминание | Тег | ID';
const FIELD_NAME = 'Имя Фамилия';
const FIELD_PASSPORT = '№ Паспорта';

// Строит 3 инлайн-поля для одного участника: ID, Имя(-ена), Паспорт(-а).
// Если паспортов несколько — каждая строка с "-", как в примере.
async function buildParticipantFields(p, index) {
  const passports = await getAllPassports(p.discord_id);
  const multi = passports.length > 1;

  const idValue = `${index}. <@${p.discord_id}> | ${p.discord_tag} | \`${p.discord_id}\``;
  const nameValue = passports.map((pp) => (multi ? `- ${pp.name}` : pp.name)).join('\n') || p.name;
  const passportValue = passports.map((pp) => (multi ? `- ${pp.static}` : pp.static)).join('\n') || p.static;

  const statusLines = [];
  if (p.vacation_until) statusLines.push(`🏖️ В отпуске до ${formatDateTime(new Date(p.vacation_until))}`);
  if (p.afk_since) statusLines.push(`💤 AFK с ${p.afk_since}`);

  const fields = [
    { name: FIELD_ID, value: idValue.slice(0, 1024), inline: true },
    { name: FIELD_NAME, value: nameValue.slice(0, 1024), inline: true },
    { name: FIELD_PASSPORT, value: passportValue.slice(0, 1024), inline: true },
  ];
  if (statusLines.length > 0) {
    fields.push({ name: '\u200b', value: statusLines.join('\n').slice(0, 1024) });
  }
  return fields;
}

async function buildRoleEmbed(role, participants, startIndex) {
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(role ? role.name : 'Без роли')
    .setFooter({ text: `Участников: ${participants.length}` });

  if (participants.length === 0) {
    embed.addFields({ name: '\u200b', value: 'Нет участников с этой ролью' });
    return { embed, nextIndex: startIndex };
  }

  let idx = startIndex;
  let fieldCount = 0;
  const limited = [];
  // Каждый участник занимает 3-4 поля; лимит embed'а — 25 полей.
  for (const p of participants) {
    const perParticipant = p.vacation_until || p.afk_since ? 4 : 3;
    if (fieldCount + perParticipant > 25) break;
    fieldCount += perParticipant;
    limited.push(p);
  }

  for (const p of limited) {
    const fields = await buildParticipantFields(p, idx);
    embed.addFields(...fields);
    idx++;
  }

  if (limited.length < participants.length) {
    embed.setFooter({
      text: `Участников: ${participants.length}. Показаны первые ${limited.length} — используйте 🔍 «Найти» для остальных.`,
    });
    idx = startIndex + limited.length;
  }

  return { embed, nextIndex: idx };
}

async function buildAllGroupEmbeds(guild) {
  const participants = await all('SELECT * FROM participants ORDER BY name');
  const embeds = [];
  let counter = 1;

  for (const roleId of ROLE_IDS) {
    const groupMembers = participants.filter((p) => p.role_id === roleId);
    if (groupMembers.length === 0) continue;
    let role = null;
    try {
      role = await guild.roles.fetch(roleId);
    } catch (_) {
      // роль могла быть удалена с сервера
    }
    const { embed, nextIndex } = await buildRoleEmbed(role, groupMembers, counter);
    counter = nextIndex;
    embeds.push(embed);
  }

  const unassigned = participants.filter((p) => !ROLE_IDS.includes(p.role_id));
  if (unassigned.length > 0) {
    const { embed } = await buildRoleEmbed(null, unassigned, counter);
    embeds.push(embed);
  }

  if (embeds.length === 0) {
    embeds.push(new EmbedBuilder().setColor(0x2b2d31).setTitle('Список участников').setDescription('Пока нет участников.'));
  }

  return embeds;
}

function buildControlRows(page, totalPages) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('members_pick:add').setLabel('➕ Добавить').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('members_pick:kick').setLabel('🚫 Уволить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('members_pick:edit').setLabel('✏️ Изменить').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('members_pick:promote').setLabel('⬆ Повысить').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('members_pick:demote').setLabel('⬇ Понизить').setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('members_search').setLabel('🔍 Найти').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('members_prev').setLabel('◀ Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId('members_next').setLabel('Вперед ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('members_pick:passports').setLabel('📄 Паспорта').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('members_pick:vacation_grant').setLabel('🏖️ Отпуск').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('members_pick:vacation_revoke').setLabel('✅ Снять отпуск').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('members_pick:afk_set').setLabel('💤 AFK').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('members_pick:afk_revoke').setLabel('🟢 Снять AFK').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

// Отправляет или обновляет сообщение(я) со списком участников
async function updateMembersList(guild) {
  const channel = await guild.channels.fetch(CHANNEL_MEMBERS);
  if (!channel) return;

  const allEmbeds = await buildAllGroupEmbeds(guild);
  const totalPages = Math.max(1, Math.ceil(allEmbeds.length / GROUPS_PER_PAGE));

  let page = parseInt((await getSetting('members_page')) || '0', 10);
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;

  const pageEmbeds = allEmbeds.slice(page * GROUPS_PER_PAGE, page * GROUPS_PER_PAGE + GROUPS_PER_PAGE);
  const components = buildControlRows(page, totalPages);

  const messageId = await getSetting('members_message_id');
  let message = null;

  if (messageId) {
    try {
      message = await channel.messages.fetch(messageId);
    } catch (_) {
      message = null;
    }
  }

  if (message) {
    await message.edit({ embeds: pageEmbeds, components });
  } else {
    const sent = await channel.send({ embeds: pageEmbeds, components });
    await setSetting('members_message_id', sent.id);
  }

  await setSetting('members_page', String(page));
}

async function changeMembersPage(guild, direction) {
  const allEmbeds = await buildAllGroupEmbeds(guild);
  const totalPages = Math.max(1, Math.ceil(allEmbeds.length / GROUPS_PER_PAGE));
  let page = parseInt((await getSetting('members_page')) || '0', 10);
  page += direction;
  if (page < 0) page = 0;
  if (page > totalPages - 1) page = totalPages - 1;
  await setSetting('members_page', String(page));
  await updateMembersList(guild);
}

module.exports = { updateMembersList, changeMembersPage };