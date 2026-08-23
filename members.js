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
const ENTRIES_PER_EMBED = 8; // 8 записей * 3 поля = 24 (лимит embed'а — 25 полей)
const FIELD_ID = '№. Упоминание | Тег | ID';
const FIELD_NAME = 'Имя Фамилия';
const FIELD_PASSPORT = '№ Паспорта';

// Собирает плоский список "паспорт-записей" по всем участникам: каждая
// запись — один конкретный паспорт (со своим рангом/отпуском/AFK), а не
// весь аккаунт целиком. Один человек с паспортами на разных рангах
// появится в нескольких разных группах ниже (п.7.1).
async function getFlatPassportEntries() {
  const participants = await all('SELECT * FROM participants ORDER BY name');
  const entries = [];
  for (const p of participants) {
    const passports = await getAllPassports(p.discord_id);
    for (const passport of passports) {
      entries.push({ participant: p, passport });
    }
  }
  return entries;
}

// Внутри ОДНОГО ранга группирует паспорта обратно по владельцу — если у
// человека несколько паспортов на этом же ранге, они идут одной записью
// (через "-"), а не отдельными строками.
function groupByParticipant(entries) {
  const order = [];
  const map = new Map();
  for (const e of entries) {
    const key = e.participant.discord_id;
    if (!map.has(key)) {
      map.set(key, { participant: e.participant, passports: [] });
      order.push(key);
    }
    map.get(key).passports.push(e.passport);
  }
  return order.map((key) => map.get(key));
}

function buildEntryFields(group, index) {
  const { participant: p, passports } = group;
  const hasDiscord = !p.discord_id.startsWith('nodiscord-');
  const idValue = hasDiscord
    ? `${index}. <@${p.discord_id}> | ${p.discord_tag} | \`${p.discord_id}\``
    : `${index}. ${p.discord_tag} | без Discord`;

  const multi = passports.length > 1;
  const nameLines = [];
  const passportLines = [];
  for (const passport of passports) {
    nameLines.push(multi ? `- ${passport.name}` : passport.name);
    passportLines.push(multi ? `- ${passport.static}` : passport.static);
    if (passport.vacation_until) nameLines.push(`🏖️ В отпуске до ${formatDateTime(new Date(passport.vacation_until))}`);
    if (passport.afk_since) nameLines.push(`💤 AFK с ${passport.afk_since}`);
  }

  return [
    { name: FIELD_ID, value: idValue.slice(0, 1024), inline: true },
    { name: FIELD_NAME, value: nameLines.join('\n').slice(0, 1024), inline: true },
    { name: FIELD_PASSPORT, value: passportLines.join('\n').slice(0, 1024), inline: true },
  ];
}

// Возвращает МАССИВ embed'ов для одного ранга — если групп больше
// ENTRIES_PER_EMBED, лишние уходят в embed "(продолжение)" того же
// сообщения, а не обрезаются с "используйте поиск" (п.1.1).
async function buildRoleEmbeds(role, entries, startIndex) {
  const groups = groupByParticipant(entries);
  const title = role ? role.name : 'Без роли';

  if (groups.length === 0) {
    const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle(title)
      .addFields({ name: '\u200b', value: 'Нет участников с этим рангом' })
      .setFooter({ text: 'Участников: 0' });
    return { embeds: [embed], nextIndex: startIndex };
  }

  const embeds = [];
  let idx = startIndex;
  for (let start = 0; start < groups.length; start += ENTRIES_PER_EMBED) {
    const chunk = groups.slice(start, start + ENTRIES_PER_EMBED);
    const partNum = Math.floor(start / ENTRIES_PER_EMBED) + 1;
    const totalParts = Math.ceil(groups.length / ENTRIES_PER_EMBED);
    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle(totalParts > 1 ? `${title} (${partNum}/${totalParts})` : title);

    for (const group of chunk) {
      embed.addFields(...buildEntryFields(group, idx));
      idx++;
    }
    embed.setFooter({ text: `Участников: ${groups.length}` });
    embeds.push(embed);
  }

  return { embeds, nextIndex: idx };
}

async function buildAllGroupEmbeds(guild) {
  const flatEntries = await getFlatPassportEntries();
  const embeds = [];
  let counter = 1;

  for (const roleId of ROLE_IDS) {
    const groupEntries = flatEntries.filter((e) => e.passport.role_id === roleId);
    if (groupEntries.length === 0) continue;
    let role = null;
    try {
      role = await guild.roles.fetch(roleId);
    } catch (_) {
      // роль могла быть удалена с сервера
    }
    const { embeds: roleEmbeds, nextIndex } = await buildRoleEmbeds(role, groupEntries, counter);
    counter = nextIndex;
    embeds.push(...roleEmbeds);
  }

  const unassigned = flatEntries.filter((e) => !ROLE_IDS.includes(e.passport.role_id));
  if (unassigned.length > 0) {
    const { embeds: unassignedEmbeds } = await buildRoleEmbeds(null, unassigned, counter);
    embeds.push(...unassignedEmbeds);
  }

  if (embeds.length === 0) {
    embeds.push(new EmbedBuilder().setColor(0x2b2d31).setTitle('Список участников').setDescription('Пока нет участников.'));
  }

  return embeds;
}

// Кнопки управления конкретным человеком (Уволить/Изменить/Повысить/
// Понизить/Паспорта/Отпуск/AFK) переехали в профиль (п.1.2.2) — здесь
// остаются только общие действия и навигация. "Найти" переименована в
// "Профиль" — теперь именно так открывается карточка человека.
function buildControlRows(page, totalPages) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('members_pick:add').setLabel('➕ Добавить').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('members_search').setLabel('👤 Профиль').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('members_prev').setLabel('◀ Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId('members_next').setLabel('Вперед ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );

  return [row1];
}

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
