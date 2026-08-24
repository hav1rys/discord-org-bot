const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { all, getSetting, setSetting } = require('./db');
const { CHANNEL_BLACKLIST } = require('./config');

const FIELD_ID = '№. Упоминание | Тег | ID';
const FIELD_PASSPORT = '№ Паспорта';
const FIELD_REASON = 'Причина | Дата внесения';

function formatDate(iso) {
  const date = new Date(iso);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

// Группирует записи ЧС по discord_id, сохраняя порядок по дате внесения
// (самые старые — первыми, п. 8.8).
async function getGroupedEntries() {
  const rows = await all('SELECT * FROM blacklist ORDER BY created_at ASC, id ASC');
  const order = [];
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.discord_id)) {
      groups.set(r.discord_id, []);
      order.push(r.discord_id);
    }
    groups.get(r.discord_id).push(r);
  }
  return order.map((discordId) => ({ discordId, entries: groups.get(discordId) }));
}

function buildGroupFields(group, index) {
  const first = group.entries[0];
  const multi = group.entries.length > 1;
  const hasDiscord = !group.discordId.startsWith('nodiscord-');

  const idValue = hasDiscord
    ? `${index}. <@${group.discordId}> | ${first.discord_tag} | \`${group.discordId}\``
    : `${index}. ${first.discord_tag} | без Discord`;
  const passportValue = group.entries.map((e) => (multi ? `- ${e.static || '—'}` : (e.static || '—'))).join('\n');
  const reasonValue = group.entries
    .map((e) => (multi ? `- ${e.reason || 'без причины'} | ${formatDate(e.created_at)}` : `${e.reason || 'без причины'} | ${formatDate(e.created_at)}`))
    .join('\n');

  return [
    { name: FIELD_ID, value: idValue.slice(0, 1024), inline: true },
    { name: FIELD_PASSPORT, value: passportValue.slice(0, 1024), inline: true },
    { name: FIELD_REASON, value: reasonValue.slice(0, 1024), inline: true },
  ];
}

function buildEmbedsForGroups(groups, title, startIndex) {
  const embeds = [];
  let current = new EmbedBuilder().setColor(0xed4245).setTitle(title);
  let fieldCount = 0;
  let idx = startIndex;

  for (const group of groups) {
    if (fieldCount + 3 > 25) {
      current.setFooter({ text: `Записей: ${groups.length}` });
      embeds.push(current);
      current = new EmbedBuilder().setColor(0xed4245).setTitle(`${title} (продолжение)`);
      fieldCount = 0;
    }
    current.addFields(...buildGroupFields(group, idx));
    fieldCount += 3;
    idx++;
  }
  current.setFooter({ text: `Записей: ${groups.length}` });
  embeds.push(current);
  return { embeds, nextIndex: idx };
}

async function buildBlacklistEmbeds() {
  const groups = await getGroupedEntries();

  if (groups.length === 0) {
    return [new EmbedBuilder().setColor(0x2b2d31).setTitle('🤡 Чёрный список').setDescription('Список пуст.')];
  }

  const withDiscord = groups.filter((g) => !g.discordId.startsWith('nodiscord-'));
  const withoutDiscord = groups.filter((g) => g.discordId.startsWith('nodiscord-'));

  let embeds = [];
  let counter = 1;

  if (withDiscord.length > 0) {
    const built = buildEmbedsForGroups(withDiscord, '🤡 Чёрный список', counter);
    embeds = embeds.concat(built.embeds);
    counter = built.nextIndex;
  }

  // Люди без Discord — отдельным эмбедом/секцией (п.1)
  if (withoutDiscord.length > 0) {
    const built = buildEmbedsForGroups(withoutDiscord, '🤡 Чёрный список (без Discord)', counter);
    embeds = embeds.concat(built.embeds);
  }

  return embeds;
}

function buildControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('blacklist_add').setLabel('🚫 Внести в ЧС').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('blacklist_add_nodiscord').setLabel('🚫 Внести (без Discord)').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('blacklist_remove').setLabel('✅ Убрать из ЧС').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('blacklist_search').setLabel('🔍 Найти').setStyle(ButtonStyle.Secondary),
  );
}

async function updateBlacklist(guild) {
  const channel = await guild.channels.fetch(CHANNEL_BLACKLIST);
  if (!channel) return;

  const allEmbeds = await buildBlacklistEmbeds();
  const components = [buildControlRow()];
  const messageId = await getSetting('blacklist_message_id');
  let message = null;

  if (messageId) {
    try {
      message = await channel.messages.fetch(messageId);
    } catch (_) {
      message = null;
    }
  }

  // До 10 эмбедов в одном сообщении Discord — с запасом хватает и на
  // основной список, и на отдельную секцию "без Discord" сразу вместе,
  // без необходимости листать страницы, чтобы её увидеть.
  const payload = { embeds: allEmbeds.slice(0, 10), components };

  if (message) {
    await message.edit(payload);
  } else {
    const sent = await channel.send(payload);
    await setSetting('blacklist_message_id', sent.id);
  }
}

async function changeBlacklistPage() {
  // Постраничность больше не нужна — все секции ЧС теперь в одном
  // сообщении разом (см. updateBlacklist). Оставлено для обратной
  // совместимости с уже существующими кнопками ◀/▶.
}

module.exports = { updateBlacklist, changeBlacklistPage };
