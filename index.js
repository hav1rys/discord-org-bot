require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');

const db = require('./db');
const config = require('./config');
const { logAudit } = require('./audit');
const { updateMembersList, changeMembersPage } = require('./members');
const { updateBlacklist, changeBlacklistPage } = require('./blacklist');
const perms = require('./permissions');
const passportsLib = require('./passports');
const { parseDeadline, parseDateOnly, formatDateTime, formatDateOnly } = require('./dates');
const { DEFAULT_RULES, DEFAULT_AGITATION, DEFAULT_HR_INFO } = require('./content');
const contentVersions = require('./content_versions');
const backup = require('./backup');
const faq = require('./faq');
const faqDisplay = require('./faq_display');
const contracts = require('./contracts');
const contractsDisplay = require('./contracts_display');
const invitations = require('./invitations');
const history = require('./history');
const { buildCsv } = require('./csv');
const giveaways = require('./giveaways');
const invitationsDisplay = require('./invitations_display');
const acceptances = require('./acceptances');
const applicationsDisplay = require('./applications_display');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Транзитное состояние (не хранится в БД — переживает только пока бот запущен):
// текст, ожидающий подтверждения через /rules_update и /agitation_update
const pendingUpdates = new Map(); // key: `${type}:${userId}` -> text
// причина, указанная в форме "Убрать из ЧС", до подтверждения удаления
const pendingBlacklistReasons = new Map(); // key: userId -> reason
const APPLICATION_COOLDOWN_HOURS = 6; // кулдаун на повторную заявку после отказа
const pendingBroadcasts = new Map(); // key: userId -> { text, targetId? }

// ---------- Утилиты ----------

function txt(interaction, customId, label, opts = {}) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(opts.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts.required !== false)
    .setValue(opts.value || '')
    .setMaxLength(opts.maxLength || 200);
  if (opts.placeholder) input.setPlaceholder(opts.placeholder);
  return input;
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function getRoleIndex(roleId) {
  return config.ROLE_IDS.indexOf(roleId);
}

async function safeReply(interaction, content) {
  const payload = typeof content === 'string' ? { content, flags: MessageFlags.Ephemeral } : { flags: MessageFlags.Ephemeral, ...content };
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

async function resolveGuild(interaction) {
  if (interaction.guild) return interaction.guild;
  return client.guilds.fetch(process.env.GUILD_ID);
}

const mentionOpts = { allowedMentions: { roles: config.ROLES_REVIEW_ALLOWED } };

async function getCurrentText(key, fallback) {
  const v = await contentVersions.getLatestVersion(key);
  return v ? v.content : fallback;
}

// Обновление списков не должно "ронять" саму операцию (выдачу отпуска,
// AFK и т.д.), если отрисовка embed'а вдруг упадёт — логируем и продолжаем.
async function safeUpdateMembersList(guild) {
  try {
    await updateMembersList(guild);
  } catch (err) {
    console.error('Не удалось обновить список участников:', err);
  }
}

async function safeUpdateBlacklist(guild) {
  try {
    await updateBlacklist(guild);
  } catch (err) {
    console.error('Не удалось обновить чёрный список:', err);
  }
}

// Синхронизирует и ник, и реальную роль ранга на сервере с "эффективной
// личностью", вычисленной из ВСЕХ паспортов аккаунта (см. passports.js).
// Вызывать после любого изменения, которое может повлиять на паспорта:
// добавление/удаление паспорта, изменение ранга конкретного паспорта,
// увольнение одного из паспортов.
const STATUS_LABELS = {
  pending: '⏳ На рассмотрении',
  accepted: '✅ Принято',
  rejected: '❌ Отклонено',
  confirmed: '✅ Подтверждено',
  fulfilled: '✅ Выполнен',
  unfulfilled: '❌ Не выполнен',
  disqualified: '🚫 Дисквалифицировано',
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// Имя Фамилия: "_" или несколько пробелов между словами становятся одним
// пробелом. Если слово всего одно (без фамилии) — ничего страшного,
// нормализация всё равно применяется, просто нечего схлопывать (п.1/2).
function normalizeName(input) {
  return (input || '')
    .trim()
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// № Паспорта — только цифры (без пробелов/букв/спецсимволов)
function isValidStatic(value) {
  return /^\d+$/.test((value || '').trim());
}

// Показывает select-меню выбора нового ранга. scope — либо № конкретного
// паспорта (тогда список рангов строится от ЕГО текущего ранга), либо
// 'all' (тогда список — все ранги, доступные актёру, без привязки к
// текущему рангу отдельных паспортов — проверка направления будет на
// момент применения, для каждого паспорта отдельно).
async function startRankSelection(interaction, guild, action, discordId, scope, participantName) {
  const actorIndex = perms.getActorRankIndex(interaction.member);
  const isPriv = interaction.member.id === config.OWNER_USER_ID || interaction.member.roles.cache.has(config.ROLE_ADMIN);

  let eligibleIndexes;
  if (scope === 'all') {
    eligibleIndexes = config.ROLE_IDS.map((_, i) => i).filter((i) => isPriv || i > actorIndex);
  } else {
    const passports = await passportsLib.getAllPassports(discordId);
    const passport = passports.find((p) => p.static === scope);
    if (!passport) return safeReply(interaction, 'Паспорт не найден.');
    if (!perms.canActOnRank(interaction.member, passport.role_id)) {
      return safeReply(interaction, '⛔ У вас недостаточно прав для изменения роли этого паспорта.');
    }
    const currentIndex = getRoleIndex(passport.role_id);
    if (currentIndex === -1) {
      // У паспорта ещё нет назначенного ранга (например, добавлен до того,
      // как ранг стал привязан к паспорту) — разрешаем назначить любой
      // ранг, доступный актёру, вместо того чтобы блокировать насовсем.
      eligibleIndexes = config.ROLE_IDS.map((_, i) => i).filter((i) => isPriv || i > actorIndex);
    } else {
      eligibleIndexes = config.ROLE_IDS
        .map((_, i) => i)
        .filter((i) => (action === 'promote' ? i < currentIndex : i > currentIndex))
        .filter((i) => isPriv || i > actorIndex);
    }
  }

  if (eligibleIndexes.length === 0) {
    return safeReply(interaction, 'Невозможно изменить ранг дальше (достигнута граница иерархии или недостаточно прав).');
  }

  const options = [];
  for (const i of eligibleIndexes) {
    const roleId = config.ROLE_IDS[i];
    let roleName = roleId;
    if (roleId) {
      try {
        const role = await guild.roles.fetch(roleId);
        if (role) roleName = role.name;
      } catch (_) {}
    }
    options.push(new StringSelectMenuOptionBuilder().setLabel(roleName).setValue(roleId));
  }

  const rankSelect = new StringSelectMenuBuilder()
    .setCustomId(`select_rank:${action}:${discordId}:${scope}`)
    .setPlaceholder('Выберите новый ранг')
    .addOptions(options);

  return safeReply(interaction, {
    content: `Выберите новый ранг для **${participantName}**${scope !== 'all' ? ` (паспорт № ${scope})` : ' (все паспорта)'}:`,
    components: [row(rankSelect)],
  });
}

// Роли "Отпуск"/"AFK" на сервере — общие на весь аккаунт (Discord-роль не
// может быть "частичной"). Выставляем/снимаем их по правилу: есть хотя бы
// один паспорт со статусом → роль есть; ни одного → роли нет.
async function buildProfileEmbeds(guild, discordId) {
  const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
  if (!participant) return null;
  const passports = await passportsLib.getAllPassports(discordId);
  const hasDiscord = !discordId.startsWith('nodiscord-');
  const multi = passports.length > 1;

  const idValue = hasDiscord
    ? `<@${discordId}> | ${participant.discord_tag} | \`${discordId}\``
    : `${participant.discord_tag} | без Discord`;

  const nameLines = [];
  const passportLines = [];
  const joinLeaveLines = [];

  // Все статики, которые когда-либо принадлежали этому Discord ID — нужно
  // для полного поиска заявок на увольнение по истории, не только текущих.
  const everStatics = new Set(passports.map((p) => p.static));
  for (const e of await history.getHistory(discordId)) everStatics.add(e.static);

  for (const p of passports) {
    let roleName = p.role_id || 'ранг не назначен';
    if (p.role_id) {
      try {
        const role = await guild.roles.fetch(p.role_id);
        if (role) roleName = role.name;
      } catch (_) {}
    }

    const extraDetails = [];
    if (p.profile_thread_id) {
      try {
        const channel = await guild.channels.fetch(p.profile_thread_id);
        extraDetails.push(`[Канал с отчётами](${channel.url})`);
      } catch (_) {}
    }
    if (p.vacation_until) extraDetails.push(`🏖️ В отпуске до ${formatDateTime(new Date(p.vacation_until))}`);
    if (p.afk_since) extraDetails.push(`💤 AFK с ${p.afk_since}`);

    nameLines.push(`${multi ? '- ' : ''}${p.name} | ${roleName}`);
    if (extraDetails.length) nameLines.push(extraDetails.join(' • '));

    passportLines.push(`${multi ? '- ' : ''}${p.static}`);

    const joinedEvent = await history.getLastJoined(discordId, p.static);
    const joinedDate = joinedEvent ? formatDateOnly(new Date(joinedEvent.at)) : (p.position === 0 && participant.joined_at ? formatDateOnly(new Date(participant.joined_at)) : null);

    const appQuery = p.position === 0
      ? await db.get(`SELECT message_id FROM applications WHERE discord_id = ? AND static = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1`, [discordId, p.static])
      : await db.get(`SELECT message_id FROM passport_requests WHERE discord_id = ? AND static = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1`, [discordId, p.static]);
    let joinPart = joinedDate || '—';
    if (appQuery && appQuery.message_id) {
      joinPart += `([Заявка](https://discord.com/channels/${guild.id}/${config.CHANNEL_APPLY_REVIEW}/${appQuery.message_id}))`;
    }
    joinLeaveLines.push(`${multi ? '- ' : ''}${joinPart}`);
  }

  const mainEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Профиль')
    .setDescription(`**Упоминание | Тег | ID**\n${idValue}`)
    .addFields(
      { name: 'Имя Фамилия', value: nameLines.join('\n').slice(0, 1024) || '—', inline: true },
      { name: '№ Паспорта', value: passportLines.join('\n').slice(0, 1024) || '—', inline: true },
      { name: 'Вступил/Уволился', value: joinLeaveLines.join('\n').slice(0, 1024) || '—', inline: true },
    );

  // Заявки в организацию — все, что когда-либо подавал этот Discord ID
  const allApps = await db.all('SELECT * FROM applications WHERE discord_id = ? ORDER BY id DESC LIMIT 10', [discordId]);
  if (allApps.length > 0) {
    const lines = allApps.map((a) => {
      const link = a.message_id ? `[Заявка](https://discord.com/channels/${guild.id}/${config.CHANNEL_APPLY_REVIEW}/${a.message_id})` : 'Заявка';
      return `- ${link} | ${a.name} | № ${a.static} | ${formatDateOnly(new Date(a.created_at))}`;
    });
    mainEmbed.addFields({ name: 'Заявки в организацию', value: lines.join('\n').slice(0, 1024) });
  }

  // Заявки на увольнение — по всем паспортам, которые когда-либо принадлежали этому человеку
  if (everStatics.size > 0) {
    const placeholders = [...everStatics].map(() => '?').join(',');
    const kickRows = await db.all(`SELECT * FROM kicks WHERE target_static IN (${placeholders}) ORDER BY id DESC LIMIT 10`, [...everStatics]);
    if (kickRows.length > 0) {
      const lines = kickRows.map((k) => {
        const link = k.message_id ? `[Заявка](https://discord.com/channels/${guild.id}/${config.CHANNEL_KICK_REVIEW}/${k.message_id})` : 'Заявка';
        return `- ${link} | ${k.name} | № ${k.target_static} | ${k.reason || '—'} | ${formatDateOnly(new Date(k.created_at))}`;
      });
      mainEmbed.addFields({ name: 'Заявки на увольнение', value: lines.join('\n').slice(0, 1024) });
    }
  }

  // Отпуск — самостоятельные заявки + выданные/снятые руководством напрямую
  const vacationRows = await db.all('SELECT * FROM vacations WHERE discord_id = ? ORDER BY id DESC LIMIT 10', [discordId]);
  const vacationGrants = await history.getStatusHistory(discordId, 'vacation');
  if (vacationRows.length > 0 || vacationGrants.length > 0) {
    const lines = [];
    for (const v of vacationRows) {
      const link = v.message_id ? `[Заявка](https://discord.com/channels/${guild.id}/${config.CHANNEL_VACATION_REVIEW}/${v.message_id})` : 'Заявка';
      lines.push(`${link} | ${v.reason || '—'} | ${formatDateOnly(new Date(v.created_at))} | до ${formatDateOnly(new Date(v.until))}`);
    }
    for (const g of vacationGrants) {
      const label = g.action === 'granted' ? 'Выдан руководством' : 'Снят руководством';
      const extra = g.action === 'granted' && g.until ? ` | до ${formatDateOnly(new Date(g.until))}` : '';
      lines.push(`${label} | ${g.reason || '—'} | ${formatDateOnly(new Date(g.at))}${extra}`);
    }
    mainEmbed.addFields({ name: 'Отпуск', value: lines.join('\n').slice(0, 1024) });
  }

  // AFK — своей "заявки" не существует, но выдача/снятие напрямую руководством теперь логируется
  const afkGrants = await history.getStatusHistory(discordId, 'afk');
  if (afkGrants.length > 0) {
    const lines = afkGrants.map((g) => {
      const label = g.action === 'granted' ? 'Выдан' : 'Снят';
      return `${label} | ${g.reason || '—'} | ${formatDateOnly(new Date(g.at))}`;
    });
    mainEmbed.addFields({ name: 'AFK', value: lines.join('\n').slice(0, 1024) });
  }

  const embeds = [mainEmbed];
  const MAX_WEEKS_BACK = 12;
  const MAX_WEEKS_SHOWN = 8;

  // --- Контракты по неделям (последние непустые) ---
  const contractWeeks = [];
  for (let w = 0; w < MAX_WEEKS_BACK && contractWeeks.length < MAX_WEEKS_SHOWN; w++) {
    const range = contracts.getWeekRange(w);
    const { fulfilled, unfulfilled } = await contracts.getUserWeekStats(discordId, range);
    if (fulfilled.length === 0 && unfulfilled.length === 0) continue;
    contractWeeks.push({ range, fulfilled, unfulfilled });
  }
  if (contractWeeks.length > 0) {
    const contractsEmbed = new EmbedBuilder().setColor(0x5865f2).setTitle('📄 Контракты');
    for (const cw of contractWeeks.reverse()) {
      const fLines = cw.fulfilled.map((c) => `- ${contracts.formatDate(new Date(c.submitted_at))}([Скриншот](${c.message_url}))`);
      fLines.unshift(`Всего: ${cw.fulfilled.length}`);
      const uLines = cw.unfulfilled.map((c) => `- ${contracts.formatDate(new Date(c.submitted_at))}([Скриншот](${c.message_url}))`);
      uLines.unshift(`Всего: ${cw.unfulfilled.length}`);
      contractsEmbed.addFields(
        { name: 'Неделя', value: contracts.formatWeekLabel(cw.range), inline: true },
        { name: 'Выполнение', value: fLines.join('\n').slice(0, 1024), inline: true },
        { name: 'Не выполнение', value: uLines.join('\n').slice(0, 1024), inline: true },
      );
    }
    embeds.push(contractsEmbed);
  }

  // --- Приглашения по неделям (где этот человек кого-то пригласил) ---
  const inviteWeeks = [];
  for (let w = 0; w < MAX_WEEKS_BACK && inviteWeeks.length < MAX_WEEKS_SHOWN; w++) {
    const range = contracts.getWeekRange(w);
    const invitees = await invitations.getInviterInviteesForWeek(discordId, range);
    if (invitees.length === 0) continue;
    inviteWeeks.push({ range, invitees });
  }
  if (inviteWeeks.length > 0) {
    const invitesEmbed = new EmbedBuilder().setColor(0x5865f2).setTitle('📨 Приглашения');
    for (const iw of inviteWeeks.reverse()) {
      const lines = iw.invitees.map((inv) => `- <@${inv.invitee_discord_id}> | ${inv.invitee_name} | \`${inv.invitee_discord_id}\` — ${formatDateOnly(new Date(inv.joined_at))}`);
      invitesEmbed.addFields(
        { name: 'Неделя', value: contracts.formatWeekLabel(iw.range), inline: true },
        { name: 'Пригласил', value: lines.join('\n').slice(0, 1024), inline: true },
      );
    }
    embeds.push(invitesEmbed);
  }

  // --- Проверенные заявки (для HR) по неделям ---
  const reviewWeeks = [];
  for (let w = 0; w < MAX_WEEKS_BACK && reviewWeeks.length < MAX_WEEKS_SHOWN; w++) {
    const range = contracts.getWeekRange(w);
    const accepted = await db.all(
      `SELECT * FROM applications WHERE accepted_by = ? AND status = 'accepted' AND created_at BETWEEN ? AND ? ORDER BY id`,
      [discordId, range.start.toISOString(), range.end.toISOString()],
    );
    const rejected = await db.all(
      `SELECT * FROM applications WHERE rejected_by = ? AND status = 'rejected' AND created_at BETWEEN ? AND ? ORDER BY id`,
      [discordId, range.start.toISOString(), range.end.toISOString()],
    );
    if (accepted.length === 0 && rejected.length === 0) continue;
    reviewWeeks.push({ range, accepted, rejected });
  }
  if (reviewWeeks.length > 0) {
    const reviewEmbed = new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Проверенные заявки (для HR-Менеджеров)');
    for (const rw of reviewWeeks.reverse()) {
      const aLines = rw.accepted.map((a) => {
        const link = a.message_id ? `[Заявка](https://discord.com/channels/${guild.id}/${config.CHANNEL_APPLY_REVIEW}/${a.message_id})` : 'Заявка';
        return `- ${link} | ${formatDateOnly(new Date(a.created_at))}`;
      });
      aLines.unshift(`Всего: ${rw.accepted.length}`);
      const rLines = rw.rejected.map((a) => {
        const link = a.message_id ? `[Заявка](https://discord.com/channels/${guild.id}/${config.CHANNEL_APPLY_REVIEW}/${a.message_id})` : 'Заявка';
        return `- ${link} | ${a.reject_reason || '—'} | ${formatDateOnly(new Date(a.created_at))}`;
      });
      rLines.unshift(`Всего: ${rw.rejected.length}`);
      reviewEmbed.addFields(
        { name: 'Неделя', value: contracts.formatWeekLabel(rw.range), inline: true },
        { name: 'Принятые | Дата', value: aLines.join('\n').slice(0, 1024), inline: true },
        { name: 'Не принятые | Причина | Дата', value: rLines.join('\n').slice(0, 1024), inline: true },
      );
    }
    embeds.push(reviewEmbed);
  }

  return embeds;
}

function buildProfileComponents(discordId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile_action:kick:${discordId}`).setLabel('🚫 Уволить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`profile_action:edit:${discordId}`).setLabel('✏️ Изменить').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`profile_action:promote:${discordId}`).setLabel('⬆ Повысить').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`profile_action:demote:${discordId}`).setLabel('⬇ Понизить').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`profile_action:passports:${discordId}`).setLabel('📄 Паспорта').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile_action:vacation_grant:${discordId}`).setLabel('🏖️ Отпуск').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`profile_action:vacation_revoke:${discordId}`).setLabel('✅ Снять отпуск').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`profile_action:afk_set:${discordId}`).setLabel('💤 AFK').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`profile_action:afk_revoke:${discordId}`).setLabel('🟢 Снять AFK').setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

// Раз в час (вызывается из общего таймера) — шлёт ЛС, если чей-то отпуск
// заканчивается менее чем через сутки, и ещё не напоминали про именно этот
// отпуск (проверяется по discordId+паспорт+точная дата окончания).
// Раз в неделю (проверяется из часового таймера) — напоминает HR/руководству
// проверить накопившиеся заявки, если они есть.
async function checkHrReminder(guild) {
  const lastReminder = await db.getSetting('hr_reminder_last_sent');
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if (lastReminder && Date.now() - new Date(lastReminder).getTime() < weekMs) return;

  const pendingRow = await db.get(`SELECT COUNT(*) as cnt FROM applications WHERE status = 'pending'`);
  const count = pendingRow ? pendingRow.cnt : 0;
  if (count === 0) return;

  try {
    const channel = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW);
    await channel.send({
      content: perms.mentionManagementRoles(),
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('📋 Напоминание: непроверенные заявки').setDescription(`В очереди сейчас **${count}** заявок на рассмотрение — загляните, пожалуйста.`)],
      ...mentionOpts,
    });
  } catch (err) {
    console.error('Не удалось отправить еженедельное напоминание HR:', err.message);
  }

  await db.setSetting('hr_reminder_last_sent', new Date().toISOString());
}

async function checkVacationReminders(guild) {
  const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const participants = await db.all('SELECT discord_id, static, name, vacation_until FROM participants WHERE vacation_until IS NOT NULL');
  const extras = await db.all('SELECT discord_id, static, name, vacation_until FROM extra_passports WHERE vacation_until IS NOT NULL');
  const candidates = [...participants, ...extras];

  for (const c of candidates) {
    const untilMs = new Date(c.vacation_until).getTime();
    const msLeft = untilMs - now;
    if (msLeft <= 0 || msLeft > REMINDER_WINDOW_MS) continue;

    const already = await db.get(
      'SELECT id FROM vacation_reminders_sent WHERE discord_id = ? AND static = ? AND until = ?',
      [c.discord_id, c.static, c.vacation_until],
    );
    if (already) continue;

    await dmUser(guild, c.discord_id, `⏰ Напоминание: ваш отпуск (${c.name}, № ${c.static}) заканчивается ${formatDateTime(new Date(c.vacation_until))} — меньше чем через сутки.`);
    await db.run(
      'INSERT INTO vacation_reminders_sent (discord_id, static, until, sent_at) VALUES (?, ?, ?, ?)',
      [c.discord_id, c.static, c.vacation_until, new Date().toISOString()],
    );
  }
}

async function syncStatusRoles(guild, discordId) {
  const passports = await passportsLib.getAllPassports(discordId);
  const hasVacation = passports.some((p) => p.vacation_until);
  const hasAfk = passports.some((p) => p.afk_since);

  try {
    const member = await guild.members.fetch(discordId);
    if (hasVacation) await member.roles.add(config.ROLE_VACATION).catch(() => {});
    else await member.roles.remove(config.ROLE_VACATION).catch(() => {});
    if (hasAfk) await member.roles.add(config.ROLE_AFK).catch(() => {});
    else await member.roles.remove(config.ROLE_AFK).catch(() => {});
  } catch (_) {
    // участника нет на сервере
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDirSize(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    } else {
      try {
        total += fs.statSync(fullPath).size;
      } catch (_) {}
    }
  }
  return total;
}

async function syncEffectiveIdentity(guild, discordId) {
  const identity = await passportsLib.computeEffectiveIdentity(discordId);
  if (!identity) return;

  try {
    const member = await guild.members.fetch(discordId);
    await member.setNickname(`${identity.name} | ${identity.static}`);
  } catch (err) {
    console.error(`Не удалось изменить ник для ${discordId}:`, err.message);
  }

  if (identity.roleId) {
    try {
      const member = await guild.members.fetch(discordId);
      const rolesToRemove = config.ROLE_IDS.filter((r) => r !== identity.roleId);
      await member.roles.remove(rolesToRemove).catch(() => {});
      await member.roles.add(identity.roleId);
    } catch (err) {
      console.error(`Не удалось синхронизировать роль ранга для ${discordId}:`, err.message);
    }
  }
}

// Создаёт приватный пост-ветку в форуме контрактов для нового участника.
// Видна только ему самому + руководству (ROLES_MEMBERS_LIST_ALLOWED) + владельцу.
// Создаёт приватный ТЕКСТОВЫЙ канал-профиль (не пост в форуме — Discord не
// поддерживает индивидуальные права доступа для отдельных тредов/постов,
// только обычные каналы умеют permissionOverwrites). Виден только самому
// участнику + руководству (ROLES_REVIEW_ALLOWED) + владельцу.
function buildProfileChannelName(discordTag, name, staticValue) {
  return `${discordTag}-${name}-${staticValue}`
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

// Переименовывает профиль-канал под текущую "эффективную личность" (тег +
// имя + паспорт по правилам 7.2) — вызывать после любого изменения
// паспортов/рангов, которое может сдвинуть эффективную личность.
async function syncProfileChannelName(guild, discordId, staticValue) {
  if (!staticValue) return; // без конкретного паспорта переименовывать нечего
  try {
    const passports = await passportsLib.getAllPassports(discordId);
    const passport = passports.find((p) => p.static === staticValue);
    if (!passport || !passport.profile_thread_id) return;
    const participant = await db.get('SELECT discord_tag FROM participants WHERE discord_id = ?', [discordId]);
    const discordTag = participant ? participant.discord_tag : discordId;
    const channel = await guild.channels.fetch(passport.profile_thread_id);
    const newName = buildProfileChannelName(discordTag, passport.name, passport.static) || channel.name;
    if (channel.name !== newName) await channel.setName(newName);
  } catch (err) {
    console.error(`Не удалось переименовать профиль-канал (паспорт ${staticValue}) для ${discordId}:`, err.message);
  }
}

async function createProfileThread(guild, discordId, name, staticValue) {
  try {
    const existing = await db.get('SELECT * FROM profile_channels WHERE static = ?', [staticValue]);

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: guild.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageChannels,
        ],
      },
      {
        id: discordId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      { id: config.OWNER_USER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    for (const roleId of config.ROLES_REVIEW_ALLOWED) {
      overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    // Уже есть архивный канал для этого ИМЕННО паспорта — восстанавливаем
    // его вместо создания нового (п.1.4)
    if (existing) {
      try {
        const channel = await guild.channels.fetch(existing.channel_id);
        await channel.setParent(config.CHANNEL_PROFILES_ACTIVE_CATEGORY, { lockPermissions: false });
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false });
        await channel.permissionOverwrites.edit(guild.client.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true });
        await channel.permissionOverwrites.edit(discordId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
        await channel.permissionOverwrites.edit(config.OWNER_USER_ID, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        for (const roleId of config.ROLES_REVIEW_ALLOWED) {
          await channel.permissionOverwrites.edit(roleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        }
        await db.run('UPDATE profile_channels SET status = ?, discord_id = ?, updated_at = ? WHERE static = ?', ['active', discordId, new Date().toISOString(), staticValue]);
        await passportsLib.setPassportChannel(discordId, staticValue, channel.id);
        await channel.send({
          content: `<@${discordId}> — 📸 С возвращением, **${name}**! Профиль восстановлен.`,
          components: [row(new ButtonBuilder().setCustomId(`my_profile:${discordId}`).setLabel('👤 Мой профиль').setStyle(ButtonStyle.Secondary))],
        });
        return channel.url;
      } catch (err) {
        console.error(`Не удалось восстановить профиль-канал для паспорта ${staticValue}, создаю новый:`, err.message);
      }
    }

    let discordTag = discordId;
    try {
      const member = await guild.members.fetch(discordId);
      discordTag = member.user.tag;
    } catch (_) {}

    const channelName = buildProfileChannelName(discordTag, name, staticValue) || `profile-${staticValue}`;

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: config.CHANNEL_PROFILES_ACTIVE_CATEGORY,
      permissionOverwrites: overwrites,
      topic: `Профиль ${name} (№ ${staticValue}) — сюда присылаются скриншоты контрактов`,
    });

    await channel.send({
      content:
        `<@${discordId}> — 📸 Профиль **${name}** (№ ${staticValue}).\n\n` +
        `Сюда нужно присылать скриншоты **на весь экран** по каждому контракту — 2 штуки:\n` +
        `1️⃣ когда вы **взяли** контракт\n` +
        `2️⃣ когда контракт **выполнен или не выполнен**\n\n` +
        `Можно прислать оба скриншота одним сообщением, можно — двумя сообщениями подряд (по одному). ` +
        `После того как оба скриншота собраны, бот сам создаст карточку контракта на проверку руководству.`,
      components: [row(new ButtonBuilder().setCustomId(`my_profile:${discordId}`).setLabel('👤 Мой профиль').setStyle(ButtonStyle.Secondary))],
    });

    await db.run(
      `INSERT INTO profile_channels (discord_id, static, channel_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(static) DO UPDATE SET discord_id = excluded.discord_id, channel_id = excluded.channel_id, status = 'active', updated_at = excluded.updated_at`,
      [discordId, staticValue, channel.id, 'active', new Date().toISOString(), new Date().toISOString()],
    );
    await passportsLib.setPassportChannel(discordId, staticValue, channel.id);
    return channel.url;
  } catch (err) {
    console.error(`Не удалось создать профиль-канал для паспорта ${staticValue} (${discordId}):`, err.message);
    return null;
  }
}

// ---------- Модальные окна ----------

function buildApplicationModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Заявка на вступление');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { value: prefill.name })),
    row(txt(null, 'static', '№ Паспорта', { value: prefill.static })),
    row(txt(null, 'lvl', 'LVL персонажа', { value: prefill.lvl ? String(prefill.lvl) : '' })),
    row(txt(null, 'skills', 'Навыки/Профессии', { value: prefill.skills, placeholder: 'Ссылка на скриншот' })),
    row(txt(null, 'invited_by', 'Кто вас пригласил', {
      value: prefill.invited_by,
      required: false,
      paragraph: true,
      placeholder: 'Имя Фамилия ИЛИ №Паспорта ИЛИ Дискорд тег/id человека который вас пригласил',
    })),
  );
  return modal;
}

function buildKickApplicationModal(customId, prefill = {}, includeStaticField = false) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Заявка на увольнение');
  modal.addComponents(row(txt(null, 'name', 'Имя Фамилия участника', { value: prefill.name })));
  if (includeStaticField) {
    modal.addComponents(row(txt(null, 'target_static', '№ Паспорта (пусто = уволить все)', { value: prefill.target_static, required: false })));
  }
  modal.addComponents(row(txt(null, 'reason', 'Причина', { value: prefill.reason, required: false, paragraph: true })));
  return modal;
}

function buildMemberModal(customId, prefill = {}, ownerMode = false) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Данные участника');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { value: prefill.name, required: !ownerMode })),
    row(txt(null, 'discord_id', 'Discord ID', {
      value: prefill.discord_id,
      required: false,
      placeholder: 'Оставьте пустым, если у человека нет Discord',
    })),
    row(txt(null, 'static', '№ Паспорта', { value: prefill.static, required: !ownerMode })),
    row(txt(null, 'lvl', 'LVL персонажа', { value: prefill.lvl ? String(prefill.lvl) : '', required: false })),
    row(txt(null, 'online', 'Онлайн в неделю (часов)', { value: prefill.online, required: false })),
  );
  return modal;
}

function buildSearchModal() {
  const modal = new ModalBuilder().setCustomId('modal_search').setTitle('Поиск участника');
  modal.addComponents(
    row(txt(null, 'discord_tag', 'Discord тег', { required: false })),
    row(txt(null, 'discord_id', 'Discord ID', { required: false })),
    row(txt(null, 'name', 'Имя Фамилия', { required: false })),
    row(txt(null, 'static', '№ Паспорта', { required: false })),
  );
  return modal;
}

function buildPickSearchModal(action) {
  const modal = new ModalBuilder().setCustomId(`modal_pick_search:${action}`).setTitle('Выбор участника');
  modal.addComponents(
    row(txt(null, 'query', 'Имя Фамилия, № Паспорта, тег или ID (необяз.)', { required: false })),
  );
  return modal;
}

function buildRejectReasonModal(customId) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Причина отказа');
  modal.addComponents(row(txt(null, 'reason', 'Причина', { paragraph: true })));
  return modal;
}

function buildDataChangeModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Изменить данные (Имя Фамилия)');
  modal.addComponents(row(txt(null, 'new_name', 'Новое Имя Фамилия', { value: prefill.new_name })));
  return modal;
}

function buildDataChangeEmbed(reqRow) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на изменение данных #${reqRow.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${reqRow.discord_id}> (${reqRow.discord_tag})` },
      { name: '№ Паспорта', value: reqRow.target_static || '—', inline: true },
      { name: 'Было', value: reqRow.old_name || '—', inline: true },
      { name: 'Станет', value: reqRow.new_name || '—', inline: true },
      { name: 'Статус', value: statusLabel(reqRow.status) },
    );
  if (reqRow.reject_reason) embed.addFields({ name: 'Причина отказа', value: reqRow.reject_reason });
  return embed;
}

function buildDataChangeComponents(reqRow) {
  if (reqRow.status !== 'pending') return [];
  return [row(
    new ButtonBuilder().setCustomId(`data_change_accept:${reqRow.id}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`data_change_reject:${reqRow.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
  )];
}

function buildHrApplyModal() {
  const modal = new ModalBuilder().setCustomId('modal_hr_apply').setTitle('Заявка на роль HR-Менеджера');
  modal.addComponents(
    row(txt(null, 'hours_per_week', 'Часов в неделю игре')),
    row(txt(null, 'training_ready', 'Когда готовы пройти мини-обучение')),
  );
  return modal;
}

function buildHrApplyEmbed(reqRow) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на роль HR-Менеджера #${reqRow.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${reqRow.discord_id}> (${reqRow.discord_tag})` },
      { name: 'Часов в неделю', value: reqRow.hours_per_week || '—', inline: true },
      { name: 'Готов к обучению', value: reqRow.training_ready || '—', inline: true },
      { name: 'Статус', value: statusLabel(reqRow.status) },
    );
  if (reqRow.reject_reason) embed.addFields({ name: 'Причина отказа', value: reqRow.reject_reason });
  return embed;
}

function buildHrApplyComponents(reqRow) {
  if (reqRow.status !== 'pending') return [];
  return [row(
    new ButtonBuilder().setCustomId(`hr_apply_accept:${reqRow.id}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hr_apply_reject:${reqRow.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
  )];
}

function buildPassportRequestModal(prefill = {}) {
  const modal = new ModalBuilder().setCustomId('modal_passport_request').setTitle('Заявка на добавление паспорта');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { value: prefill.name })),
    row(txt(null, 'static', '№ Паспорта', { value: prefill.static })),
  );
  return modal;
}

function buildPassportRequestEmbed(reqRow) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на добавление паспорта #${reqRow.id}`)
    .addFields(
      { name: 'Участник', value: `<@${reqRow.discord_id}> (${reqRow.discord_tag})` },
      { name: 'Имя Фамилия', value: reqRow.name || '—', inline: true },
      { name: '№ Паспорта', value: reqRow.static || '—', inline: true },
      { name: 'Статус', value: statusLabel(reqRow.status) },
    );
  if (reqRow.reject_reason) embed.addFields({ name: 'Причина отказа', value: reqRow.reject_reason });
  return embed;
}

function buildPassportRequestComponents(reqRow) {
  if (reqRow.status !== 'pending') return [];
  return [row(
    new ButtonBuilder().setCustomId(`passport_request_accept:${reqRow.id}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`passport_request_reject:${reqRow.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
  )];
}

function buildFaqModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Гайд FAQ');
  modal.addComponents(
    row(txt(null, 'title', 'Заголовок', { value: prefill.title })),
    row(txt(null, 'content', 'Текст гайда', { value: prefill.content, paragraph: true, maxLength: 4000 })),
  );
  return modal;
}

function buildManualContractModal(status, discordId) {
  const modal = new ModalBuilder().setCustomId(`modal_contract_manual:${status}:${discordId}`).setTitle('Добавить контракт вручную');
  modal.addComponents(
    row(txt(null, 'link', 'Ссылка на скриншот')),
    row(txt(null, 'date', 'Дата (ДД.ММ.ГГГГ), пусто = сегодня', { required: false })),
  );
  return modal;
}

function buildVacationSelfModal() {
  const modal = new ModalBuilder().setCustomId('modal_vacation_apply').setTitle('Заявка на отпуск');
  modal.addComponents(
    row(txt(null, 'deadline', 'Дата (ДД.ММ.ГГГГ) или срок (7d)')),
    row(txt(null, 'reason', 'Причина (необязательно)', { required: false, paragraph: true })),
  );
  return modal;
}

function buildVacationGrantModal(discordId, staticsCsv) {
  const customId = staticsCsv ? `modal_vacation_grant:${discordId}:${staticsCsv}` : `modal_vacation_grant:${discordId}`;
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Выдать отпуск');
  modal.addComponents(
    row(txt(null, 'deadline', 'Дата (ДД.ММ.ГГГГ) или срок (7d)')),
    row(txt(null, 'reason', 'Причина', { required: false })),
  );
  return modal;
}

function buildAfkModal(discordId, staticsCsv) {
  const customId = staticsCsv ? `modal_afk_set:${discordId}:${staticsCsv}` : `modal_afk_set:${discordId}`;
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Указать AFK');
  modal.addComponents(
    row(txt(null, 'date', 'Дата с которой AFK (ДД.ММ.ГГГГ)')),
    row(txt(null, 'reason', 'Причина', { required: false })),
  );
  return modal;
}

function buildPassportModal(discordId) {
  const modal = new ModalBuilder().setCustomId(`modal_passport_add:${discordId}`).setTitle('Добавить паспорт');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия')),
    row(txt(null, 'static', '№ Паспорта')),
  );
  return modal;
}

function buildBlacklistAddModal() {
  const modal = new ModalBuilder().setCustomId('modal_blacklist_add').setTitle('Внести в чёрный список');
  modal.addComponents(
    row(txt(null, 'discord_id', 'Discord ID')),
    row(txt(null, 'static', '№ Паспорта', { required: false })),
    row(txt(null, 'reason', 'Причина', { required: false, paragraph: true })),
  );
  return modal;
}

function buildBlacklistAddNoDiscordModal() {
  const modal = new ModalBuilder().setCustomId('modal_blacklist_add_nodiscord').setTitle('Внести в ЧС (без Discord)');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { required: false })),
    row(txt(null, 'static', '№ Паспорта')),
    row(txt(null, 'reason', 'Причина', { required: false, paragraph: true })),
  );
  return modal;
}

function buildBlacklistRemoveModal() {
  const modal = new ModalBuilder().setCustomId('modal_blacklist_remove').setTitle('Убрать из чёрного списка');
  modal.addComponents(
    row(txt(null, 'query', 'Discord ID или № Паспорта')),
    row(txt(null, 'reason', 'Причина снятия', { required: false, paragraph: true })),
  );
  return modal;
}

// ---------- Слэш-команды ----------

const commands = [
  new SlashCommandBuilder()
    .setName('init_menus')
    .setDescription('Инициализировать меню заявок и список участников'),
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Отправить текущий свод правил в канал правил'),
  new SlashCommandBuilder()
    .setName('rules_update')
    .setDescription('Обновить свод правил'),
  new SlashCommandBuilder()
    .setName('rules_broadcast')
    .setDescription('Разослать свод правил в ЛС — всем в организации или одному человеку')
    .addStringOption((opt) =>
      opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID — если пусто, отправит всем').setRequired(false).setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('broadcast_message')
    .setDescription('Отправить произвольное сообщение в ЛС от имени бота — всем или одному человеку'),
  new SlashCommandBuilder()
    .setName('agitation')
    .setDescription('Отправить текущую агитацию в канал агитации'),
  new SlashCommandBuilder()
    .setName('agitation_update')
    .setDescription('Обновить текст агитации'),
  new SlashCommandBuilder()
    .setName('hr_info')
    .setDescription('Отправить текущее описание вакансии HR-Менеджера в канал'),
  new SlashCommandBuilder()
    .setName('hr_info_update')
    .setDescription('Обновить описание вакансии HR-Менеджера'),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Проверить скорость отклика бота (Discord, база данных)'),
  new SlashCommandBuilder()
    .setName('backfill_profiles')
    .setDescription('Создать каналы-профили для всех, у кого их ещё нет, и заполнить дату вступления'),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Полная история вступлений/увольнений человека')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('contracts_leaderboard')
    .setDescription('Топ по контрактам за всё время'),
  new SlashCommandBuilder()
    .setName('audit_search')
    .setDescription('Поиск по логу аудита')
    .addStringOption((opt) => opt.setName('запрос').setDescription('Текст для поиска в действии/деталях/инициаторе').setRequired(true)),
  new SlashCommandBuilder()
    .setName('whois')
    .setDescription('Быстрый поиск участника')
    .addStringOption((opt) => opt.setName('запрос').setDescription('№ Паспорта / Discord тег / Имя Фамилия').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('export_stats')
    .setDescription('Выгрузить статистику текущей недели (контракты/приглашения/заявки) в .csv'),
  new SlashCommandBuilder()
    .setName('send_report_channels')
    .setDescription('Отправить в ЛС ссылки на каналы с отчётами — одному человеку или всем в организации')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID — если пусто, отправит всем').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('org_stats')
    .setDescription('Общая сводка по организации: люди, отпуск/AFK, контракты за неделю, очередь заявок'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Проверка здоровья бота: БД, доступ к ключевым каналам, время работы'),
  new SlashCommandBuilder()
    .setName('export_ids')
    .setDescription('Выгрузить названия и ID всех каналов и ролей сервера в файл'),
  new SlashCommandBuilder()
    .setName('giveaway_start')
    .setDescription('Запустить розыгрыш')
    .addStringOption((opt) => opt.setName('приз').setDescription('Что разыгрывается').setRequired(true))
    .addStringOption((opt) => opt.setName('длительность').setDescription('Например: 30m, 2h, 1d, 1w').setRequired(true))
    .addIntegerOption((opt) => opt.setName('победителей').setDescription('Сколько победителей').setRequired(true).setMinValue(1))
    .addChannelOption((opt) => opt.setName('канал').setDescription('Куда отправить (по умолчанию — этот канал)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('giveaway_end')
    .setDescription('Досрочно завершить розыгрыш и выбрать победителей')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш завершить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('giveaway_reroll')
    .setDescription('Выбрать новых победителей уже завершённого розыгрыша')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш перевыбрать').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('giveaway_cancel')
    .setDescription('Отменить розыгрыш без выбора победителей')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш отменить').setRequired(true).setAutocomplete(true)),
  // Доступ ограничивается не через Discord-права, а проверкой роли/прав
  // в обработчике ниже — так гарантированно работает независимо от
  // настроек интеграций на сервере.
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;
  if (!clientId) {
    console.warn('CLIENT_ID не задан — слэш-команды не будут зарегистрированы.');
    return;
  }
  if (guildId) {
    // Если раньше (до того, как появился GUILD_ID) команды успели
    // зарегистрироваться ГЛОБАЛЬНО — они годами висят рядом с серверными
    // и дублируются в списке команд. Чистим их сами при каждом старте —
    // это дешёвая операция (пустой массив), полностью безопасно гонять
    // на каждом запуске.
    try {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
    } catch (err) {
      console.error('Не удалось очистить старые глобальные команды:', err.message);
    }
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }
}

async function sendFaqManagePanel(guild) {
  const channel = await guild.channels.fetch(config.CHANNEL_FAQ_MANAGE);
  if (!channel) return;

  const messageId = await db.getSetting('faq_manage_message_id');
  if (messageId) {
    try {
      await channel.messages.fetch(messageId);
      return; // панель уже есть, повторно не отправляем
    } catch (_) {
      // сообщение удалили — отправим новое
    }
  }

  const sent = await channel.send({
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Управление гайдами FAQ').setDescription('Добавление/изменение/удаление гайдов для каналов FAQ участников и HR-Менеджеров.')],
    components: [row(
      new ButtonBuilder().setCustomId('faq_add').setLabel('➕ Добавить гайд').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('faq_edit').setLabel('✏️ Изменить гайд').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('faq_delete').setLabel('➖ Удалить гайд').setStyle(ButtonStyle.Danger),
    )],
  });
  await db.setSetting('faq_manage_message_id', sent.id);
}

// Отправляет меню один раз и запоминает его id в settings — при повторном
// /init_menus редактирует то же сообщение вместо отправки нового (п.1).
function buildGiveawayEmbed(giveaway, entryCount, ended = false, winners = null) {
  const endsAtSec = Math.floor(new Date(giveaway.ends_at).getTime() / 1000);
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x2b2d31 : 0x57f287)
    .setTitle(`🎉 ${giveaway.prize}`)
    .setDescription(
      ended
        ? `Розыгрыш завершён.`
        : `Нажмите на кнопку ниже, чтобы участвовать!\nОрганизатор: <@${giveaway.host_id}>`,
    )
    .addFields(
      { name: 'Победителей', value: String(giveaway.winners_count), inline: true },
      { name: 'Участников', value: String(entryCount), inline: true },
      { name: ended ? 'Завершился' : 'Закончится', value: `<t:${endsAtSec}:R>`, inline: true },
    );
  if (ended) {
    embed.addFields({
      name: 'Победители',
      value: winners && winners.length > 0 ? winners.map((w) => `<@${w}>`).join(', ') : 'Никто не участвовал 😔',
    });
  }
  return embed;
}

function buildGiveawayComponents(giveawayId, ended = false) {
  return [row(
    new ButtonBuilder().setCustomId(`giveaway_enter:${giveawayId}`).setLabel('🎉 Участвовать').setStyle(ButtonStyle.Success).setDisabled(ended),
  )];
}

async function endGiveaway(guild, giveawayId, actor = null) {
  const giveaway = await giveaways.getGiveaway(giveawayId);
  if (!giveaway || giveaway.status !== 'active') return [];

  const entries = await giveaways.getEntries(giveawayId);
  const winners = giveaways.pickWinners(entries, giveaway.winners_count);
  await giveaways.setStatus(giveawayId, 'ended');

  try {
    const channel = await guild.channels.fetch(giveaway.channel_id);
    const embed = buildGiveawayEmbed(giveaway, entries.length, true, winners);
    try {
      const msg = await channel.messages.fetch(giveaway.message_id);
      await msg.edit({ embeds: [embed], components: buildGiveawayComponents(giveawayId, true) });
    } catch (_) {}

    if (winners.length > 0) {
      await channel.send(`🎉 Поздравляем ${winners.map((w) => `<@${w}>`).join(', ')} — вы выиграли **${giveaway.prize}**!`);
    } else {
      await channel.send(`😔 Розыгрыш «${giveaway.prize}» завершён — участников не было.`);
    }
  } catch (err) {
    console.error('Не удалось объявить итоги розыгрыша:', err.message);
  }

  await logAudit(
    guild,
    actor || client.user,
    actor ? 'Розыгрыш завершён вручную' : 'Розыгрыш завершён (автоматически по таймеру)',
    `«${giveaway.prize}», участников: ${entries.length}, победителей: ${winners.length}${winners.length > 0 ? ` (${winners.map((w) => `<@${w}>`).join(', ')})` : ''}`,
  );

  return winners;
}

async function cancelGiveaway(guild, giveawayId, actor) {
  const giveaway = await giveaways.getGiveaway(giveawayId);
  if (!giveaway || giveaway.status !== 'active') return false;

  await giveaways.setStatus(giveawayId, 'cancelled');

  try {
    const channel = await guild.channels.fetch(giveaway.channel_id);
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`🎉 ${giveaway.prize}`)
      .setDescription('❌ Розыгрыш отменён.');
    try {
      const msg = await channel.messages.fetch(giveaway.message_id);
      await msg.edit({ embeds: [embed], components: buildGiveawayComponents(giveawayId, true) });
    } catch (_) {}
    await channel.send(`❌ Розыгрыш «${giveaway.prize}» отменён.`);
  } catch (err) {
    console.error('Не удалось объявить отмену розыгрыша:', err.message);
  }

  await logAudit(guild, actor || client.user, 'Розыгрыш отменён', `«${giveaway.prize}»`);
  return true;
}

async function rerollGiveaway(guild, giveawayId, actor) {
  const giveaway = await giveaways.getGiveaway(giveawayId);
  if (!giveaway || giveaway.status !== 'ended') return [];

  const entries = await giveaways.getEntries(giveawayId);
  const winners = giveaways.pickWinners(entries, giveaway.winners_count);

  try {
    const channel = await guild.channels.fetch(giveaway.channel_id);
    if (winners.length > 0) {
      await channel.send(`🔁 Новые победители розыгрыша «${giveaway.prize}»: ${winners.map((w) => `<@${w}>`).join(', ')}!`);
    } else {
      await channel.send(`🔁 Реролл «${giveaway.prize}» — участников нет.`);
    }
  } catch (err) {
    console.error('Не удалось объявить реролл розыгрыша:', err.message);
  }

  await logAudit(
    guild,
    actor || client.user,
    'Розыгрыш перевыбран',
    `«${giveaway.prize}», новых победителей: ${winners.length}${winners.length > 0 ? ` (${winners.map((w) => `<@${w}>`).join(', ')})` : ''}`,
  );

  return winners;
}

async function sendOrEditMenu(channel, settingKey, payload) {
  const messageId = await db.getSetting(settingKey);
  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(payload);
      return msg;
    } catch (_) {
      // сообщение удалили вручную — отправим новое ниже
    }
  }
  const sent = await channel.send(payload);
  await db.setSetting(settingKey, sent.id);
  return sent;
}

// Оборачивает один шаг инициализации так, чтобы ошибка в нём (например,
// канал ещё не создан на сервере или бот не видит его) не остановила
// выполнение остальных шагов — раньше именно это и происходило: если
// initMenus падал на любом шаге, всё, что шло ПОСЛЕ (включая статистику
// контрактов), просто не выполнялось (п.6).
async function safeInitStep(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`/init_menus: не удалось выполнить шаг «${label}»:`, err.message);
  }
}

async function initMenus(guild) {
  await safeInitStep('канал вступления', async () => {
    const applyChannel = await guild.channels.fetch(config.CHANNEL_APPLY_MENU);
    await sendOrEditMenu(applyChannel, 'apply_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Вступление в организацию').setDescription('Нажмите кнопку ниже, чтобы подать заявку на вступление.')],
      components: [row(new ButtonBuilder().setCustomId('apply_submit').setLabel('📝 Подать заявку').setStyle(ButtonStyle.Success))],
    });
  });

  await safeInitStep('канал увольнения', async () => {
    const kickChannel = await guild.channels.fetch(config.CHANNEL_KICK_MENU);
    await sendOrEditMenu(kickChannel, 'kick_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Заявка на увольнение').setDescription('Нажмите кнопку ниже, чтобы подать заявку на увольнение участника.')],
      components: [row(new ButtonBuilder().setCustomId('kick_submit').setLabel('🚫 Подать заявку на увольнение').setStyle(ButtonStyle.Danger))],
    });
  });

  await safeInitStep('канал отпуска', async () => {
    const vacationChannel = await guild.channels.fetch(config.CHANNEL_VACATION_MENU);
    await sendOrEditMenu(vacationChannel, 'vacation_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Отпуск').setDescription('Нажмите кнопку ниже, чтобы подать заявку на отпуск.')],
      components: [row(new ButtonBuilder().setCustomId('vacation_apply').setLabel('🏖️ Подать заявку на отпуск').setStyle(ButtonStyle.Primary))],
    });
  });

  await safeInitStep('канал изменения данных', async () => {
    const dataChangeChannel = await guild.channels.fetch(config.CHANNEL_DATA_CHANGE_MENU);
    await sendOrEditMenu(dataChangeChannel, 'data_change_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Изменение данных').setDescription('Нажмите кнопку ниже, чтобы подать заявку на изменение Имени Фамилии по одному из ваших паспортов.')],
      components: [row(new ButtonBuilder().setCustomId('data_change_apply').setLabel('✏️ Изменить данные').setStyle(ButtonStyle.Primary))],
    });
  });

  await safeInitStep('канал заявки на HR', async () => {
    const hrApplyChannel = await guild.channels.fetch(config.CHANNEL_HR_APPLY_MENU);
    const hrText = await getCurrentText('hr_info', DEFAULT_HR_INFO);
    await sendOrEditMenu(hrApplyChannel, 'hr_apply_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(hrText)],
      components: [row(new ButtonBuilder().setCustomId('hr_apply_submit').setLabel('📝 Подать заявку на HR').setStyle(ButtonStyle.Success))],
    });
  });

  await safeInitStep('список участников', () => safeUpdateMembersList(guild));
  await safeInitStep('чёрный список', () => safeUpdateBlacklist(guild));
  await safeInitStep('статистика по контрактам', () => contractsDisplay.safeUpdateContractsStats(guild));
  await safeInitStep('статистика по приглашениям', () => invitationsDisplay.safeUpdateInvitations(guild));
  await safeInitStep('статистика по заявкам', () => applicationsDisplay.safeUpdateApplicationsStats(guild));
  await safeInitStep('FAQ участников', () => faqDisplay.safeUpdateFaqChannel(guild, 'member'));
  await safeInitStep('FAQ HR', () => faqDisplay.safeUpdateFaqChannel(guild, 'hr'));
  await safeInitStep('панель управления FAQ', () => sendFaqManagePanel(guild));
}

// ---------- Обработка заявок на вступление ----------

async function applicationReviewEmbed(app, guildId) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на вступление #${app.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${app.discord_id}> (${app.discord_tag})` },
      { name: 'Имя Фамилия', value: app.name || '—', inline: true },
      { name: '№ Паспорта', value: app.static || '—', inline: true },
      { name: 'LVL', value: String(app.lvl || '—'), inline: true },
      { name: 'Кто пригласил', value: app.invited_by || '—', inline: true },
      { name: 'Навыки', value: app.skills || '—' },
      { name: 'Статус', value: statusLabel(app.status) },
    );

  // Если человек уже был в организации раньше — прикладываем историю (п.2.1)
  if (guildId) {
    const priorApps = (await db.all('SELECT * FROM applications WHERE discord_id = ? ORDER BY id DESC LIMIT 5', [app.discord_id])).filter((pa) => pa.id !== app.id);
    if (priorApps.length > 0) {
      const lines = priorApps.map((pa) =>
        pa.message_id
          ? `[Заявка #${pa.id} — ${statusLabel(pa.status)}](https://discord.com/channels/${guildId}/${config.CHANNEL_APPLY_REVIEW}/${pa.message_id})`
          : `Заявка #${pa.id} — ${statusLabel(pa.status)}`,
      );
      embed.addFields({ name: 'Прошлые заявки', value: lines.join('\n').slice(0, 1024) });
    }

    const priorChannel = await db.get('SELECT * FROM profile_channels WHERE discord_id = ?', [app.discord_id]);
    if (priorChannel) {
      embed.addFields({ name: 'Канал с отчётами (прошлый)', value: `[Открыть](https://discord.com/channels/${guildId}/${priorChannel.channel_id})`, inline: true });
    }

    const leftEvents = (await history.getHistory(app.discord_id)).filter((e) => e.event === 'left').slice(-3);
    if (leftEvents.length > 0) {
      const lines = leftEvents.map((e) => `${e.name} (№ ${e.static}) — ${formatDateOnly(new Date(e.at))}${e.note ? `: ${e.note}` : ''}`);
      embed.addFields({ name: 'Ранее покидал(а) организацию (причина увольнения)', value: lines.join('\n').slice(0, 1024) });
    }
  }

  if (app.reject_reason) embed.addFields({ name: 'Причина отказа', value: app.reject_reason });
  return embed;
}

function applicationReviewComponents(app) {
  if (app.status !== 'pending') return [];
  return [
    row(
      new ButtonBuilder().setCustomId(`apply_edit:${app.id}`).setLabel('✏️ Изменить').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`apply_accept:${app.id}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`apply_reject:${app.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function kickReviewEmbed(k) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на увольнение #${k.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${k.discord_id}> (${k.discord_tag})` },
      { name: 'Имя Фамилия участника', value: k.name || '—' },
      { name: 'Паспорт', value: !k.target_static || k.target_static === 'all' ? 'Все паспорта' : `№ ${k.target_static}` },
    );

  // Дата вступления цели заявки (п.3.1)
  let targetParticipant = null;
  if (k.target_static && k.target_static !== 'all') {
    targetParticipant = await db.get('SELECT * FROM participants WHERE static = ?', [k.target_static]);
    if (!targetParticipant) {
      const inExtra = await db.get('SELECT discord_id FROM extra_passports WHERE static = ?', [k.target_static]);
      if (inExtra) targetParticipant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [inExtra.discord_id]);
    }
  }
  if (!targetParticipant && k.name) {
    targetParticipant = await db.get('SELECT * FROM participants WHERE name = ?', [k.name]);
  }
  if (targetParticipant) {
    const staticForJoin = (k.target_static && k.target_static !== 'all') ? k.target_static : targetParticipant.static;
    const joinedEvent = await history.getLastJoined(targetParticipant.discord_id, staticForJoin);
    const joinedDate = joinedEvent ? formatDateOnly(new Date(joinedEvent.at)) : (targetParticipant.joined_at ? formatDateOnly(new Date(targetParticipant.joined_at)) : null);
    if (joinedDate) embed.addFields({ name: 'Вступил(а)', value: joinedDate, inline: true });
  }

  embed.addFields(
    { name: 'Причина', value: k.reason || '—' },
    { name: 'Статус', value: statusLabel(k.status) },
  );
  if (k.reject_reason) embed.addFields({ name: 'Причина отказа', value: k.reject_reason });
  return embed;
}

function kickReviewComponents(k) {
  if (k.status !== 'pending') return [];
  return [
    row(
      new ButtonBuilder().setCustomId(`kick_edit:${k.id}`).setLabel('✏️ Изменить').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick_confirm:${k.id}`).setLabel('🚫 Уволить').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`kick_reject:${k.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function vacationReviewEmbed(v) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на отпуск #${v.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${v.discord_id}> (${v.discord_tag})` },
      { name: 'До какого числа', value: formatDateTime(new Date(v.until)) },
      { name: 'Причина', value: v.reason || '—' },
      { name: 'Статус', value: statusLabel(v.status) },
    );
  if (v.reject_reason) embed.addFields({ name: 'Причина отказа', value: v.reject_reason });
  return embed;
}

function vacationReviewComponents(v) {
  if (v.status !== 'pending') return [];
  return [
    row(
      new ButtonBuilder().setCustomId(`vacation_accept:${v.id}`).setLabel('✅ Одобрить').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vacation_reject:${v.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function refreshReviewMessage(channel, messageId, embed, components, content) {
  try {
    const msg = await channel.messages.fetch(messageId);
    const payload = { embeds: [embed], components };
    if (content !== undefined) payload.content = content;
    await msg.edit(payload);
  } catch (err) {
    console.error('Не удалось обновить сообщение рассмотрения:', err);
  }
}

function actionSummary(actorId, label, extra) {
  return `${label} — <@${actorId}>${extra ? `: ${extra}` : ''}`;
}

async function dmUser(guild, discordId, content) {
  try {
    const member = await guild.members.fetch(discordId);
    await member.send(content);
  } catch (_) {
    // пользователь может иметь закрытые ЛС
  }
}

async function archiveProfileChannel(guild, discordId, channelId) {
  if (!channelId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    await channel.permissionOverwrites.edit(discordId, { ViewChannel: false, SendMessages: false });
    await channel.setParent(config.CHANNEL_PROFILES_ARCHIVE_CATEGORY, { lockPermissions: false });
    await db.run('UPDATE profile_channels SET status = ?, updated_at = ? WHERE channel_id = ?', ['archived', new Date().toISOString(), channelId]);
  } catch (_) {
    // канал уже мог быть удалён вручную
  }
}

async function removeParticipant(guild, participant, reason) {
  const passportsBeforeRemoval = await passportsLib.getAllPassports(participant.discord_id);
  for (const p of passportsBeforeRemoval) {
    await history.logLeft(participant.discord_id, p.static, p.name, reason || '');
  }

  await db.run('DELETE FROM participants WHERE discord_id = ?', [participant.discord_id]);
  await db.run('DELETE FROM extra_passports WHERE discord_id = ?', [participant.discord_id]);

  try {
    const member = await guild.members.fetch(participant.discord_id);
    await member.roles.remove([...config.ROLE_IDS, config.ROLE_VACATION, config.ROLE_AFK]);
  } catch (_) {
    // участник уже мог покинуть сервер
  }

  // У каждого паспорта — свой канал, архивируем их все (п. "канал на каждый паспорт")
  for (const p of passportsBeforeRemoval) {
    await archiveProfileChannel(guild, participant.discord_id, p.profile_thread_id);
  }

  await invitations.resolveOnLeave(participant.discord_id);
  await invitationsDisplay.safeUpdateInvitations(guild);
  await acceptances.resolveOnLeave(participant.discord_id);
  await applicationsDisplay.safeUpdateApplicationsStats(guild);

  await dmUser(guild, participant.discord_id, `🚫 Вы были исключены из организации.${reason ? ` Причина: ${reason}` : ''}`);
  await safeUpdateMembersList(guild);
}

// targetStatic: конкретный № паспорта или 'all'. Если это последний паспорт
// участника — всё равно полностью увольняем (п.6.2), иначе снимается
// только один паспорт (п.6/6.1), а роли/аккаунт остаются (п.6.3 через
// syncEffectiveIdentity/syncStatusRoles). Архивируется канал ИМЕННО
// снятого паспорта — остальные каналы человека не трогаются.
async function kickPassportOrFull(guild, participant, targetStatic, reason) {
  const passports = await passportsLib.getAllPassports(participant.discord_id);

  if (targetStatic === 'all' || passports.length <= 1) {
    await removeParticipant(guild, participant, reason);
    return { fullyRemoved: true };
  }

  const removedPassport = passports.find((p) => p.static === targetStatic);
  const { archivedChannelId } = await passportsLib.removePassportKeepAccount(participant.discord_id, targetStatic);
  if (removedPassport) {
    await history.logLeft(participant.discord_id, removedPassport.static, removedPassport.name, reason || '');
  }
  await archiveProfileChannel(guild, participant.discord_id, archivedChannelId);
  await syncEffectiveIdentity(guild, participant.discord_id);
  await syncStatusRoles(guild, participant.discord_id);
  await safeUpdateMembersList(guild);
  await dmUser(guild, participant.discord_id, `🚫 У вас снят паспорт № ${targetStatic}.${reason ? ` Причина: ${reason}` : ''}`);
  return { fullyRemoved: false };
}

async function handleParticipantAction(interaction, guild, action, discordId, participant) {
        if (action === 'view_profile') {
          const embeds = await buildProfileEmbeds(guild, discordId);
          if (!embeds) return safeReply(interaction, 'Профиль не найден.');
          return safeReply(interaction, { embeds, components: buildProfileComponents(discordId) });
        }

        if (action === 'kick') {
          const passports = await passportsLib.getAllPassports(discordId);
          if (passports.length <= 1) {
            return interaction.showModal(buildKickApplicationModal(`modal_members_kick:${discordId}:all`, { name: participant.name }));
          }
          const scopeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_kick_scope:${discordId}`)
            .setPlaceholder('Выберите паспорт или всех')
            .addOptions([
              new StringSelectMenuOptionBuilder().setLabel('Уволить всех (полностью)').setValue('all'),
              ...passports.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)),
            ]);
          return safeReply(interaction, { content: `У **${participant.name}** несколько паспортов — кого уволить?`, components: [row(scopeSelect)] });
        }

        if (action === 'edit') {
          return interaction.showModal(buildMemberModal(`modal_members_edit:${discordId}`, participant));
        }

        if (action === 'passports') {
          return safeReply(interaction, {
            content: `Управление паспортами **${participant.name}**:`,
            components: [row(
              new ButtonBuilder().setCustomId(`passport_add:${discordId}`).setLabel('➕ Добавить паспорт').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`passport_remove:${discordId}`).setLabel('➖ Удалить паспорт').setStyle(ButtonStyle.Danger),
            )],
          });
        }

        if (action === 'contract_add') {
          return safeReply(interaction, {
            content: `Добавить контракт для **${participant.name}** — выберите итог:`,
            components: [row(
              new ButtonBuilder().setCustomId(`contract_manual_status:fulfilled:${discordId}`).setLabel('✅ Выполнен').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`contract_manual_status:unfulfilled:${discordId}`).setLabel('❌ Невыполнен').setStyle(ButtonStyle.Danger),
            )],
          });
        }

        if (action === 'contract_remove') {
          const weeksAgo = await contractsDisplay.getCurrentWeeksAgo();
          const range = contracts.getWeekRange(weeksAgo);
          const list = await contracts.getUserContractsForWeek(discordId, range);
          if (list.length === 0) {
            return safeReply(interaction, `У ${participant.name} нет записей за отображаемую сейчас неделю (${contracts.formatWeekLabel(range)}).`);
          }
          const statusLabel = { fulfilled: '✅ Выполнен', unfulfilled: '❌ Невыполнен', rejected: '🚫 Не контракт' };
          const removeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_contract_remove:${discordId}`)
            .setPlaceholder('Выберите запись для удаления')
            .addOptions(
              list.map((c) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(`${contracts.formatDate(new Date(c.submitted_at))} — ${statusLabel[c.status] || c.status}`)
                  .setValue(String(c.id)),
              ),
            );
          return safeReply(interaction, { content: `Записи ${participant.name} за ${contracts.formatWeekLabel(range)}:`, components: [row(removeSelect)] });
        }

        if (action === 'contract_view') {
          const weeksAgo = await contractsDisplay.getCurrentWeeksAgo();
          const range = contracts.getWeekRange(weeksAgo);
          const { fulfilled, unfulfilled } = await contracts.getUserWeekStats(discordId, range);
          const fLines = fulfilled.map((c) => `[Скриншот](${c.message_url}) | ${contracts.formatDate(new Date(c.submitted_at))}`).join('\n') || '—';
          const uLines = unfulfilled.map((c) => `[Скриншот](${c.message_url}) | ${contracts.formatDate(new Date(c.submitted_at))}`).join('\n') || '—';
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`Контракты ${participant.name} — за ${contracts.formatWeekLabel(range)}`)
            .addFields(
              { name: 'Выполненные', value: fLines.slice(0, 1024), inline: true },
              { name: 'Не выполненные', value: uLines.slice(0, 1024), inline: true },
            );
          return safeReply(interaction, { embeds: [embed] });
        }

        // Шаг 1 ручного добавления приглашения: выбран пригласивший — теперь ищем приглашённого
        if (action === 'invitation_add_inviter') {
          return interaction.showModal(buildPickSearchModal(`invitation_add_invitee:${discordId}`));
        }

        // Шаг 2: пригласивший и приглашённый выбраны — сразу засчитываем (HR подтверждает по факту)
        if (action.startsWith('invitation_add_invitee:')) {
          const inviterId = action.split(':')[1];
          if (inviterId === discordId) return safeReply(interaction, '⛔ Нельзя указать одного и того же человека пригласившим самого себя.');
          try {
            await invitations.addManualInvitation(inviterId, discordId, participant.name, participant.static, new Date().toISOString());
          } catch (err) {
            return safeReply(interaction, `⛔ ${err.message}`);
          }
          await invitationsDisplay.safeUpdateInvitations(guild);
          await logAudit(guild, interaction.user, 'Приглашение добавлено вручную', `<@${inviterId}> пригласил(а) <@${discordId}>`);
          return safeReply(interaction, `Приглашение добавлено: <@${inviterId}> → <@${discordId}>.`);
        }

        // Удаление: выбран пригласивший — показываем список его приглашений
        if (action === 'invitation_remove') {
          const list = await invitations.getInviterAllInvitations(discordId);
          if (list.length === 0) return safeReply(interaction, `У ${participant.name} нет записей о приглашениях.`);
          const statusLabel = { pending: '⏳ Ожидает', confirmed: '✅ Подтверждено', disqualified: '🚫 Дисквалифицировано' };
          const removeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_invitation_remove:${discordId}`)
            .setPlaceholder('Выберите приглашение для удаления')
            .addOptions(
              list.map((inv) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(`${inv.invitee_name} (№ ${inv.invitee_static}) — ${statusLabel[inv.status] || inv.status}`)
                  .setValue(String(inv.id)),
              ),
            );
          return safeReply(interaction, { content: `Приглашения от ${participant.name}:`, components: [row(removeSelect)] });
        }

        // Поиск: показать подтверждённые приглашения за отображаемую неделю
        if (action === 'invitation_view') {
          const weeksAgo = await invitationsDisplay.getCurrentWeeksAgo();
          const range = contracts.getWeekRange(weeksAgo);
          const list = await invitations.getInviterInviteesForWeek(discordId, range);
          const lines = list.map((inv) => `<@${inv.invitee_discord_id}> | ${inv.invitee_name}, № ${inv.invitee_static}`).join('\n') || '—';
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`Приглашения ${participant.name} — за ${contracts.formatWeekLabel(range)}`)
            .setDescription(lines.slice(0, 4000));
          return safeReply(interaction, { embeds: [embed] });
        }

        if (action === 'vacation_grant') {
          const passports = await passportsLib.getAllPassports(discordId);
          if (passports.length <= 1) {
            return interaction.showModal(buildVacationGrantModal(discordId));
          }
          const scopeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_vacation_grant_scope:${discordId}`)
            .setPlaceholder('Выберите один, несколько или все паспорта')
            .setMinValues(1)
            .setMaxValues(passports.length)
            .addOptions(passports.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)));
          return safeReply(interaction, { content: `Кому из паспортов **${participant.name}** выдать отпуск?`, components: [row(scopeSelect)] });
        }

        if (action === 'vacation_revoke') {
          const onVacation = (await passportsLib.getAllPassports(discordId)).filter((p) => p.vacation_until);
          if (onVacation.length === 0) return safeReply(interaction, 'У участника нет активного отпуска.');

          if (onVacation.length === 1) {
            await passportsLib.updatePassportFields(discordId, onVacation[0].static, { vacation_until: null });
            await history.logStatusRevoked('vacation', discordId, onVacation[0].static, onVacation[0].name, interaction.user.id);
            await syncStatusRoles(guild, discordId);
            await safeUpdateMembersList(guild);
            await logAudit(guild, interaction.user, 'Отпуск снят', `<@${discordId}> (${onVacation[0].name}, № ${onVacation[0].static})`);
            await dmUser(guild, discordId, `📢 Ваш отпуск (${onVacation[0].name}) был досрочно завершён администрацией.`);
            return safeReply(interaction, `Отпуск ${onVacation[0].name} снят.`);
          }

          const scopeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_vacation_revoke_scope:${discordId}`)
            .setPlaceholder('Выберите, у кого снять отпуск')
            .setMinValues(1)
            .setMaxValues(onVacation.length)
            .addOptions(onVacation.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)));
          return safeReply(interaction, { content: `У кого из паспортов **${participant.name}** снять отпуск?`, components: [row(scopeSelect)] });
        }

        if (action === 'afk_set') {
          const passports = await passportsLib.getAllPassports(discordId);
          if (passports.length <= 1) {
            return interaction.showModal(buildAfkModal(discordId));
          }
          const scopeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_afk_set_scope:${discordId}`)
            .setPlaceholder('Выберите один, несколько или все паспорта')
            .setMinValues(1)
            .setMaxValues(passports.length)
            .addOptions(passports.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)));
          return safeReply(interaction, { content: `Кому из паспортов **${participant.name}** выставить AFK?`, components: [row(scopeSelect)] });
        }

        if (action === 'afk_revoke') {
          const onAfk = (await passportsLib.getAllPassports(discordId)).filter((p) => p.afk_since);
          if (onAfk.length === 0) return safeReply(interaction, 'У участника не выставлен статус AFK.');

          if (onAfk.length === 1) {
            await passportsLib.updatePassportFields(discordId, onAfk[0].static, { afk_since: null });
            await history.logStatusRevoked('afk', discordId, onAfk[0].static, onAfk[0].name, interaction.user.id);
            await syncStatusRoles(guild, discordId);
            await safeUpdateMembersList(guild);
            await logAudit(guild, interaction.user, 'AFK снят', `<@${discordId}> (${onAfk[0].name}, № ${onAfk[0].static})`);
            return safeReply(interaction, `Статус AFK ${onAfk[0].name} снят.`);
          }

          const scopeSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_afk_revoke_scope:${discordId}`)
            .setPlaceholder('Выберите, у кого снять AFK')
            .setMinValues(1)
            .setMaxValues(onAfk.length)
            .addOptions(onAfk.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)));
          return safeReply(interaction, { content: `У кого из паспортов **${participant.name}** снять AFK?`, components: [row(scopeSelect)] });
        }

        // Шаг 1 повышения/понижения: участник выбран — показываем список
        // доступных рангов, чтобы выбрать любой, а не только соседний.
        if (action === 'promote' || action === 'demote') {
          const passports = await passportsLib.getAllPassports(discordId);

          if (passports.length > 1) {
            const scopeSelect = new StringSelectMenuBuilder()
              .setCustomId(`select_promote_scope:${action}:${discordId}`)
              .setPlaceholder('Выберите паспорт или всех')
              .addOptions([
                new StringSelectMenuOptionBuilder().setLabel('Все паспорта').setValue('all'),
                ...passports.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)),
              ]);
            return safeReply(interaction, {
              content: `У **${participant.name}** несколько паспортов — кого именно ${action === 'promote' ? 'повысить' : 'понизить'}?`,
              components: [row(scopeSelect)],
            });
          }

          return startRankSelection(interaction, guild, action, discordId, passports[0] ? passports[0].static : participant.static, participant.name);
        }

        return;
}

// ---------- interactionCreate ----------

client.on('interactionCreate', async (interaction) => {
  try {
    const guild = await resolveGuild(interaction);

    // ----- Автодополнение (подсказки при вводе "человек"/"запрос") -----
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'giveaway_end' || interaction.commandName === 'giveaway_cancel' || interaction.commandName === 'giveaway_reroll') {
        const status = interaction.commandName === 'giveaway_reroll' ? 'ended' : 'active';
        const focused = interaction.options.getFocused();
        const rows = await db.all(
          `SELECT * FROM giveaways WHERE status = ? AND prize LIKE ? ORDER BY id DESC LIMIT 25`,
          [status, `%${focused}%`],
        );
        const choices = rows.map((g) => ({
          name: `${g.prize} (до ${formatDateTime(new Date(g.ends_at))})`.slice(0, 100),
          value: String(g.id),
        }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      const autocompleteCommands = ['history', 'whois', 'rules_broadcast', 'send_report_channels'];
      if (!autocompleteCommands.includes(interaction.commandName)) return;

      const focused = interaction.options.getFocused();
      const q = `%${focused}%`;
      const rows = await db.all(
        `SELECT DISTINCT p.discord_id, p.name, p.static, p.discord_tag FROM participants p
         LEFT JOIN extra_passports e ON e.discord_id = p.discord_id
         WHERE p.name LIKE ? OR p.static LIKE ? OR p.discord_tag LIKE ? OR e.name LIKE ? OR e.static LIKE ?
         ORDER BY p.name LIMIT 25`,
        [q, q, q, q, q],
      );
      const choices = rows.map((r) => ({
        name: `${r.name} | № ${r.static} | ${r.discord_tag}`.slice(0, 100),
        value: r.discord_id,
      }));
      try {
        await interaction.respond(choices);
      } catch (_) {
        // интеракция могла устареть — не критично, просто не покажем подсказки
      }
      return;
    }

    // ----- Слэш-команды -----
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'ping') {
        if (!perms.hasBotAccess(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const dbStart = Date.now();
        await db.get('SELECT 1');
        const dbLatency = Date.now() - dbStart;

        const wsLatency = client.ws.ping;
        const roundTripLatency = Date.now() - interaction.createdTimestamp;
        const usedBytes = getDirSize(db.dataDir);
        const usedMb = (usedBytes / 1024 / 1024).toFixed(1);
        const quotaMb = 5000; // 5 ГБ — типовая квота диска на Bothost Basic
        const percent = ((usedBytes / (quotaMb * 1024 * 1024)) * 100).toFixed(1);

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🏓 Пинг')
          .addFields(
            { name: 'WebSocket (Discord Gateway)', value: wsLatency >= 0 ? `${wsLatency} мс` : 'считается…', inline: true },
            { name: 'Отклик Discord (round-trip)', value: `${roundTripLatency} мс`, inline: true },
            { name: 'База данных (SQLite)', value: `${dbLatency} мс`, inline: true },
            { name: 'Занято на диске', value: `${usedMb} МБ из ${quotaMb / 1000} ГБ (${percent}%)`, inline: true },
          );

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'backfill_profiles') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const allParticipants = await db.all('SELECT * FROM participants');
        let createdChannels = 0;
        let restoredChannels = 0;
        let loggedJoins = 0;
        let fixedRanks = 0;

        for (const p of allParticipants) {
          if (p.discord_id.startsWith('nodiscord-')) continue; // без Discord — канал не нужен

          const allPassports = await passportsLib.getAllPassports(p.discord_id);
          let ranksChanged = false;

          for (const passport of allPassports) {
            // Ранг не назначен (данные до этой фичи) — чиним сразу
            if (!passport.role_id) {
              await passportsLib.updatePassportFields(p.discord_id, passport.static, { role_id: config.ROLE_APPLY });
              fixedRanks++;
              ranksChanged = true;
            }

            // Дата вступления
            const existingJoin = await history.getLastJoined(p.discord_id, passport.static);
            if (!existingJoin) {
              const fallbackDate = passport.position === 0 ? p.joined_at : null;
              await history.logJoined(p.discord_id, passport.static, passport.name, 'Восстановлено (backfill)', fallbackDate);
              loggedJoins++;
            }

            // Канал-профиль — свой на КАЖДЫЙ паспорт (не на весь аккаунт)
            const existingChannel = await db.get('SELECT * FROM profile_channels WHERE static = ?', [passport.static]);
            let isActiveAndInPlace = false;

            if (existingChannel) {
              try {
                const ch = await guild.channels.fetch(existingChannel.channel_id);
                if (ch.parentId === config.CHANNEL_PROFILES_ACTIVE_CATEGORY) {
                  isActiveAndInPlace = true;
                  if (passport.profile_thread_id !== existingChannel.channel_id) {
                    await passportsLib.setPassportChannel(p.discord_id, passport.static, existingChannel.channel_id);
                  }
                  // Чиним доступ бота на УЖЕ существующих каналах — эта
                  // проверка раньше отсутствовала при их создании, из-за
                  // чего бот не видел сообщения в собственных же каналах.
                  await ch.permissionOverwrites.edit(guild.client.user.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    AttachFiles: true,
                    ManageChannels: true,
                  });
                }
              } catch (_) {
                isActiveAndInPlace = false; // канал не найден вообще — пересоздадим
              }
            }

            if (!isActiveAndInPlace) {
              const wasArchived = !!existingChannel;
              await createProfileThread(guild, p.discord_id, passport.name, passport.static);
              if (wasArchived) restoredChannels++;
              else createdChannels++;
            }
          }

          if (ranksChanged) {
            await syncEffectiveIdentity(guild, p.discord_id);
          }
        }

        // Ищем "осиротевшие" каналы — те, что физически есть в категориях
        // профилей, но не привязаны ни к одному паспорту в базе (следствие
        // старого бага с уникальностью, из-за которого повторные попытки
        // плодили дубликаты).
        const linkedChannelIds = new Set((await db.all('SELECT channel_id FROM profile_channels')).map((r) => r.channel_id));
        const orphanChannels = [];
        for (const categoryId of [config.CHANNEL_PROFILES_ACTIVE_CATEGORY, config.CHANNEL_PROFILES_ARCHIVE_CATEGORY]) {
          const categoryChannels = guild.channels.cache.filter((c) => c.parentId === categoryId);
          for (const ch of categoryChannels.values()) {
            if (!linkedChannelIds.has(ch.id)) orphanChannels.push(ch);
          }
        }

        let orphanText = '';
        if (orphanChannels.length > 0) {
          orphanText = `\n\n⚠️ Найдено незалинкованных (осиротевших) каналов: **${orphanChannels.length}** — их можно удалить вручную:\n${orphanChannels.map((c) => `<#${c.id}>`).join(', ').slice(0, 1500)}`;
        }

        await logAudit(guild, interaction.user, 'Backfill профилей выполнен', `Создано каналов: ${createdChannels}. Восстановлено из архива: ${restoredChannels}. Добавлено записей о вступлении: ${loggedJoins}. Исправлено паспортов без ранга: ${fixedRanks}. Осиротевших каналов: ${orphanChannels.length}.`);
        await interaction.editReply(`Готово. Проверено участников: ${allParticipants.length}. Создано новых каналов: ${createdChannels}. Восстановлено из архива: ${restoredChannels}. Добавлено записей о вступлении: ${loggedJoins}. Исправлено паспортов без ранга: ${fixedRanks}.${orphanText}`);
        return;
      }

      if (cmd === 'history') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('человек');
        const target = await invitations.resolveInviter(query);
        if (!target) {
          await interaction.editReply('⛔ Человек не найден.');
          return;
        }
        const events = await history.getHistory(target.discord_id);
        if (events.length === 0) {
          await interaction.editReply(`История для <@${target.discord_id}> пуста.`);
          return;
        }
        const lines = events.map((e) => {
          const label = e.event === 'joined' ? '✅ Вступил(а)' : '🚫 Покинул(а)';
          const date = formatDateTime(new Date(e.at));
          return `${label} — ${e.name} (№ ${e.static}) — ${date}${e.note ? `: ${e.note}` : ''}`;
        });
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`История: <@${target.discord_id}>`)
          .setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'contracts_leaderboard') {
        if (!perms.canReview(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const board = await contracts.getAllTimeLeaderboard();
        if (board.length === 0) {
          await interaction.editReply('Пока нет обработанных контрактов.');
          return;
        }
        const lines = board.slice(0, 25).map((row, i) => `${i + 1}. <@${row.discord_id}> — ✅ ${row.fulfilled} / ❌ ${row.unfulfilled}`);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🏆 Топ по контрактам за всё время')
          .setDescription(lines.join('\n'));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'audit_search') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('запрос');
        const q = `%${query}%`;
        const rows = await db.all(
          `SELECT * FROM audit_log WHERE action LIKE ? OR details LIKE ? OR actor_tag LIKE ? ORDER BY id DESC LIMIT 15`,
          [q, q, q],
        );
        if (rows.length === 0) {
          await interaction.editReply('Ничего не найдено.');
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Поиск по аудиту: «${query}»`)
          .setDescription(
            rows.map((r) => `**${r.action}** — <@${r.actor_id}> — ${formatDateTime(new Date(r.at))}\n${r.details.slice(0, 200)}`).join('\n\n').slice(0, 4000),
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'whois') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('запрос');
        const q = `%${query}%`;
        const rows = await db.all(
          `SELECT DISTINCT p.* FROM participants p
           LEFT JOIN extra_passports e ON e.discord_id = p.discord_id
           WHERE p.name LIKE ? OR p.static LIKE ? OR e.name LIKE ? OR e.static LIKE ? OR p.discord_tag LIKE ? OR p.discord_id LIKE ?
           ORDER BY p.name LIMIT 10`,
          [q, q, q, q, q, q],
        );
        if (rows.length === 0) {
          await interaction.editReply('Ничего не найдено.');
          return;
        }
        if (rows.length === 1) {
          const embeds = await buildProfileEmbeds(guild, rows[0].discord_id);
          await interaction.editReply({ embeds });
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Результаты поиска: «${query}»`)
          .setDescription(rows.map((r) => `<@${r.discord_id}> | ${r.discord_tag} — ${r.name} (№ ${r.static})`).join('\n'));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'export_stats') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const range = contracts.getWeekRange(0);
        const label = contracts.formatWeekLabel(range).replace(/\./g, '-');

        const contractRows = await db.all(
          `SELECT * FROM contracts WHERE submitted_at BETWEEN ? AND ? ORDER BY submitted_at`,
          [range.start.toISOString(), range.end.toISOString()],
        );
        const contractsCsv = buildCsv(
          ['discord_id', 'статус', 'дата отправки', 'ссылка'],
          contractRows.map((r) => [r.discord_id, statusLabel(r.status), r.submitted_at, r.message_url]),
        );

        const invitationRows = await db.all(
          `SELECT * FROM invitations WHERE status = 'confirmed' AND joined_at BETWEEN ? AND ? ORDER BY joined_at`,
          [range.start.toISOString(), range.end.toISOString()],
        );
        const invitationsCsv = buildCsv(
          ['пригласил (discord_id)', 'приглашённый (discord_id)', 'имя', 'паспорт', 'дата вступления'],
          invitationRows.map((r) => [r.inviter_discord_id, r.invitee_discord_id, r.invitee_name, r.invitee_static, r.joined_at]),
        );

        const applicationRows = await db.all(
          `SELECT * FROM applications WHERE created_at BETWEEN ? AND ? ORDER BY created_at`,
          [range.start.toISOString(), range.end.toISOString()],
        );
        const applicationsCsv = buildCsv(
          ['discord_id', 'имя', 'паспорт', 'статус', 'принял/отклонил', 'дата'],
          applicationRows.map((r) => [r.discord_id, r.name, r.static, statusLabel(r.status), r.accepted_by || '', r.created_at]),
        );

        const files = [
          new AttachmentBuilder(Buffer.from(contractsCsv, 'utf8'), { name: `contracts_${label}.csv` }),
          new AttachmentBuilder(Buffer.from(invitationsCsv, 'utf8'), { name: `invitations_${label}.csv` }),
          new AttachmentBuilder(Buffer.from(applicationsCsv, 'utf8'), { name: `applications_${label}.csv` }),
        ];

        await logAudit(guild, interaction.user, 'Экспорт статистики', `Выгружена неделя ${contracts.formatWeekLabel(range)}`);
        await interaction.editReply({ content: `Статистика за ${contracts.formatWeekLabel(range)}:`, files });
        return;
      }

      if (cmd === 'send_report_channels') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const query = interaction.options.getString('человек');
        let targets;
        if (query) {
          const target = await invitations.resolveInviter(query);
          if (!target) {
            await interaction.editReply('⛔ Человек не найден в списке участников.');
            return;
          }
          targets = [target];
        } else {
          targets = await db.all('SELECT * FROM participants');
        }

        let sent = 0;
        let skipped = 0;
        for (const t of targets) {
          if (t.discord_id.startsWith('nodiscord-')) {
            skipped++;
            continue;
          }
          const passports = await passportsLib.getAllPassports(t.discord_id);
          const lines = [];
          for (const p of passports) {
            if (!p.profile_thread_id) continue;
            try {
              const channel = await guild.channels.fetch(p.profile_thread_id);
              lines.push(`${p.name} (№ ${p.static}): ${channel.url}`);
            } catch (_) {}
          }
          if (lines.length === 0) {
            skipped++;
            continue;
          }
          try {
            const member = await guild.members.fetch(t.discord_id);
            await member.send(`📸 Ваши каналы с отчётами по контрактам:\n${lines.join('\n')}`);
            sent++;
          } catch (_) {
            skipped++;
          }
          await sleep(500);
        }

        await logAudit(guild, interaction.user, 'Рассылка ссылок на каналы с отчётами', query ? `Одному: ${targets[0].name}` : `Всем участникам (${sent}/${targets.length}, пропущено: ${skipped})`);
        await interaction.editReply(query ? `Отправлено ${targets[0].name}.` : `Отправлено ${sent} из ${targets.length} (пропущено: ${skipped} — нет Discord или каналов).`);
        return;
      }

      if (cmd === 'org_stats') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const totalPeople = (await db.get('SELECT COUNT(*) as cnt FROM participants')).cnt;
        const onVacation = (await db.get(
          `SELECT COUNT(*) as cnt FROM (
             SELECT vacation_until FROM participants WHERE vacation_until IS NOT NULL
             UNION ALL
             SELECT vacation_until FROM extra_passports WHERE vacation_until IS NOT NULL
           )`,
        )).cnt;
        const onAfk = (await db.get(
          `SELECT COUNT(*) as cnt FROM (
             SELECT afk_since FROM participants WHERE afk_since IS NOT NULL
             UNION ALL
             SELECT afk_since FROM extra_passports WHERE afk_since IS NOT NULL
           )`,
        )).cnt;

        const range = contracts.getWeekRange(0);
        const contractRows = await db.all(
          `SELECT status FROM contracts WHERE status IN ('fulfilled','unfulfilled') AND submitted_at BETWEEN ? AND ?`,
          [range.start.toISOString(), range.end.toISOString()],
        );
        const fulfilled = contractRows.filter((r) => r.status === 'fulfilled').length;
        const unfulfilled = contractRows.filter((r) => r.status === 'unfulfilled').length;

        const pendingApps = (await db.get(`SELECT COUNT(*) as cnt FROM applications WHERE status = 'pending'`)).cnt;
        const pendingKicks = (await db.get(`SELECT COUNT(*) as cnt FROM kicks WHERE status = 'pending'`)).cnt;
        const pendingVacations = (await db.get(`SELECT COUNT(*) as cnt FROM vacations WHERE status = 'pending'`)).cnt;
        const pendingDataChanges = (await db.get(`SELECT COUNT(*) as cnt FROM data_change_requests WHERE status = 'pending'`)).cnt;
        const pendingHr = (await db.get(`SELECT COUNT(*) as cnt FROM hr_applications WHERE status = 'pending'`)).cnt;
        const pendingPassports = (await db.get(`SELECT COUNT(*) as cnt FROM passport_requests WHERE status = 'pending'`)).cnt;
        const blacklistCount = (await db.get('SELECT COUNT(DISTINCT discord_id) as cnt FROM blacklist')).cnt;

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 Сводка по организации')
          .addFields(
            { name: 'Всего людей', value: String(totalPeople), inline: true },
            { name: '🏖️ В отпуске', value: String(onVacation), inline: true },
            { name: '💤 AFK', value: String(onAfk), inline: true },
            { name: `Контракты (${contracts.formatWeekLabel(range)})`, value: `✅ ${fulfilled} / ❌ ${unfulfilled}`, inline: false },
            { name: 'Заявки на вступление', value: String(pendingApps), inline: true },
            { name: 'Заявки на увольнение', value: String(pendingKicks), inline: true },
            { name: 'Заявки на отпуск', value: String(pendingVacations), inline: true },
            { name: 'Заявки на изменение данных', value: String(pendingDataChanges), inline: true },
            { name: 'Заявки на роль HR', value: String(pendingHr), inline: true },
            { name: 'Заявки на паспорт', value: String(pendingPassports), inline: true },
            { name: 'В чёрном списке', value: String(blacklistCount), inline: true },
          );

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'status') {
        if (!perms.hasBotAccess(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let dbStatus = '✅ Подключена';
        try {
          await db.get('SELECT 1');
        } catch (err) {
          dbStatus = `❌ Ошибка: ${err.message}`;
        }

        const channelsToCheck = [
          ['Список людей', config.CHANNEL_MEMBERS],
          ['Заявки на вступление', config.CHANNEL_APPLY_REVIEW],
          ['ЧС', config.CHANNEL_BLACKLIST],
          ['Статистика (контракты)', config.CHANNEL_CONTRACTS_STATS],
          ['Приглашения', config.CHANNEL_INVITATIONS],
          ['Аудит', config.CHANNEL_AUDIT],
          ['Профили (активные)', config.CHANNEL_PROFILES_ACTIVE_CATEGORY],
          ['Профили (архив)', config.CHANNEL_PROFILES_ARCHIVE_CATEGORY],
        ];
        const channelResults = [];
        for (const [label, channelId] of channelsToCheck) {
          try {
            await guild.channels.fetch(channelId);
            channelResults.push(`✅ ${label}`);
          } catch (err) {
            channelResults.push(`❌ ${label} (${err.message})`);
          }
        }

        const uptimeSeconds = Math.floor(client.uptime / 1000);
        const uptimeStr = `${Math.floor(uptimeSeconds / 3600)}ч ${Math.floor((uptimeSeconds % 3600) / 60)}м`;

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🩺 Статус бота')
          .addFields(
            { name: 'База данных', value: dbStatus, inline: false },
            { name: 'Доступ к каналам', value: channelResults.join('\n').slice(0, 1024), inline: false },
            { name: 'Работает без перезапуска', value: uptimeStr, inline: true },
            { name: 'WebSocket', value: `${client.ws.ping >= 0 ? client.ws.ping : '—'} мс`, inline: true },
          );

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'export_ids') {
        if (!perms.hasBotAccess(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const typeLabel = (type) => {
          switch (type) {
            case ChannelType.GuildText: return 'текст';
            case ChannelType.GuildVoice: return 'голос';
            case ChannelType.GuildAnnouncement: return 'анонсы';
            case ChannelType.GuildForum: return 'форум';
            case ChannelType.GuildStageVoice: return 'сцена';
            case ChannelType.GuildCategory: return 'категория';
            default: return `тип ${type}`;
          }
        };

        const lines = [];
        lines.push(`Сервер: ${guild.name} (${guild.id})`);
        lines.push(`Сформировано: ${formatDateTime(new Date())}`);
        lines.push('');
        lines.push('=== КАТЕГОРИИ И КАНАЛЫ ===');
        lines.push('');

        const allChannels = [...guild.channels.cache.values()];
        const categories = allChannels
          .filter((c) => c.type === ChannelType.GuildCategory)
          .sort((a, b) => a.position - b.position);

        for (const cat of categories) {
          lines.push(`[Категория] ${cat.name} — ${cat.id}`);
          const children = allChannels
            .filter((c) => c.parentId === cat.id && c.type !== ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);
          for (const ch of children) {
            lines.push(`  #${ch.name} (${typeLabel(ch.type)}) — ${ch.id}`);
          }
          lines.push('');
        }

        const noCategory = allChannels
          .filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory)
          .sort((a, b) => a.position - b.position);
        if (noCategory.length > 0) {
          lines.push('[Без категории]');
          for (const ch of noCategory) {
            lines.push(`  #${ch.name} (${typeLabel(ch.type)}) — ${ch.id}`);
          }
          lines.push('');
        }

        lines.push('=== РОЛИ ===');
        lines.push('(от старшей к младшей)');
        lines.push('');
        const roles = [...guild.roles.cache.values()]
          .filter((r) => r.name !== '@everyone')
          .sort((a, b) => b.position - a.position);
        for (const role of roles) {
          lines.push(`${role.name} — ${role.id}`);
        }

        const fileContent = lines.join('\n');
        const safeName = guild.name.replace(/[^a-zA-Zа-яА-Я0-9]+/g, '_');
        // BOM в начале файла — без него некоторые программы (например,
        // старый Блокнот Windows) не определяют UTF-8 сами и открывают
        // кириллицу как кракозябры (Windows-1251).
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const fileBuffer = Buffer.concat([bom, Buffer.from(fileContent, 'utf8')]);
        const file = new AttachmentBuilder(fileBuffer, { name: `${safeName}_ids.txt` });

        await logAudit(guild, interaction.user, 'Экспорт ID каналов/ролей', `Каналов: ${allChannels.length - categories.length}, ролей: ${roles.length}`);
        await interaction.editReply({ content: 'Список каналов и ролей сервера — можно прислать мне этот файл:', files: [file] });
        return;
      }

      if (cmd === 'giveaway_start') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const prize = interaction.options.getString('приз');
        const durationStr = interaction.options.getString('длительность');
        const winnersCount = interaction.options.getInteger('победителей');
        const targetChannel = interaction.options.getChannel('канал') || interaction.channel;

        const durationMs = giveaways.parseDuration(durationStr);
        if (!durationMs) {
          return interaction.reply({ content: '⛔ Неверный формат длительности. Используйте, например: 30m, 2h, 1d, 1w.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const endsAt = new Date(Date.now() + durationMs);

        const giveawayId = await giveaways.createGiveaway(targetChannel.id, prize, winnersCount, interaction.user.id, endsAt.toISOString());
        const embed = buildGiveawayEmbed({ prize, winners_count: winnersCount, ends_at: endsAt.toISOString(), host_id: interaction.user.id }, 0);
        const sent = await targetChannel.send({
          content: '🎉 **РОЗЫГРЫШ** 🎉',
          embeds: [embed],
          components: buildGiveawayComponents(giveawayId),
        });
        await giveaways.setMessageId(giveawayId, sent.id);

        await logAudit(guild, interaction.user, 'Розыгрыш запущен', `«${prize}» в <#${targetChannel.id}>, победителей: ${winnersCount}, до ${formatDateTime(endsAt)}`);
        await interaction.editReply(`Розыгрыш запущен в <#${targetChannel.id}>.`);
        return;
      }

      if (cmd === 'giveaway_end') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('розыгрыш');
        const giveaway = await giveaways.getGiveaway(giveawayId);
        if (!giveaway || giveaway.status !== 'active') {
          await interaction.editReply('⛔ Розыгрыш не найден или уже завершён.');
          return;
        }
        const winners = await endGiveaway(guild, giveawayId, interaction.user);
        await interaction.editReply(`Розыгрыш завершён. Победителей: ${winners.length}.`);
        return;
      }

      if (cmd === 'giveaway_cancel') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('розыгрыш');
        const cancelled = await cancelGiveaway(guild, giveawayId, interaction.user);
        await interaction.editReply(cancelled ? 'Розыгрыш отменён.' : '⛔ Розыгрыш не найден или уже завершён.');
        return;
      }

      if (cmd === 'giveaway_reroll') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('розыгрыш');
        const giveaway = await giveaways.getGiveaway(giveawayId);
        if (!giveaway || giveaway.status !== 'ended') {
          await interaction.editReply('⛔ Розыгрыш не найден или ещё не завершён.');
          return;
        }
        const winners = await rerollGiveaway(guild, giveawayId, interaction.user);
        await interaction.editReply(`Готово. Новых победителей: ${winners.length}.`);
        return;
      }

      if (cmd === 'init_menus') {
        if (!perms.hasBotAccess(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await initMenus(guild);
        await interaction.editReply('Меню успешно инициализированы.');
        return;
      }

      if (cmd === 'rules' || cmd === 'agitation') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        if (cmd === 'rules') {
          const text = await getCurrentText('rules', DEFAULT_RULES);
          const channel = await guild.channels.fetch(config.CHANNEL_RULES);
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил').setDescription(text)] });
          return interaction.reply({ content: 'Правила отправлены в канал.', flags: MessageFlags.Ephemeral });
        }
        const text = await getCurrentText('agitation', DEFAULT_AGITATION);
        const channel = await guild.channels.fetch(config.CHANNEL_AGITATION);
        await channel.send({ content: text, embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('```\n' + text + '\n```')] });
        return interaction.reply({ content: 'Агитация отправлена в канал.', flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'hr_info') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const text = await getCurrentText('hr_info', DEFAULT_HR_INFO);
        const channel = await guild.channels.fetch(config.CHANNEL_HR_APPLY_MENU);
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text)] });
        return interaction.reply({ content: 'Описание вакансии HR отправлено в канал.', flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'rules_broadcast') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rulesText = await getCurrentText('rules', DEFAULT_RULES);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил организации').setDescription(rulesText.slice(0, 4000));

        const query = interaction.options.getString('человек');
        let targets;
        if (query) {
          const target = await invitations.resolveInviter(query); // тот же поиск по имени/паспорту/тегу/id
          if (!target) {
            await interaction.editReply('⛔ Человек не найден в списке участников.');
            return;
          }
          targets = [target];
        } else {
          targets = await db.all('SELECT * FROM participants');
        }

        let sent = 0;
        for (const t of targets) {
          try {
            const member = await guild.members.fetch(t.discord_id);
            await member.send({ embeds: [embed] });
            sent++;
          } catch (_) {
            // закрытые ЛС и т.п.
          }
          await sleep(500);
        }

        await logAudit(guild, interaction.user, 'Рассылка правил', query ? `Одному: ${targets[0].name}` : `Всем участникам (${sent}/${targets.length})`);
        await interaction.editReply(query ? `Правила отправлены ${targets[0].name}.` : `Правила отправлены ${sent} из ${targets.length} участников.`);
        return;
      }

      if (cmd === 'broadcast_message') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.reply({ content: 'Отправьте текст сообщения следующим сообщением в этом канале (10 минут на ответ).', flags: MessageFlags.Ephemeral });

        const filter = (m) => m.author.id === interaction.user.id;
        let collected;
        try {
          collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 600000, errors: ['time'] });
        } catch (_) {
          await interaction.followUp({ content: 'Время ожидания истекло, рассылка отменена.', flags: MessageFlags.Ephemeral });
          return;
        }
        const text = collected.first().content;
        pendingBroadcasts.set(interaction.user.id, { text });

        await interaction.channel.send({
          content: `Кому отправить это сообщение от <@${interaction.user.id}>?\n\n> ${text.slice(0, 300)}`,
          components: [row(
            new ButtonBuilder().setCustomId(`broadcast_target:all:${interaction.user.id}`).setLabel('Всем в организации').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`broadcast_target:one:${interaction.user.id}`).setLabel('Определённому человеку').setStyle(ButtonStyle.Secondary),
          )],
        });
        return;
      }

      if (cmd === 'rules_update' || cmd === 'agitation_update' || cmd === 'hr_info_update') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const type = cmd === 'rules_update' ? 'rules' : cmd === 'agitation_update' ? 'agitation' : 'hr_info';
        const defaultText = type === 'rules' ? DEFAULT_RULES : type === 'agitation' ? DEFAULT_AGITATION : DEFAULT_HR_INFO;
        const current = await getCurrentText(type, defaultText);

        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Текущий текст (копируемая версия — следующим сообщением)').setDescription(current.slice(0, 4000))],
          flags: MessageFlags.Ephemeral,
        });
        await interaction.followUp({ content: '```\n' + current.slice(0, 1900) + '\n```', flags: MessageFlags.Ephemeral });
        await interaction.followUp({
          content: 'Отправьте новый текст следующим сообщением в этом канале (10 минут на ответ).',
          flags: MessageFlags.Ephemeral,
        });

        const filter = (m) => m.author.id === interaction.user.id;
        let collected;
        try {
          collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 600000, errors: ['time'] });
        } catch (_) {
          await interaction.followUp({ content: 'Время ожидания истекло, изменение отменено.', flags: MessageFlags.Ephemeral });
          return;
        }
        const newText = collected.first().content;
        pendingUpdates.set(`${type}:${interaction.user.id}`, newText);

        const typeLabels = { rules: 'правила', agitation: 'агитация', hr_info: 'вакансия HR' };
        await interaction.channel.send({
          content: `Предпросмотр нового текста (${typeLabels[type]}) от <@${interaction.user.id}>:`,
          embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription(newText.slice(0, 4000))],
          components: [row(
            new ButtonBuilder().setCustomId(`${type}_save:${interaction.user.id}`).setLabel('💾 Сохранить').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${type}_cancel:${interaction.user.id}`).setLabel('❌ Отменить').setStyle(ButtonStyle.Danger),
          )],
        });
        return;
      }
      return;
    }

    // ----- Кнопки -----
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith('contract_fulfilled:') || id.startsWith('contract_unfulfilled:') || id.startsWith('contract_rejected:')) {
        if (!perms.canReview(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав проверять контракты.');
        }
        const [prefix, contractId] = id.split(':');
        const status = prefix.replace('contract_', ''); // fulfilled | unfulfilled | rejected
        const contract = await contracts.getContractById(contractId);
        if (!contract) return safeReply(interaction, 'Запись не найдена.');
        if (contract.status !== 'pending') return safeReply(interaction, 'Этот скриншот уже проверен.');

        await contracts.reviewContract(contractId, status, interaction.user.id);

        const labels = {
          fulfilled: '✅ Контракт выполнен',
          unfulfilled: '❌ Контракт не выполнен',
          rejected: '🚫 Это не контракт — не засчитано',
        };
        const label = labels[status];
        try {
          await interaction.update({ content: `${label} — проверил <@${interaction.user.id}>`, components: [] });
        } catch (_) {
          await safeReply(interaction, `${label}.`);
        }

        await contractsDisplay.safeUpdateContractsStats(guild);
        await logAudit(
          guild,
          interaction.user,
          `Контракт: ${label}`,
          `<@${contract.discord_id}>: ${contract.message_url}`,
        );
        return;
      }

      if (id === 'contracts_prev_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return contractsDisplay.changeContractsWeek(guild, 1);
      }

      if (id === 'contracts_next_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return contractsDisplay.changeContractsWeek(guild, -1);
      }

      if (id === 'contracts_this_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return contractsDisplay.jumpToCurrentWeek(guild);
      }

      if (id === 'contracts_add') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        return interaction.showModal(buildPickSearchModal('contract_add'));
      }

      if (id === 'contracts_remove') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        return interaction.showModal(buildPickSearchModal('contract_remove'));
      }

      if (id === 'contracts_search') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        return interaction.showModal(buildPickSearchModal('contract_view'));
      }

      if (id.startsWith('contract_manual_status:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const [, status, discordId] = id.split(':');
        return interaction.showModal(buildManualContractModal(status, discordId));
      }

      if (id === 'faq_add') {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        return safeReply(interaction, {
          content: 'Для какого канала добавить гайд?',
          components: [row(
            new ButtonBuilder().setCustomId('faq_add_category:member').setLabel('Участники').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('faq_add_category:hr').setLabel('HR-Менеджеры').setStyle(ButtonStyle.Primary),
          )],
        });
      }

      if (id.startsWith('faq_add_category:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const category = id.split(':')[1];
        return interaction.showModal(buildFaqModal(`modal_faq_add:${category}`));
      }

      if (id === 'faq_edit' || id === 'faq_delete') {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const action = id.split('_')[1]; // edit | delete
        return safeReply(interaction, {
          content: 'Из какого канала гайд?',
          components: [row(
            new ButtonBuilder().setCustomId(`faq_${action}_category:member`).setLabel('Участники').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`faq_${action}_category:hr`).setLabel('HR-Менеджеры').setStyle(ButtonStyle.Primary),
          )],
        });
      }

      if (id.startsWith('faq_edit_category:') || id.startsWith('faq_delete_category:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const action = id.split('_')[1]; // edit | delete
        const category = id.split(':')[1];
        const entries = await faq.listEntries(category);
        if (entries.length === 0) return safeReply(interaction, 'В этом разделе пока нет гайдов.');
        const select = new StringSelectMenuBuilder()
          .setCustomId(`select_faq_${action}:${category}`)
          .setPlaceholder('Выберите гайд')
          .addOptions(entries.map((e) => new StringSelectMenuOptionBuilder().setLabel(e.title.slice(0, 100)).setValue(String(e.id))));
        return safeReply(interaction, { components: [row(select)] });
      }

      if (id.startsWith('faq_delete_confirm:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const [, entryId, category] = id.split(':');
        const entry = await faq.getEntry(entryId);
        await faq.deleteEntry(entryId);
        await faqDisplay.safeUpdateFaqChannel(guild, category);
        await logAudit(guild, interaction.user, 'Гайд FAQ удалён', `[${category}] «${entry ? entry.title : entryId}»`);
        await interaction.update({ content: '✅ Гайд удалён.', components: [] });
        return;
      }

      if (id === 'faq_delete_cancel') {
        await interaction.update({ content: '❌ Отменено.', components: [] });
        return;
      }

      if (id.startsWith('broadcast_target:')) {
        const [, scope, userId] = id.split(':');
        if (interaction.user.id !== userId) return safeReply(interaction, '⛔ Эта рассылка не ваша.');
        const pending = pendingBroadcasts.get(userId);
        if (!pending) return safeReply(interaction, '⛔ Время ожидания истекло, начните заново командой /broadcast_message.');

        if (scope === 'all') {
          try {
            await interaction.update({
              content: `Отправить всем в организации это сообщение?\n\n> ${pending.text.slice(0, 300)}`,
              components: [row(
                new ButtonBuilder().setCustomId(`broadcast_confirm:all:${userId}`).setLabel('✅ Отправить').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`broadcast_cancel:${userId}`).setLabel('❌ Не отправлять').setStyle(ButtonStyle.Danger),
              )],
            });
          } catch (_) {}
          return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_broadcast_target:${userId}`).setTitle('Кому отправить');
        modal.addComponents(row(txt(null, 'query', 'Имя Фамилия / № Паспорта / тег / ID')));
        return interaction.showModal(modal);
      }

      if (id.startsWith('broadcast_confirm:')) {
        const [, scope, userId] = id.split(':');
        if (interaction.user.id !== userId) return safeReply(interaction, '⛔ Эта рассылка не ваша.');
        const pending = pendingBroadcasts.get(userId);
        if (!pending) return safeReply(interaction, '⛔ Время ожидания истекло.');
        pendingBroadcasts.delete(userId);

        const targets = scope === 'all' ? await db.all('SELECT * FROM participants') : [await db.get('SELECT * FROM participants WHERE discord_id = ?', [pending.targetId])];
        let sent = 0;
        for (const t of targets) {
          if (!t) continue;
          try {
            const member = await guild.members.fetch(t.discord_id);
            await member.send(pending.text);
            sent++;
          } catch (_) {}
          await sleep(500);
        }

        await logAudit(guild, interaction.user, 'Рассылка сообщения', `${scope === 'all' ? `Всем (${sent}/${targets.length})` : `Одному: <@${pending.targetId}>`}\n> ${pending.text.slice(0, 300)}`);
        try {
          await interaction.update({ content: `✅ Отправлено (${sent}/${targets.length}).`, components: [] });
        } catch (_) {}
        return;
      }

      if (id.startsWith('broadcast_cancel:')) {
        const userId = id.split(':')[1];
        pendingBroadcasts.delete(userId);
        try {
          await interaction.update({ content: '❌ Рассылка отменена.', components: [] });
        } catch (_) {}
        return;
      }

      if (id === 'invitations_prev_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return invitationsDisplay.changeInvitationsWeek(guild, 1);
      }

      if (id === 'applications_prev_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return applicationsDisplay.changeApplicationsWeek(guild, 1);
      }

      if (id === 'applications_next_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return applicationsDisplay.changeApplicationsWeek(guild, -1);
      }

      if (id === 'applications_this_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return applicationsDisplay.jumpToCurrentWeek(guild);
      }

      if (id === 'invitations_next_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return invitationsDisplay.changeInvitationsWeek(guild, -1);
      }

      if (id === 'invitations_this_week') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        await interaction.deferUpdate();
        return invitationsDisplay.jumpToCurrentWeek(guild);
      }

      if (id === 'invitations_add') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        return interaction.showModal(buildPickSearchModal('invitation_add_inviter'));
      }

      if (id === 'invitations_remove') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        return interaction.showModal(buildPickSearchModal('invitation_remove'));
      }

      if (id === 'invitations_search') {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        return interaction.showModal(buildPickSearchModal('invitation_view'));
      }

      if (id === 'apply_submit') {
        const existing = await db.get('SELECT id FROM participants WHERE discord_id = ?', [interaction.user.id]);
        if (existing) {
          return interaction.showModal(buildPassportRequestModal());
        }

        const lastRejected = await db.get(
          `SELECT * FROM applications WHERE discord_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1`,
          [interaction.user.id],
        );
        if (lastRejected) {
          const cooldownMs = APPLICATION_COOLDOWN_HOURS * 60 * 60 * 1000;
          const elapsed = Date.now() - new Date(lastRejected.created_at).getTime();
          if (elapsed < cooldownMs) {
            const retryAt = Math.floor((new Date(lastRejected.created_at).getTime() + cooldownMs) / 1000);
            return safeReply(interaction, `⛔ Ваша прошлая заявка была отклонена. Подать новую можно будет <t:${retryAt}:R>.`);
          }
        }

        return interaction.showModal(buildApplicationModal('modal_apply'));
      }

      if (id === 'kick_submit') {
        return interaction.showModal(buildKickApplicationModal('modal_kick', {}, true));
      }

      if (id === 'vacation_apply') {
        return interaction.showModal(buildVacationSelfModal());
      }

      if (id.startsWith('vacation_selfcancel:')) {
        const discordId = id.split(':')[1];
        if (interaction.user.id !== discordId) {
          return safeReply(interaction, '⛔ Это не ваш отпуск.');
        }
        const identity = await passportsLib.computeEffectiveIdentity(discordId);
        if (identity) {
          await passportsLib.updatePassportFields(discordId, identity.static, { vacation_until: null });
          await history.logStatusRevoked('vacation', discordId, identity.static, identity.name, discordId);
        }
        await syncStatusRoles(guild, discordId);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Отпуск отменён участником', `<@${discordId}>`);
        try {
          await interaction.update({ content: '✅ Ваш отпуск отменён.', components: [] });
        } catch (_) {
          await safeReply(interaction, '✅ Ваш отпуск отменён.');
        }
        return;
      }

      if (id.startsWith('vacation_accept:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const vId = id.split(':')[1];
        const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
        if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [v.discord_id]);
        if (!participant) return safeReply(interaction, 'Этот пользователь не найден в списке участников.');

        const identity = await passportsLib.computeEffectiveIdentity(v.discord_id);
        if (identity) {
          await passportsLib.updatePassportFields(v.discord_id, identity.static, { vacation_until: v.until });
        }
        await syncStatusRoles(guild, v.discord_id);
        await db.run('UPDATE vacations SET status = ? WHERE id = ?', ['accepted', vId]);
        await refreshReviewMessage(interaction.channel, v.message_id, vacationReviewEmbed({ ...v, status: 'accepted' }), [], actionSummary(interaction.user.id, '✅ Одобрено'));
        await safeUpdateMembersList(guild);
        await dmUser(guild, v.discord_id, {
          content: `🏖️ Ваш отпуск одобрен до **${formatDateTime(new Date(v.until))}**.`,
          components: [row(new ButtonBuilder().setCustomId(`vacation_selfcancel:${v.discord_id}`).setLabel('❌ Отменить отпуск').setStyle(ButtonStyle.Danger))],
        });
        await logAudit(guild, interaction.user, 'Отпуск одобрен', `Заявка #${vId}: <@${v.discord_id}> до ${formatDateTime(new Date(v.until))}`);
        return safeReply(interaction, 'Отпуск одобрен.');
      }

      if (id.startsWith('vacation_reject:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const vId = id.split(':')[1];
        const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
        if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return interaction.showModal(buildRejectReasonModal(`modal_vacation_reject:${vId}`));
      }

      if (id.startsWith('apply_edit:')) {
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildApplicationModal(`modal_apply_edit:${appId}`, app));
      }

      if (id.startsWith('apply_accept:')) {
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildApplicationModal(`modal_apply_accept:${appId}`, app));
      }

      if (id === 'data_change_apply') {
        const passports = await passportsLib.getAllPassports(interaction.user.id);
        if (passports.length === 0) return safeReply(interaction, '⛔ Вы не состоите в организации.');
        if (passports.length === 1) {
          return interaction.showModal(buildDataChangeModal(`modal_data_change:${passports[0].static}`, { new_name: passports[0].name }));
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId('select_data_change_passport')
          .setPlaceholder('Выберите паспорт, у которого изменить Имя Фамилию')
          .addOptions(passports.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)));
        return safeReply(interaction, { components: [row(select)] });
      }

      if (id.startsWith('data_change_accept:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM data_change_requests WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        await passportsLib.updatePassportFields(reqRow.discord_id, reqRow.target_static, { name: reqRow.new_name });
        await syncEffectiveIdentity(guild, reqRow.discord_id);
        await syncProfileChannelName(guild, reqRow.discord_id, reqRow.target_static);
        await safeUpdateMembersList(guild);
        await db.run('UPDATE data_change_requests SET status = ? WHERE id = ?', ['accepted', reqId]);

        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildDataChangeEmbed({ ...reqRow, status: 'accepted' }),
          [],
          actionSummary(interaction.user.id, '✅ Принято'),
        );
        await dmUser(guild, reqRow.discord_id, `✅ Ваша заявка на изменение данных (№ ${reqRow.target_static}) принята: теперь «${reqRow.new_name}».`);
        await logAudit(guild, interaction.user, 'Данные изменены по заявке', `Заявка #${reqId}: <@${reqRow.discord_id}> — № ${reqRow.target_static}: «${reqRow.old_name}» → «${reqRow.new_name}»`);
        return safeReply(interaction, 'Данные изменены.');
      }

      if (id.startsWith('data_change_reject:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM data_change_requests WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return interaction.showModal(buildRejectReasonModal(`modal_data_change_reject:${reqId}`));
      }

      if (id === 'hr_apply_submit') {
        const participant = await db.get('SELECT id FROM participants WHERE discord_id = ?', [interaction.user.id]);
        if (!participant) return safeReply(interaction, '⛔ Подать заявку могут только участники организации.');
        if (interaction.member.roles.cache.has(config.ROLE_HR)) return safeReply(interaction, '⛔ У вас уже есть роль HR-Менеджера.');
        return interaction.showModal(buildHrApplyModal());
      }

      if (id.startsWith('hr_apply_accept:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ Принимать заявки на HR может только Владелец/Зам. Владелец.');
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM hr_applications WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        try {
          const member = await guild.members.fetch(reqRow.discord_id);
          await member.roles.add(config.ROLE_HR);
        } catch (err) {
          return safeReply(interaction, '⛔ Не удалось выдать роль (проверьте права бота).');
        }
        await db.run('UPDATE hr_applications SET status = ? WHERE id = ?', ['accepted', reqId]);

        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildHrApplyEmbed({ ...reqRow, status: 'accepted' }),
          [],
          actionSummary(interaction.user.id, '✅ Принято'),
        );
        await dmUser(guild, reqRow.discord_id, '✅ Ваша заявка на роль HR-Менеджера принята!');
        await logAudit(guild, interaction.user, 'Заявка на HR принята', `Заявка #${reqId}: <@${reqRow.discord_id}> получил(а) роль HR-Менеджера`);
        return safeReply(interaction, 'Заявка принята, роль выдана.');
      }

      if (id.startsWith('hr_apply_reject:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ Отклонять заявки на HR может только Владелец/Зам. Владелец.');
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM hr_applications WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return interaction.showModal(buildRejectReasonModal(`modal_hr_apply_reject:${reqId}`));
      }

      if (id.startsWith('passport_request_accept:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM passport_requests WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        if (await passportsLib.isStaticTaken(reqRow.static)) {
          return safeReply(interaction, '⛔ Такой № Паспорта уже занят — принять нельзя.');
        }

        try {
          await passportsLib.addExtraPassport(reqRow.discord_id, reqRow.name, reqRow.static, interaction.user.id);
        } catch (err) {
          return safeReply(interaction, `⛔ ${err.message}`);
        }
        await db.run('UPDATE passport_requests SET status = ?, accepted_by = ? WHERE id = ?', ['accepted', interaction.user.id, reqId]);
        await syncEffectiveIdentity(guild, reqRow.discord_id);
        await history.logJoined(reqRow.discord_id, reqRow.static, reqRow.name, `Добавлен паспорт по заявке #${reqId}`);
        const newPassportChannelUrl = await createProfileThread(guild, reqRow.discord_id, reqRow.name, reqRow.static);
        if (newPassportChannelUrl) {
          await dmUser(guild, reqRow.discord_id, `📸 Канал с отчётами для паспорта № ${reqRow.static}: ${newPassportChannelUrl}`);
        }
        await safeUpdateMembersList(guild);

        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildPassportRequestEmbed({ ...reqRow, status: 'accepted' }),
          [],
          actionSummary(interaction.user.id, '✅ Принято'),
        );
        await dmUser(guild, reqRow.discord_id, `✅ Ваша заявка на добавление паспорта (${reqRow.name}, № ${reqRow.static}) принята.`);
        await logAudit(guild, interaction.user, 'Паспорт добавлен по заявке', `Заявка #${reqId}: <@${reqRow.discord_id}> — ${reqRow.name}, № ${reqRow.static}`);
        return safeReply(interaction, 'Паспорт добавлен.');
      }

      if (id.startsWith('passport_request_reject:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM passport_requests WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return interaction.showModal(buildRejectReasonModal(`modal_passport_request_reject:${reqId}`));
      }

      if (id.startsWith('apply_reject:')) {
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildRejectReasonModal(`modal_apply_reject:${appId}`));
      }

      if (id.startsWith('kick_edit:')) {
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildKickApplicationModal(`modal_kick_edit:${kickId}`, k, true));
      }

      if (id.startsWith('kick_confirm:')) {
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildKickApplicationModal(`modal_kick_confirm:${kickId}`, k));
      }

      if (id.startsWith('kick_reject:')) {
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildRejectReasonModal(`modal_kick_reject:${kickId}`));
      }

      if (id.startsWith('members_pick:')) {
        const action = id.split(':')[1];
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        if (action === 'add') {
          return interaction.showModal(buildMemberModal('modal_members_add', {}, interaction.user.id === config.OWNER_USER_ID));
        }
        return interaction.showModal(buildPickSearchModal(action));
      }

      if (id.startsWith('giveaway_enter:')) {
        const giveawayId = id.split(':')[1];
        const giveaway = await giveaways.getGiveaway(giveawayId);
        if (!giveaway || giveaway.status !== 'active') {
          return safeReply(interaction, '⛔ Этот розыгрыш уже завершён.');
        }
        const already = await giveaways.hasEntry(giveawayId, interaction.user.id);
        if (already) {
          await giveaways.removeEntry(giveawayId, interaction.user.id);
        } else {
          await giveaways.addEntry(giveawayId, interaction.user.id);
        }
        const count = await giveaways.countEntries(giveawayId);
        try {
          const channel = await guild.channels.fetch(giveaway.channel_id);
          const msg = await channel.messages.fetch(giveaway.message_id);
          await msg.edit({ embeds: [buildGiveawayEmbed(giveaway, count)] });
        } catch (_) {}
        await logAudit(guild, interaction.user, already ? 'Выход из розыгрыша' : 'Участие в розыгрыше', `«${giveaway.prize}»`);
        return safeReply(interaction, already ? '❌ Вы вышли из розыгрыша.' : '✅ Вы участвуете в розыгрыше! Удачи 🍀');
      }

      if (id.startsWith('my_profile:')) {
        const discordId = id.split(':')[1];
        const isOwnerOfChannel = interaction.user.id === discordId;
        const isManagement = perms.canReview(interaction.member);
        if (!isOwnerOfChannel && !isManagement) {
          return safeReply(interaction, '⛔ Это не ваш профиль.');
        }
        const embeds = await buildProfileEmbeds(guild, discordId);
        if (!embeds) return safeReply(interaction, 'Профиль не найден.');
        // Руководству — с кнопками управления, самому человеку — только просмотр
        return safeReply(interaction, isManagement ? { embeds, components: buildProfileComponents(discordId) } : { embeds });
      }

      if (id.startsWith('profile_action:')) {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        const [, action, discordId] = id.split(':');
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе.');
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ С этим участником нельзя взаимодействовать.');
        }
        return handleParticipantAction(interaction, guild, action, discordId, participant);
      }

      if (id === 'members_search') {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        return interaction.showModal(buildPickSearchModal('view_profile'));
      }

      if (id === 'members_prev') {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        await interaction.deferUpdate();
        return changeMembersPage(guild, -1);
      }

      if (id === 'members_next') {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        await interaction.deferUpdate();
        return changeMembersPage(guild, 1);
      }

      if (id.startsWith('passport_add:')) {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        const discordId = id.split(':')[1];
        return interaction.showModal(buildPassportModal(discordId));
      }

      if (id.startsWith('passport_remove:')) {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        const discordId = id.split(':')[1];
        const extras = await db.all('SELECT * FROM extra_passports WHERE discord_id = ? ORDER BY position', [discordId]);
        if (extras.length === 0) return safeReply(interaction, 'У этого участника нет дополнительных паспортов.');
        const select = new StringSelectMenuBuilder()
          .setCustomId(`select_passport_remove:${discordId}`)
          .setPlaceholder('Выберите паспорт для удаления')
          .addOptions(extras.map((e) => new StringSelectMenuOptionBuilder().setLabel(`${e.name} (№ ${e.static})`).setValue(e.static)));
        return safeReply(interaction, { components: [row(select)] });
      }

      if (id === 'blacklist_add') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        return interaction.showModal(buildBlacklistAddModal());
      }

      if (id === 'blacklist_add_nodiscord') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        return interaction.showModal(buildBlacklistAddNoDiscordModal());
      }

      if (id === 'blacklist_remove') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        return interaction.showModal(buildBlacklistRemoveModal());
      }

      if (id === 'blacklist_search') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const modal = new ModalBuilder().setCustomId('modal_blacklist_search').setTitle('Поиск в ЧС');
        modal.addComponents(row(txt(null, 'query', 'Тег / ID / № Паспорта / Причина')));
        return interaction.showModal(modal);
      }

      if (id.startsWith('blacklist_confirm_remove:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const idsCsv = id.split(':')[1];
        const ids = idsCsv.split(',');
        const reason = pendingBlacklistReasons.get(interaction.user.id) || '';
        pendingBlacklistReasons.delete(interaction.user.id);
        for (const entryId of ids) {
          await db.run('DELETE FROM blacklist WHERE id = ?', [entryId]);
        }
        await safeUpdateBlacklist(guild);
        await logAudit(guild, interaction.user, 'Удаление из ЧС', `Записи #${ids.join(', #')}. Причина: ${reason || '—'}`);
        await interaction.update({ content: '✅ Записи удалены из чёрного списка.', embeds: [], components: [] });
        return;
      }

      if (id === 'blacklist_cancel_remove') {
        pendingBlacklistReasons.delete(interaction.user.id);
        await interaction.update({ content: '❌ Отменено.', embeds: [], components: [] });
        return;
      }

      if (id.startsWith('rules_save:') || id.startsWith('agitation_save:') || id.startsWith('hr_info_save:')) {
        const type = id.startsWith('rules_save:') ? 'rules' : id.startsWith('agitation_save:') ? 'agitation' : 'hr_info';
        const userId = id.split(':')[1];
        if (interaction.user.id !== userId) return safeReply(interaction, '⛔ Подтвердить может только тот, кто запустил обновление.');
        const text = pendingUpdates.get(`${type}:${userId}`);
        if (!text) return safeReply(interaction, '⛔ Время ожидания истекло, начните заново через команду.');
        pendingUpdates.delete(`${type}:${userId}`);
        await contentVersions.saveVersion(type, text, userId);

        const typeLabels = { rules: 'Свод правил обновлён', agitation: 'Агитация обновлена', hr_info: 'Описание вакансии HR обновлено' };

        if (type === 'rules') {
          const channel = await guild.channels.fetch(config.CHANNEL_RULES);
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил').setDescription(text)] });
        } else if (type === 'agitation') {
          const channel = await guild.channels.fetch(config.CHANNEL_AGITATION);
          await channel.send({ content: text, embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('```\n' + text + '\n```')] });
        } else {
          const channel = await guild.channels.fetch(config.CHANNEL_HR_APPLY_MENU);
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text)] });
        }

        await logAudit(guild, interaction.user, typeLabels[type], 'Текст изменён и опубликован.');
        await interaction.update({ content: '✅ Сохранено и опубликовано.', embeds: [], components: [] });
        return;
      }

      if (id.startsWith('rules_cancel:') || id.startsWith('agitation_cancel:') || id.startsWith('hr_info_cancel:')) {
        const type = id.startsWith('rules_cancel:') ? 'rules' : id.startsWith('agitation_cancel:') ? 'agitation' : 'hr_info';
        const userId = id.split(':')[1];
        if (interaction.user.id !== userId) return safeReply(interaction, '⛔ Отменить может только тот, кто запустил обновление.');
        pendingUpdates.delete(`${type}:${userId}`);
        await interaction.update({ content: '❌ Отменено.', embeds: [], components: [] });
        return;
      }

      return;
    }

    // ----- Select-меню -----
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;

      if (customId.startsWith('select_blacklist_remove:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const idsCsv = customId.split(':')[1];
        const allIds = idsCsv.split(',');
        const chosen = interaction.values[0];
        const targetIds = chosen === 'all' ? allIds : [chosen];
        return safeReply(interaction, {
          content: `Подтвердите удаление ${targetIds.length} запис(и/ей) из ЧС.`,
          components: [row(
            new ButtonBuilder().setCustomId(`blacklist_confirm_remove:${targetIds.join(',')}`).setLabel('✅ Подтвердить').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('blacklist_cancel_remove').setLabel('❌ Отменить').setStyle(ButtonStyle.Secondary),
          )],
        });
      }

      if (customId.startsWith('select_passport_remove:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const discordId = customId.split(':')[1];
        const staticValue = interaction.values[0];
        const passports = await passportsLib.getAllPassports(discordId);
        const removedPassport = passports.find((p) => p.static === staticValue);
        await passportsLib.removeExtraPassport(discordId, staticValue);
        if (removedPassport) {
          await history.logLeft(discordId, removedPassport.static, removedPassport.name, 'Паспорт удалён вручную');
          await archiveProfileChannel(guild, discordId, removedPassport.profile_thread_id);
        }
        await syncEffectiveIdentity(guild, discordId);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Паспорт удалён', `<@${discordId}>: № ${staticValue}`);
        return safeReply(interaction, 'Паспорт удалён.');
      }

      if (customId.startsWith('select_contract_remove:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const discordId = customId.split(':')[1];
        const contractId = interaction.values[0];
        const contract = await contracts.getContractById(contractId);
        if (!contract) return safeReply(interaction, 'Запись уже не существует.');
        await contracts.deleteContract(contractId);
        await contractsDisplay.safeUpdateContractsStats(guild);
        await logAudit(guild, interaction.user, 'Контракт удалён вручную', `<@${discordId}>: ${contract.message_url} (было: ${contract.status})`);
        return safeReply(interaction, 'Запись удалена.');
      }

      if (customId.startsWith('select_invitation_remove:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const inviterId = customId.split(':')[1];
        const invitationId = interaction.values[0];
        const invite = await invitations.getInvitationById(invitationId);
        if (!invite) return safeReply(interaction, 'Запись уже не существует.');
        await invitations.deleteInvitation(invitationId);
        await invitationsDisplay.safeUpdateInvitations(guild);
        await logAudit(guild, interaction.user, 'Приглашение удалено вручную', `<@${inviterId}> → <@${invite.invitee_discord_id}> (было: ${invite.status})`);
        return safeReply(interaction, 'Запись удалена.');
      }

      if (customId.startsWith('select_vacation_grant_scope:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const discordId = customId.split(':')[1];
        return interaction.showModal(buildVacationGrantModal(discordId, interaction.values.join(',')));
      }

      if (customId.startsWith('select_vacation_revoke_scope:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const discordId = customId.split(':')[1];
        const removedNames = [];
        for (const staticValue of interaction.values) {
          const passport = (await passportsLib.getAllPassports(discordId)).find((p) => p.static === staticValue);
          await passportsLib.updatePassportFields(discordId, staticValue, { vacation_until: null });
          if (passport) {
            removedNames.push(`${passport.name} (№ ${passport.static})`);
            await history.logStatusRevoked('vacation', discordId, staticValue, passport.name, interaction.user.id);
          }
        }
        await syncStatusRoles(guild, discordId);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Отпуск снят', `<@${discordId}>: ${removedNames.join(', ')}`);
        await dmUser(guild, discordId, `📢 Ваш отпуск (${removedNames.join(', ')}) был досрочно завершён администрацией.`);
        return safeReply(interaction, `Отпуск снят: ${removedNames.join(', ')}.`);
      }

      if (customId.startsWith('select_afk_set_scope:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const discordId = customId.split(':')[1];
        return interaction.showModal(buildAfkModal(discordId, interaction.values.join(',')));
      }

      if (customId.startsWith('select_afk_revoke_scope:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const discordId = customId.split(':')[1];
        const removedNames = [];
        for (const staticValue of interaction.values) {
          const passport = (await passportsLib.getAllPassports(discordId)).find((p) => p.static === staticValue);
          await passportsLib.updatePassportFields(discordId, staticValue, { afk_since: null });
          if (passport) {
            removedNames.push(`${passport.name} (№ ${passport.static})`);
            await history.logStatusRevoked('afk', discordId, staticValue, passport.name, interaction.user.id);
          }
        }
        await syncStatusRoles(guild, discordId);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'AFK снят', `<@${discordId}>: ${removedNames.join(', ')}`);
        return safeReply(interaction, `AFK снят: ${removedNames.join(', ')}.`);
      }

      if (customId.startsWith('faq_view:')) {
        const entryId = interaction.values[0];
        const entry = await faq.getEntry(entryId);
        if (!entry) return safeReply(interaction, 'Этот гайд больше не существует — возможно, его удалили.');
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`❓ ${entry.title}`)
          .setDescription(entry.content.slice(0, 4000));
        return safeReply(interaction, { embeds: [embed] });
      }

      if (customId.startsWith('select_faq_edit:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const entryId = interaction.values[0];
        const entry = await faq.getEntry(entryId);
        if (!entry) return safeReply(interaction, 'Гайд не найден.');
        return interaction.showModal(buildFaqModal(`modal_faq_edit:${entryId}`, entry));
      }

      if (customId.startsWith('select_faq_delete:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const category = customId.split(':')[1];
        const entryId = interaction.values[0];
        const entry = await faq.getEntry(entryId);
        if (!entry) return safeReply(interaction, 'Гайд не найден.');
        return safeReply(interaction, {
          content: `Удалить гайд «${entry.title}»?`,
          components: [row(
            new ButtonBuilder().setCustomId(`faq_delete_confirm:${entryId}:${category}`).setLabel('✅ Подтвердить').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('faq_delete_cancel').setLabel('❌ Отменить').setStyle(ButtonStyle.Secondary),
          )],
        });
      }

      if (customId === 'select_data_change_passport') {
        const staticValue = interaction.values[0];
        const passports = await passportsLib.getAllPassports(interaction.user.id);
        const passport = passports.find((p) => p.static === staticValue);
        if (!passport) return safeReply(interaction, 'Паспорт не найден.');
        return interaction.showModal(buildDataChangeModal(`modal_data_change:${staticValue}`, { new_name: passport.name }));
      }

      if (customId.startsWith('select_kick_scope:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const discordId = customId.split(':')[1];
        const scope = interaction.values[0];
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе.');
        return interaction.showModal(buildKickApplicationModal(`modal_members_kick:${discordId}:${scope}`, { name: participant.name }));
      }

      if (customId.startsWith('select_promote_scope:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const [, action, discordId] = customId.split(':');
        const scope = interaction.values[0];
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе.');
        return startRankSelection(interaction, guild, action, discordId, scope, participant.name);
      }

      // Шаг 2/3 повышения/понижения: конкретный ранг уже выбран — применяем его
      if (customId.startsWith('select_rank:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const [, action, discordId, scope] = customId.split(':');
        const newRoleId = interaction.values[0];
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе (возможно, был изменён список).');
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ Этому участнику нельзя менять роль.');
        }
        if (!perms.canActOnRank(interaction.member, newRoleId)) {
          return safeReply(interaction, '⛔ У вас недостаточно прав, чтобы назначить этот ранг.');
        }

        const passports = await passportsLib.getAllPassports(discordId);
        const targets = scope === 'all' ? passports : passports.filter((p) => p.static === scope);
        if (targets.length === 0) return safeReply(interaction, 'Паспорт(а) не найдены.');

        const updated = [];
        const skipped = [];
        for (const p of targets) {
          if (!perms.canActOnRank(interaction.member, p.role_id)) {
            skipped.push(`${p.name} (№ ${p.static}) — недостаточно прав`);
            continue;
          }
          if (scope === 'all') {
            const curIdx = getRoleIndex(p.role_id);
            const newIdx = getRoleIndex(newRoleId);
            const directionOk = curIdx === -1 || (action === 'promote' ? newIdx < curIdx : newIdx > curIdx);
            if (!directionOk) {
              skipped.push(`${p.name} (№ ${p.static}) — уже на этом ранге или в другом направлении`);
              continue;
            }
          }
          await passportsLib.updatePassportFields(discordId, p.static, { role_id: newRoleId });
          updated.push(`${p.name} (№ ${p.static}): <@&${p.role_id}> → <@&${newRoleId}>`);
        }

        if (updated.length === 0) {
          return safeReply(interaction, `Ничего не изменено.${skipped.length ? `\n${skipped.join('\n')}` : ''}`);
        }

        await syncEffectiveIdentity(guild, discordId);
        await safeUpdateMembersList(guild);
        await logAudit(
          guild,
          interaction.user,
          action === 'promote' ? 'Повышение' : 'Понижение',
          `<@${discordId}> (${participant.name}):\n${updated.join('\n')}`,
        );
        return safeReply(
          interaction,
          `Ранг обновлён:\n${updated.join('\n')}${skipped.length ? `\n\nПропущено:\n${skipped.join('\n')}` : ''}`,
        );
      }

      // Шаг после members_pick: конкретный участник выбран через поиск
      if (customId.startsWith('select_pick:')) {
        const action = customId.slice('select_pick:'.length);
        const isContractAction = action === 'contract_add' || action === 'contract_remove' || action === 'contract_view';
        const isInvitationAction = action === 'invitation_add_inviter' || action.startsWith('invitation_add_invitee:') || action === 'invitation_remove' || action === 'invitation_view';
        const allowed = (isContractAction || isInvitationAction) ? perms.canReview(interaction.member) : perms.canManageMembersList(interaction.member);
        if (!allowed) return safeReply(interaction, '⛔ У вас нет прав для этого действия.');
        const discordId = interaction.values[0];
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе (возможно, был изменён список).');
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ С этим участником нельзя взаимодействовать.');
        }

        return handleParticipantAction(interaction, guild, action, discordId, participant);
      }

      return;
    }

    // ----- Модальные окна -----
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      const get = (name) => interaction.fields.getTextInputValue(name);

      // Подача заявки на вступление
      if (id.startsWith('modal_data_change:')) {
        const targetStatic = id.split(':')[1];
        const newName = normalizeName(get('new_name'));
        const passports = await passportsLib.getAllPassports(interaction.user.id);
        const passport = passports.find((p) => p.static === targetStatic);
        if (!passport) return safeReply(interaction, 'Паспорт не найден — возможно, был удалён.');

        const reqRow = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          target_static: targetStatic,
          old_name: passport.name,
          new_name: newName,
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const result = await db.run(
          'INSERT INTO data_change_requests (discord_id, discord_tag, target_static, old_name, new_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [reqRow.discord_id, reqRow.discord_tag, reqRow.target_static, reqRow.old_name, reqRow.new_name, reqRow.status, reqRow.created_at],
        );
        reqRow.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_DATA_CHANGE_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [buildDataChangeEmbed(reqRow)],
          components: buildDataChangeComponents(reqRow),
          ...mentionOpts,
        });
        await db.run('UPDATE data_change_requests SET message_id = ? WHERE id = ?', [sent.id, reqRow.id]);

        await logAudit(guild, interaction.user, 'Заявка на изменение данных', `Заявка #${reqRow.id} от <@${interaction.user.id}>: № ${targetStatic} «${passport.name}» → «${newName}»`);
        return safeReply(interaction, 'Заявка на изменение данных отправлена на рассмотрение.');
      }

      if (id.startsWith('modal_data_change_reject:')) {
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM data_change_requests WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const reason = get('reason');
        await db.run('UPDATE data_change_requests SET status = ?, reject_reason = ? WHERE id = ?', ['rejected', reason, reqId]);
        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildDataChangeEmbed({ ...reqRow, status: 'rejected', reject_reason: reason }),
          [],
          actionSummary(interaction.user.id, '❌ Отклонено', reason),
        );
        await dmUser(guild, reqRow.discord_id, `❌ Ваша заявка на изменение данных отклонена. Причина: ${reason}`);
        await logAudit(guild, interaction.user, 'Заявка на изменение данных отклонена', `Заявка #${reqId} от <@${reqRow.discord_id}>. Причина: ${reason}`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      if (id === 'modal_hr_apply') {
        const reqRow = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          hours_per_week: get('hours_per_week'),
          training_ready: get('training_ready'),
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const result = await db.run(
          'INSERT INTO hr_applications (discord_id, discord_tag, hours_per_week, training_ready, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [reqRow.discord_id, reqRow.discord_tag, reqRow.hours_per_week, reqRow.training_ready, reqRow.status, reqRow.created_at],
        );
        reqRow.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_HR_APPLY_REVIEW);
        const sent = await reviewChannel.send({
          content: config.ROLES_MEMBERS_LIST_ALLOWED.map((r) => `<@&${r}>`).join(' '),
          embeds: [buildHrApplyEmbed(reqRow)],
          components: buildHrApplyComponents(reqRow),
          allowedMentions: { roles: config.ROLES_MEMBERS_LIST_ALLOWED },
        });
        await db.run('UPDATE hr_applications SET message_id = ? WHERE id = ?', [sent.id, reqRow.id]);

        await logAudit(guild, interaction.user, 'Новая заявка на роль HR', `Заявка #${reqRow.id} от <@${interaction.user.id}>`);
        return safeReply(interaction, 'Заявка на роль HR-Менеджера отправлена на рассмотрение.');
      }

      if (id.startsWith('modal_hr_apply_reject:')) {
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM hr_applications WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const reason = get('reason');
        await db.run('UPDATE hr_applications SET status = ?, reject_reason = ? WHERE id = ?', ['rejected', reason, reqId]);
        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildHrApplyEmbed({ ...reqRow, status: 'rejected', reject_reason: reason }),
          [],
          actionSummary(interaction.user.id, '❌ Отклонено', reason),
        );
        await logAudit(guild, interaction.user, 'Заявка на HR отклонена', `Заявка #${reqId} от <@${reqRow.discord_id}>. Причина: ${reason}`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      if (id === 'modal_passport_request') {
        const name = normalizeName(get('name'));
        const staticValue = get('static');
        if (!isValidStatic(staticValue)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        if (await passportsLib.isStaticTaken(staticValue)) {
          return safeReply(interaction, 'Такой № Паспорта уже используется.');
        }

        const reqRow = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          name,
          static: staticValue,
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const result = await db.run(
          'INSERT INTO passport_requests (discord_id, discord_tag, name, static, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [reqRow.discord_id, reqRow.discord_tag, reqRow.name, reqRow.static, reqRow.status, reqRow.created_at],
        );
        reqRow.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [buildPassportRequestEmbed(reqRow)],
          components: buildPassportRequestComponents(reqRow),
          ...mentionOpts,
        });
        await db.run('UPDATE passport_requests SET message_id = ? WHERE id = ?', [sent.id, reqRow.id]);

        await logAudit(guild, interaction.user, 'Заявка на добавление паспорта', `Заявка #${reqRow.id} от <@${interaction.user.id}>: ${name} — № ${staticValue}`);
        return safeReply(interaction, 'Заявка на добавление паспорта отправлена на рассмотрение.');
      }

      if (id === 'modal_apply') {
        const app = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          name: normalizeName(get('name')),
          static: get('static'),
          lvl: parseInt(get('lvl'), 10) || 0,
          skills: get('skills'),
          invited_by: get('invited_by') || '',
          status: 'pending',
          created_at: new Date().toISOString(),
        };

        if (!isValidStatic(app.static)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }

        const blacklisted = await db.get('SELECT * FROM blacklist WHERE discord_id = ? OR static = ?', [app.discord_id, app.static]);
        if (blacklisted) {
          await logAudit(
            guild,
            interaction.user,
            '⛔ Заблокированная попытка подать заявку',
            `<@${app.discord_id}> — в чёрном списке (причина внесения: ${blacklisted.reason || '—'}). Заявка не создана.`,
          );
          return safeReply(interaction, '⛔ Вы находитесь в чёрном списке организации и не можете подать заявку на вступление.');
        }

        if (app.invited_by) {
          const inviter = await invitations.resolveInviter(app.invited_by);
          if (!inviter) {
            return safeReply(
              interaction,
              '⛔ Не удалось найти пригласившего по указанным данным.\n\n**Возможные причины:**\n' +
                '- Опечатка в имени, паспорте или теге\n' +
                '- Этого человека сейчас нет в организации (или он уже вышел)\n' +
                '- Указан неполный/неверный Discord тег — лучше указать Discord ID\n\n' +
                'Проверьте данные и подайте заявку заново, либо оставьте поле пустым.',
            );
          }
        }

        const result = await db.run(
          `INSERT INTO applications (discord_id, discord_tag, name, static, lvl, skills, invited_by, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [app.discord_id, app.discord_tag, app.name, app.static, app.lvl, app.skills, app.invited_by, app.status, app.created_at],
        );
        app.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [await applicationReviewEmbed(app, guild.id)],
          components: applicationReviewComponents(app),
          ...mentionOpts,
        });
        await db.run('UPDATE applications SET message_id = ? WHERE id = ?', [sent.id, app.id]);

        await logAudit(guild, interaction.user, 'Новая заявка на вступление', `Заявка #${app.id} от <@${app.discord_id}>`);
        return safeReply(interaction, 'Ваша заявка отправлена на рассмотрение.');
      }

      // Редактирование заявки на вступление
      // Отказ в заявке на добавление паспорта — с причиной
      if (id.startsWith('modal_passport_request_reject:')) {
        const reqId = id.split(':')[1];
        const reqRow = await db.get('SELECT * FROM passport_requests WHERE id = ?', [reqId]);
        if (!reqRow || reqRow.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const reason = get('reason');
        await db.run('UPDATE passport_requests SET status = ?, reject_reason = ? WHERE id = ?', ['rejected', reason, reqId]);
        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildPassportRequestEmbed({ ...reqRow, status: 'rejected', reject_reason: reason }),
          [],
          actionSummary(interaction.user.id, '❌ Отклонено', reason),
        );
        await dmUser(guild, reqRow.discord_id, `❌ Ваша заявка на добавление паспорта отклонена. Причина: ${reason}`);
        await logAudit(guild, interaction.user, 'Заявка на паспорт отклонена', `Заявка #${reqId} от <@${reqRow.discord_id}>. Причина: ${reason}`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      // Отказ в заявке на вступление — с причиной
      if (id.startsWith('modal_apply_reject:')) {
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app || app.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const reason = get('reason');
        await db.run('UPDATE applications SET status = ?, reject_reason = ?, rejected_by = ? WHERE id = ?', ['rejected', reason, interaction.user.id, appId]);
        await refreshReviewMessage(
          interaction.channel,
          app.message_id,
          await applicationReviewEmbed({ ...app, status: 'rejected', reject_reason: reason }, guild.id),
          [],
          actionSummary(interaction.user.id, '❌ Отклонено', reason),
        );
        await dmUser(guild, app.discord_id, `❌ Ваша заявка на вступление была отклонена. Причина: ${reason}`);
        await logAudit(guild, interaction.user, 'Заявка отклонена', `Заявка #${appId} от <@${app.discord_id}>. Причина: ${reason}`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      // Отказ в заявке на увольнение — с причиной
      if (id.startsWith('modal_kick_reject:')) {
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k || k.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const reason = get('reason');
        await db.run('UPDATE kicks SET status = ?, reject_reason = ? WHERE id = ?', ['rejected', reason, kickId]);
        await refreshReviewMessage(
          interaction.channel,
          k.message_id,
          await kickReviewEmbed({ ...k, status: 'rejected', reject_reason: reason }),
          [],
          actionSummary(interaction.user.id, '❌ Отклонено', reason),
        );
        await dmUser(guild, k.discord_id, `❌ Ваша заявка на увольнение была отклонена. Причина: ${reason}`);
        await logAudit(guild, interaction.user, 'Заявка на увольнение отклонена', `Заявка #${kickId} от <@${k.discord_id}>. Причина: ${reason}`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      // Отказ в заявке на отпуск — с причиной
      if (id.startsWith('modal_vacation_reject:')) {
        const vId = id.split(':')[1];
        const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
        if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const reason = get('reason');
        await db.run('UPDATE vacations SET status = ?, reject_reason = ? WHERE id = ?', ['rejected', reason, vId]);
        await refreshReviewMessage(
          interaction.channel,
          v.message_id,
          vacationReviewEmbed({ ...v, status: 'rejected', reject_reason: reason }),
          [],
          actionSummary(interaction.user.id, '❌ Отклонено', reason),
        );
        await dmUser(guild, v.discord_id, `❌ Ваша заявка на отпуск отклонена. Причина: ${reason}`);
        await logAudit(guild, interaction.user, 'Отпуск отклонён', `Заявка #${vId} от <@${v.discord_id}>. Причина: ${reason}`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      if (id.startsWith('modal_apply_edit:')) {
        const appId = id.split(':')[1];
        const fields = { name: normalizeName(get('name')), static: get('static'), lvl: parseInt(get('lvl'), 10) || 0, skills: get('skills'), invited_by: get('invited_by') || '' };
        if (!isValidStatic(fields.static)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        await db.run('UPDATE applications SET name = ?, static = ?, lvl = ?, skills = ?, invited_by = ? WHERE id = ?', [
          fields.name, fields.static, fields.lvl, fields.skills, fields.invited_by, appId,
        ]);
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        await refreshReviewMessage(interaction.channel, app.message_id, await applicationReviewEmbed(app, guild.id), applicationReviewComponents(app), actionSummary(interaction.user.id, '✏️ Изменено'));
        await logAudit(guild, interaction.user, 'Заявка изменена', `Заявка #${appId} отредактирована`);
        return safeReply(interaction, 'Заявка обновлена.');
      }

      // Принятие заявки
      if (id.startsWith('modal_apply_accept:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app || app.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        const fields = { name: normalizeName(get('name')), static: get('static'), lvl: parseInt(get('lvl'), 10) || 0, skills: get('skills'), invited_by: get('invited_by') || '' };
        if (!isValidStatic(fields.static)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }

        const blacklisted = await db.get('SELECT * FROM blacklist WHERE discord_id = ? OR static = ?', [app.discord_id, fields.static]);
        if (blacklisted) {
          await logAudit(
            guild,
            interaction.user,
            '⛔ Попытка принять заявку от человека из ЧС',
            `Заявка #${appId}: <@${app.discord_id}> — в чёрном списке. Принятие отклонено.`,
          );
          return safeReply(interaction, '⛔ Этот пользователь (или паспорт) находится в чёрном списке — принять заявку нельзя.');
        }

        const dupId = await db.get('SELECT id FROM participants WHERE discord_id = ?', [app.discord_id]);
        if (dupId) return safeReply(interaction, 'Этот пользователь уже есть в списке участников.');
        if (await passportsLib.isStaticTaken(fields.static)) {
          return safeReply(interaction, 'Такой № Паспорта уже занят другим участником.');
        }

        await db.run(
          `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [app.discord_id, app.discord_tag, fields.name, fields.static, fields.lvl, fields.skills, '', config.ROLE_APPLY, new Date().toISOString()],
        );
        await db.run('UPDATE applications SET status = ?, accepted_by = ? WHERE id = ?', ['accepted', interaction.user.id, appId]);
        await acceptances.recordAcceptance(interaction.user.id, app.discord_id, fields.name, fields.static, new Date().toISOString());

        try {
          const member = await guild.members.fetch(app.discord_id);
          await member.roles.add(config.ROLE_APPLY);
        } catch (err) {
          console.error('Не удалось выдать роль при принятии заявки:', err);
        }

        await syncEffectiveIdentity(guild, app.discord_id);
        await history.logJoined(app.discord_id, fields.static, fields.name, `Принята заявка #${appId}`);
        const profileChannelUrl = await createProfileThread(guild, app.discord_id, fields.name, fields.static);

        // Приглашение — только если пригласивший сейчас реально в списке участников (п.9)
        // и этот новый участник ещё никогда не фигурировал как приглашённый (п.8).
        if (fields.invited_by && !(await invitations.hasExistingInvitationRecord(app.discord_id))) {
          const inviter = await invitations.resolveInviter(fields.invited_by);
          if (inviter) {
            await invitations.recordInvitation(inviter.discord_id, app.discord_id, fields.name, fields.static, new Date().toISOString());
          }
        }

        await refreshReviewMessage(interaction.channel, app.message_id, await applicationReviewEmbed({ ...app, ...fields, status: 'accepted' }, guild.id), [], actionSummary(interaction.user.id, '✅ Принято'));
        await dmUser(guild, app.discord_id, '✅ Ваша заявка на вступление принята! Добро пожаловать в организацию.');
        if (profileChannelUrl) {
          await dmUser(
            guild,
            app.discord_id,
            `📸 Ваш профиль для отчётов по контрактам: ${profileChannelUrl}\n\n` +
              `Туда нужно присылать скриншоты **на весь экран** по каждому контракту — 2 штуки:\n` +
              `1️⃣ когда вы **взяли** контракт\n` +
              `2️⃣ когда контракт **выполнен или не выполнен**\n\n` +
              `Можно прислать оба скриншота одним сообщением, можно — двумя сообщениями подряд (по одному).`,
          );
        }
        const rulesText = await getCurrentText('rules', DEFAULT_RULES);
        await dmUser(guild, app.discord_id, {
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил организации').setDescription(rulesText.slice(0, 4000))],
        });
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Заявка принята', `Заявка #${appId}: <@${app.discord_id}> принят(а) в организацию`);
        return safeReply(interaction, 'Заявка принята, участник добавлен.');
      }

      // Подача заявки на увольнение
      if (id === 'modal_kick') {
        const k = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          name: normalizeName(get('name')),
          target_static: get('target_static') || 'all',
          reason: get('reason') || '',
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const result = await db.run(
          `INSERT INTO kicks (discord_id, discord_tag, name, target_static, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [k.discord_id, k.discord_tag, k.name, k.target_static, k.reason, k.status, k.created_at],
        );
        k.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_KICK_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [await kickReviewEmbed(k)],
          components: kickReviewComponents(k),
          ...mentionOpts,
        });
        await db.run('UPDATE kicks SET message_id = ? WHERE id = ?', [sent.id, k.id]);

        await logAudit(guild, interaction.user, 'Новая заявка на увольнение', `Заявка #${k.id} от <@${k.discord_id}> на участника «${k.name}»${k.target_static !== 'all' ? ` (паспорт № ${k.target_static})` : ''}`);
        return safeReply(interaction, 'Заявка на увольнение отправлена на рассмотрение.');
      }

      // Редактирование заявки на увольнение
      if (id.startsWith('modal_kick_edit:')) {
        const kickId = id.split(':')[1];
        await db.run('UPDATE kicks SET name = ?, target_static = ?, reason = ? WHERE id = ?', [normalizeName(get('name')), get('target_static') || 'all', get('reason') || '', kickId]);
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        await refreshReviewMessage(interaction.channel, k.message_id, await kickReviewEmbed(k), kickReviewComponents(k), actionSummary(interaction.user.id, '✏️ Изменено'));
        await logAudit(guild, interaction.user, 'Заявка на увольнение изменена', `Заявка #${kickId} отредактирована`);
        return safeReply(interaction, 'Заявка обновлена.');
      }

      // Подтверждение увольнения через заявку
      if (id.startsWith('modal_kick_confirm:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k || k.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        const reason = get('reason') || k.reason;
        const name = normalizeName(get('name')) || k.name;
        const targetStatic = k.target_static || 'all';

        let participant = null;
        if (targetStatic !== 'all') {
          participant = await db.get('SELECT * FROM participants WHERE static = ?', [targetStatic]);
          if (!participant) {
            const inExtra = await db.get('SELECT discord_id FROM extra_passports WHERE static = ?', [targetStatic]);
            if (inExtra) participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [inExtra.discord_id]);
          }
        }
        if (!participant) participant = await db.get('SELECT * FROM participants WHERE name = ?', [name]);

        if (participant && perms.isProtectedTarget(participant.discord_id, interaction.user.id)) {
          return safeReply(interaction, '⛔ Этого участника нельзя уволить.');
        }
        await db.run('UPDATE kicks SET status = ?, reason = ?, name = ? WHERE id = ?', ['accepted', reason, name, kickId]);

        let fullyRemoved = true;
        if (participant) {
          const result = await kickPassportOrFull(guild, participant, targetStatic, reason);
          fullyRemoved = result.fullyRemoved;
        }

        await refreshReviewMessage(interaction.channel, k.message_id, await kickReviewEmbed({ ...k, status: 'accepted', reason, name }), [], actionSummary(interaction.user.id, '🚫 Уволен(а)'));
        await logAudit(
          guild,
          interaction.user,
          fullyRemoved ? 'Участник уволен' : 'Паспорт участника снят',
          `Заявка #${kickId}: «${name}»${targetStatic !== 'all' ? ` (паспорт № ${targetStatic})` : ''}. Причина: ${reason || '—'}`,
        );
        return safeReply(interaction, fullyRemoved ? 'Участник уволен.' : 'Паспорт снят.');
      }

      // Добавление участника вручную
      if (id === 'modal_members_add') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rawDiscordId = get('discord_id').trim();
        const hasDiscord = rawDiscordId.length > 0;
        const rawStatic = get('static').trim();
        const hasStatic = rawStatic.length > 0;
        if (hasStatic && !isValidStatic(rawStatic)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        const rawName = normalizeName(get('name'));
        const fields = {
          name: rawName || 'Без имени',
          discord_id: hasDiscord ? rawDiscordId : `nodiscord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          static: hasStatic ? rawStatic : `nostatic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          lvl: parseInt(get('lvl'), 10) || 0,
          online: get('online') || '',
        };

        if (hasDiscord) {
          const dupId = await db.get('SELECT id FROM participants WHERE discord_id = ?', [fields.discord_id]);
          if (dupId) return safeReply(interaction, 'Участник с таким Discord ID уже существует.');
        }
        if (hasStatic && (await passportsLib.isStaticTaken(fields.static))) {
          return safeReply(interaction, 'Такой № Паспорта уже занят.');
        }

        let discordTag = hasDiscord ? fields.discord_id : `${fields.name} (без Discord)`;
        if (hasDiscord) {
          try {
            const member = await guild.members.fetch(fields.discord_id);
            discordTag = member.user.tag;
          } catch (_) {
            // участника нет на сервере — сохраняем как есть
          }
        }

        await db.run(
          `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [fields.discord_id, discordTag, fields.name, fields.static, fields.lvl, '', fields.online, config.ROLE_APPLY, new Date().toISOString()],
        );

        if (hasDiscord) {
          try {
            const member = await guild.members.fetch(fields.discord_id);
            await member.roles.add(config.ROLE_APPLY);
          } catch (_) {}
          await syncEffectiveIdentity(guild, fields.discord_id);
          await history.logJoined(fields.discord_id, fields.static, fields.name, 'Добавлен(а) вручную');
          const profileChannelUrl = await createProfileThread(guild, fields.discord_id, fields.name, fields.static);
          if (profileChannelUrl) {
            await dmUser(guild, fields.discord_id, `📸 Ваш профиль для отчётов по контрактам: ${profileChannelUrl}`);
          }
        }

        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Участник добавлен вручную', `${fields.name} (${hasDiscord ? `<@${fields.discord_id}>` : 'без Discord'})`);
        return safeReply(interaction, `Участник добавлен.${hasDiscord ? '' : ' (без Discord — ник/роль/канал-профиль не создавались)'}`);
      }

      // Редактирование участника из списка
      if (id.startsWith('modal_members_edit:')) {
        const discordId = id.split(':')[1];
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ Данные этого участника нельзя изменять.');
        }
        const fields = {
          name: normalizeName(get('name')),
          discord_id: get('discord_id').trim(),
          static: get('static'),
          lvl: parseInt(get('lvl'), 10) || 0,
          online: get('online') || '',
        };

        const dupId = await db.get('SELECT id FROM participants WHERE discord_id = ? AND discord_id != ?', [fields.discord_id, discordId]);
        if (dupId) return safeReply(interaction, 'Такой Discord ID уже используется другим участником.');
        if (!isValidStatic(fields.static)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        if (await passportsLib.isStaticTaken(fields.static, discordId)) {
          return safeReply(interaction, 'Такой № Паспорта уже занят другим участником.');
        }

        await db.run('UPDATE participants SET name = ?, discord_id = ?, static = ?, lvl = ?, online = ? WHERE discord_id = ?', [
          fields.name, fields.discord_id, fields.static, fields.lvl, fields.online, discordId,
        ]);

        await syncEffectiveIdentity(guild, fields.discord_id);
        await syncProfileChannelName(guild, fields.discord_id, fields.static);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Данные участника изменены', `${fields.name} (<@${fields.discord_id}>)`);
        return safeReply(interaction, 'Данные участника обновлены.');
      }

      // Увольнение через список участников
      if (id.startsWith('modal_members_kick:')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const parts = id.split(':');
        const discordId = parts[1];
        const scope = parts[2] || 'all';
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ Этого участника нельзя уволить.');
        }
        const reason = get('reason') || '';
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден.');

        const { fullyRemoved } = await kickPassportOrFull(guild, participant, scope, reason);
        await logAudit(
          guild,
          interaction.user,
          fullyRemoved ? 'Участник уволен полностью' : 'Паспорт участника снят',
          `${participant.name} (<@${discordId}>)${scope !== 'all' ? ` — паспорт № ${scope}` : ''}. Причина: ${reason || '—'}`,
        );
        return safeReply(interaction, fullyRemoved ? 'Участник уволен.' : `Паспорт № ${scope} снят.`);
      }

      // Выбор участника через поиск (для kick/edit/promote/demote/паспорта/отпуск/AFK)
      if (id.startsWith('modal_pick_search:')) {
        const action = id.slice('modal_pick_search:'.length);
        const query = get('query').trim();

        let participants;
        if (query) {
          const q = `%${query}%`;
          participants = await db.all(
            `SELECT DISTINCT p.* FROM participants p
             LEFT JOIN extra_passports e ON e.discord_id = p.discord_id
             WHERE p.name LIKE ? OR p.static LIKE ? OR e.name LIKE ? OR e.static LIKE ?
                OR p.discord_tag LIKE ? OR p.discord_id LIKE ?
             ORDER BY p.name LIMIT 25`,
            [q, q, q, q, q, q],
          );
        } else {
          participants = await db.all('SELECT * FROM participants ORDER BY name LIMIT 25');
        }

        participants = participants.filter((p) => !perms.isProtectedTarget(p.discord_id, interaction.user.id));
        if (action === 'promote' || action === 'demote') {
          participants = participants.filter((p) => perms.canActOnRank(interaction.member, p.role_id));
        }
        if (action === 'vacation_revoke') {
          participants = participants.filter((p) => p.vacation_until);
        }
        if (action === 'afk_revoke') {
          participants = participants.filter((p) => p.afk_since);
        }

        if (participants.length === 0) return safeReply(interaction, 'Совпадений не найдено.');

        const select = new StringSelectMenuBuilder()
          .setCustomId(`select_pick:${action}`)
          .setPlaceholder('Выберите участника')
          .addOptions(
            participants.map((p) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`${p.name} (${p.static})`)
                .setValue(p.discord_id)
                .setDescription(p.discord_tag || undefined),
            ),
          );
        return safeReply(interaction, { components: [row(select)] });
      }

      // Добавление паспорта
      if (id.startsWith('modal_passport_add:')) {
        const discordId = id.split(':')[1];
        const name = normalizeName(get('name'));
        const staticValue = get('static');
        if (!isValidStatic(staticValue)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        if (await passportsLib.isStaticTaken(staticValue)) {
          return safeReply(interaction, 'Такой № Паспорта уже используется.');
        }
        try {
          await passportsLib.addExtraPassport(discordId, name, staticValue, interaction.user.id);
        } catch (err) {
          return safeReply(interaction, `⛔ ${err.message}`);
        }
        await syncEffectiveIdentity(guild, discordId);
        await history.logJoined(discordId, staticValue, name, 'Паспорт добавлен вручную');
        const newPassportChannelUrl = await createProfileThread(guild, discordId, name, staticValue);
        if (newPassportChannelUrl) {
          await dmUser(guild, discordId, `📸 Канал с отчётами для паспорта № ${staticValue}: ${newPassportChannelUrl}`);
        }
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Паспорт добавлен', `<@${discordId}>: ${name} — № ${staticValue}`);
        return safeReply(interaction, 'Паспорт добавлен.');
      }

      // Ручное добавление контракта
      if (id.startsWith('modal_faq_add:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const category = id.split(':')[1];
        const title = get('title');
        const content = get('content');
        await faq.addEntry(category, title, content, interaction.user.id);
        await faqDisplay.safeUpdateFaqChannel(guild, category);
        await logAudit(guild, interaction.user, 'Гайд FAQ добавлен', `[${category}] «${title}»`);
        return safeReply(interaction, 'Гайд добавлен.');
      }

      if (id.startsWith('modal_faq_edit:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const entryId = id.split(':')[1];
        const entry = await faq.getEntry(entryId);
        if (!entry) return safeReply(interaction, 'Гайд не найден.');
        const title = get('title');
        const content = get('content');
        await faq.updateEntry(entryId, title, content, interaction.user.id);
        await faqDisplay.safeUpdateFaqChannel(guild, entry.category);
        await logAudit(guild, interaction.user, 'Гайд FAQ изменён', `[${entry.category}] «${title}»`);
        return safeReply(interaction, 'Гайд обновлён.');
      }

      if (id.startsWith('modal_contract_manual:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const [, status, discordId] = id.split(':');
        const link = get('link').trim();
        const dateInput = get('date').trim();
        let submittedAt;
        if (dateInput) {
          const date = parseDateOnly(dateInput);
          if (!date) return safeReply(interaction, '⛔ Неверный формат даты. Используйте ДД.ММ.ГГГГ или оставьте поле пустым.');
          submittedAt = date.toISOString();
        } else {
          submittedAt = new Date().toISOString();
        }

        await contracts.recordManualContract(discordId, link, submittedAt, status, interaction.user.id);
        await contractsDisplay.safeUpdateContractsStats(guild);

        const label = status === 'fulfilled' ? '✅ Выполнен' : '❌ Невыполнен';
        await logAudit(guild, interaction.user, 'Контракт добавлен вручную', `<@${discordId}>: ${label} — ${link}`);
        return safeReply(interaction, `Контракт добавлен (${label}).`);
      }

      // Заявка на отпуск (самостоятельно)
      if (id === 'modal_vacation_apply') {
        const deadline = parseDeadline(get('deadline'));
        if (!deadline) {
          return safeReply(interaction, '⛔ Неверный формат. Используйте ДД.ММ.ГГГГ (будущая дата) или число+d, например 7d.');
        }
        const reason = get('reason') || '';
        const v = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          until: deadline.toISOString(),
          reason,
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const result = await db.run(
          `INSERT INTO vacations (discord_id, discord_tag, until, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [v.discord_id, v.discord_tag, v.until, v.reason, v.status, v.created_at],
        );
        v.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_VACATION_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [vacationReviewEmbed(v)],
          components: vacationReviewComponents(v),
          ...mentionOpts,
        });
        await db.run('UPDATE vacations SET message_id = ? WHERE id = ?', [sent.id, v.id]);
        await logAudit(guild, interaction.user, 'Новая заявка на отпуск', `Заявка #${v.id} от <@${v.discord_id}> до ${formatDateTime(deadline)}`);
        return safeReply(interaction, 'Заявка на отпуск отправлена на рассмотрение.');
      }

      // Выдача отпуска через список участников
      if (id.startsWith('modal_vacation_grant:')) {
        const parts = id.split(':');
        const discordId = parts[1];
        const staticsCsv = parts[2];
        const deadline = parseDeadline(get('deadline'));
        const reason = get('reason') || '';
        if (!deadline) {
          return safeReply(interaction, '⛔ Неверный формат. Используйте ДД.ММ.ГГГГ (будущая дата) или число+d, например 7d.');
        }
        const passports = await passportsLib.getAllPassports(discordId);
        const targets = staticsCsv ? passports.filter((p) => staticsCsv.split(',').includes(p.static)) : passports;
        if (targets.length === 0) return safeReply(interaction, 'Паспорт(а) не найдены.');

        for (const p of targets) {
          await passportsLib.updatePassportFields(discordId, p.static, { vacation_until: deadline.toISOString() });
          await history.logStatusGranted('vacation', discordId, p.static, p.name, reason, deadline.toISOString(), interaction.user.id);
        }
        await syncStatusRoles(guild, discordId);
        await safeUpdateMembersList(guild);
        const names = targets.map((p) => `${p.name} (№ ${p.static})`).join(', ');
        await dmUser(guild, discordId, {
          content: `🏖️ Вам выдан отпуск до **${formatDateTime(deadline)}** (${names}).${reason ? ` Причина: ${reason}` : ''}`,
          components: [row(new ButtonBuilder().setCustomId(`vacation_selfcancel:${discordId}`).setLabel('❌ Отменить отпуск').setStyle(ButtonStyle.Danger))],
        });
        await logAudit(guild, interaction.user, 'Отпуск выдан', `<@${discordId}> (${names}) до ${formatDateTime(deadline)}${reason ? `. Причина: ${reason}` : ''}`);
        return safeReply(interaction, `Отпуск выдан: ${names}.`);
      }

      // Указание AFK
      if (id.startsWith('modal_afk_set:')) {
        const parts = id.split(':');
        const discordId = parts[1];
        const staticsCsv = parts[2];
        const date = parseDateOnly(get('date'));
        const reason = get('reason') || '';
        if (!date) return safeReply(interaction, '⛔ Неверный формат даты. Используйте ДД.ММ.ГГГГ.');

        const passports = await passportsLib.getAllPassports(discordId);
        const targets = staticsCsv ? passports.filter((p) => staticsCsv.split(',').includes(p.static)) : passports;
        if (targets.length === 0) return safeReply(interaction, 'Паспорт(а) не найдены.');

        for (const p of targets) {
          await passportsLib.updatePassportFields(discordId, p.static, { afk_since: formatDateOnly(date) });
          await history.logStatusGranted('afk', discordId, p.static, p.name, reason, null, interaction.user.id);
        }
        await syncStatusRoles(guild, discordId);
        await safeUpdateMembersList(guild);
        const names = targets.map((p) => `${p.name} | ${p.static}`).join(', ');
        await dmUser(
          guild,
          discordId,
          `💤 Вам выставлен статус AFK с ${formatDateOnly(date)}.${reason ? ` Причина: ${reason}.` : ''} Пожалуйста, зайдите в игру под именем **${names}**, чтобы статус отобразился.`,
        );
        await logAudit(guild, interaction.user, 'AFK выставлен', `<@${discordId}> (${names}) с ${formatDateOnly(date)}`);
        return safeReply(interaction, `Статус AFK выставлен: ${names}.`);
      }

      // Внесение в чёрный список
      if (id === 'modal_blacklist_add') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const discordId = get('discord_id').trim();
        const staticValue = get('static') || '';
        if (staticValue && !isValidStatic(staticValue)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        const reason = get('reason') || '';
        let discordTag = discordId;
        try {
          const member = await guild.members.fetch(discordId);
          discordTag = member.user.tag;
        } catch (_) {}
        await db.run(
          'INSERT INTO blacklist (discord_id, discord_tag, static, reason, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [discordId, discordTag, staticValue, reason, interaction.user.id, new Date().toISOString()],
        );
        await safeUpdateBlacklist(guild);

        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (participant) {
          await removeParticipant(guild, participant, `Внесён(а) в чёрный список. Причина: ${reason || '—'}`);
        }

        await logAudit(guild, interaction.user, 'Внесение в ЧС', `<@${discordId}> (№ ${staticValue || '—'}). Причина: ${reason || '—'}${participant ? ' — участник автоматически уволен.' : ''}`);
        return safeReply(interaction, `Участник внесён в чёрный список.${participant ? ' Также автоматически уволен из организации.' : ''}`);
      }

      if (id === 'modal_blacklist_add_nodiscord') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const name = normalizeName(get('name')) || '';
        const staticValue = get('static');
        if (!isValidStatic(staticValue)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        const reason = get('reason') || '';
        const syntheticId = `nodiscord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tag = name || `паспорт № ${staticValue}`;

        await db.run(
          'INSERT INTO blacklist (discord_id, discord_tag, static, reason, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [syntheticId, tag, staticValue, reason, interaction.user.id, new Date().toISOString()],
        );
        await safeUpdateBlacklist(guild);

        // Если человек с таким паспортом уже есть в списке людей (тоже без Discord) — увольняем его
        const participant = await db.get('SELECT * FROM participants WHERE static = ?', [staticValue]);
        if (participant) {
          await removeParticipant(guild, participant, `Внесён(а) в чёрный список. Причина: ${reason || '—'}`);
        }

        await logAudit(guild, interaction.user, 'Внесение в ЧС (без Discord)', `${tag} (№ ${staticValue}). Причина: ${reason || '—'}${participant ? ' — участник автоматически уволен.' : ''}`);
        return safeReply(interaction, `Внесено в чёрный список (без Discord).${participant ? ' Также автоматически уволен из организации.' : ''}`);
      }

      // Убрать из чёрного списка
      if (id === 'modal_blacklist_remove') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const query = get('query').trim();
        const reason = get('reason') || '';
        const rows = await db.all('SELECT * FROM blacklist WHERE discord_id = ? OR static = ?', [query, query]);
        if (rows.length === 0) return safeReply(interaction, 'Совпадений в чёрном списке не найдено.');

        pendingBlacklistReasons.set(interaction.user.id, reason);

        if (rows.length === 1) {
          const r = rows[0];
          return safeReply(interaction, {
            content: `Убрать из ЧС: <@${r.discord_id}> — № ${r.static || '—'} (${r.reason || 'без причины'})?`,
            components: [row(
              new ButtonBuilder().setCustomId(`blacklist_confirm_remove:${r.id}`).setLabel('✅ Подтвердить').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('blacklist_cancel_remove').setLabel('❌ Отменить').setStyle(ButtonStyle.Secondary),
            )],
          });
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId(`select_blacklist_remove:${rows.map((r) => r.id).join(',')}`)
          .setPlaceholder('Выберите запись(и) для удаления')
          .addOptions([
            ...rows.map((r) => new StringSelectMenuOptionBuilder().setLabel(`№ ${r.static || '—'} — ${r.reason || 'без причины'}`).setValue(String(r.id))),
            new StringSelectMenuOptionBuilder().setLabel('Убрать все перечисленные записи').setValue('all'),
          ]);
        return safeReply(interaction, { content: `У <@${rows[0].discord_id}> несколько записей в ЧС — выберите какие убрать:`, components: [row(select)] });
      }

      // Поиск в чёрном списке
      if (id === 'modal_blacklist_search') {
        const query = get('query').trim();
        const q = `%${query}%`;
        const rows = await db.all(
          'SELECT * FROM blacklist WHERE discord_tag LIKE ? OR discord_id LIKE ? OR static LIKE ? OR reason LIKE ? ORDER BY created_at LIMIT 10',
          [q, q, q, q],
        );
        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('Результаты поиска в ЧС')
          .setDescription(
            rows.length
              ? rows.map((r) => `${r.discord_id.startsWith('nodiscord-') ? r.discord_tag : `<@${r.discord_id}>`} | ${r.discord_tag} — № ${r.static || '—'} — ${r.reason || '—'}`).join('\n')
              : 'Ничего не найдено.',
          );
        return safeReply(interaction, { embeds: [embed] });
      }

      // Поиск
      if (id.startsWith('modal_broadcast_target:')) {
        const userId = id.split(':')[1];
        if (interaction.user.id !== userId) return safeReply(interaction, '⛔ Эта рассылка не ваша.');
        const pending = pendingBroadcasts.get(userId);
        if (!pending) return safeReply(interaction, '⛔ Время ожидания истекло, начните заново командой /broadcast_message.');

        const query = get('query');
        const target = await invitations.resolveInviter(query);
        if (!target) return safeReply(interaction, '⛔ Человек не найден в списке участников.');

        pendingBroadcasts.set(userId, { text: pending.text, targetId: target.discord_id });
        return safeReply(interaction, {
          content: `Отправить это сообщение **${target.name}**?\n\n> ${pending.text.slice(0, 300)}`,
          components: [row(
            new ButtonBuilder().setCustomId(`broadcast_confirm:one:${userId}`).setLabel('✅ Отправить').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`broadcast_cancel:${userId}`).setLabel('❌ Не отправлять').setStyle(ButtonStyle.Danger),
          )],
        });
      }

      if (id === 'modal_search') {
        const filters = {
          discord_tag: get('discord_tag'),
          discord_id: get('discord_id'),
          name: get('name'),
          static: get('static'),
        };

        const clauses = [];
        const params = [];
        for (const [field, value] of Object.entries(filters)) {
          if (value) {
            clauses.push(`${field} LIKE ?`);
            params.push(`%${value}%`);
          }
        }

        if (clauses.length === 0) {
          return safeReply(interaction, 'Заполните хотя бы одно поле для поиска.');
        }

        const results = await db.all(`SELECT * FROM participants WHERE ${clauses.join(' AND ')} LIMIT 11`, params);
        const shown = results.slice(0, 10);

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Результаты поиска')
          .setDescription(
            shown.length
              ? shown.map((p) => `**${p.name}** | ${p.static} | <@${p.discord_id}> | ${p.discord_tag}`).join('\n')
              : 'Ничего не найдено.',
          );

        if (results.length > 10) {
          embed.setFooter({ text: `Показаны первые 10 из ${results.length}+ результатов.` });
        }

        return safeReply(interaction, { embeds: [embed] });
      }
    }
  } catch (err) {
    console.error('Ошибка обработки интеракции:', err);
    try {
      const errGuild = interaction.guild || (process.env.GUILD_ID ? await client.guilds.fetch(process.env.GUILD_ID).catch(() => null) : null);
      if (errGuild) {
        await logAudit(
          errGuild,
          interaction.user,
          '⚠️ Ошибка обработки интеракции',
          `Тип: ${interaction.type}, customId: ${interaction.customId || interaction.commandName || '—'}\n\`\`\`${String(err.message || err).slice(0, 500)}\`\`\``,
        );
      }
    } catch (_) {}
    try {
      await safeReply(interaction, '❌ Произошла ошибка. Попробуйте позже.');
    } catch (_) {}
  }
});

// ---------- Глобальные обработчики ошибок ----------

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

// ---------- Запуск ----------

// ---------- Приём скриншотов контрактов из веток-профилей ----------

// Ожидающие пары скриншотов "взял контракт" -> "выполнил/не выполнил" —
// раньше жило в памяти процесса и терялось при перезапуске/передеплое
// (человек присылал 1-й скриншот, бот перезапускался, 2-й скриншот уже
// не с чем было склеить) — теперь хранится в БД, переживает рестарт.

async function postContractReviewCard(guild, discordId, takenUrl, takenAt, completedUrl, completedAt, replyToMessage) {
  const contractId = await contracts.recordPendingContract(discordId, replyToMessage.channel.id, replyToMessage.id, completedUrl, completedAt);
  await contracts.setTakenInfo(contractId, takenUrl, takenAt);

  // Discord позволяет только одну картинку на embed через setImage —
  // поэтому вместо ссылок показываем сами скриншоты двумя embed'ами.
  const infoEmbed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('Новый контракт на проверку')
    .addFields({ name: 'Участник', value: `<@${discordId}>` });

  const takenEmbed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('1️⃣ Взял контракт')
    .setImage(takenUrl);

  const completedEmbed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('2️⃣ Итог')
    .setImage(completedUrl);

  const reviewMsg = await replyToMessage.reply({
    embeds: [infoEmbed, takenEmbed, completedEmbed],
    components: [row(
      new ButtonBuilder().setCustomId(`contract_fulfilled:${contractId}`).setLabel('✅ Выполнен').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`contract_unfulfilled:${contractId}`).setLabel('❌ Невыполнен').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`contract_rejected:${contractId}`).setLabel('🚫 Не контракт').setStyle(ButtonStyle.Secondary),
    )],
  });
  await contracts.setReviewMessageId(contractId, reviewMsg.id);
}

// Discord сам не логирует, когда человек удаляет СВОЁ ЖЕ сообщение — это
// одна из вещей, которые их аудит не показывает, поэтому дублируем сюда.
client.on('messageDelete', async (message) => {
  try {
    if (message.partial) return; // содержимое недоступно (не было в кэше)
    if (!message.guild) return;
    if (message.author && message.author.bot) return;

    const contentText = message.content ? message.content : '(без текста)';
    const imageAttachments = [...message.attachments.values()].filter((a) => (a.contentType || '').startsWith('image/'));
    const otherAttachments = [...message.attachments.values()].filter((a) => !(a.contentType || '').startsWith('image/'));

    let details = `Канал: <#${message.channel.id}>\nАвтор: ${message.author ? `<@${message.author.id}>` : '—'}\n\nСодержимое:\n${contentText}`;
    if (otherAttachments.length > 0) {
      details += `\n\nВложения (не картинки):\n${otherAttachments.map((a) => `[${a.name}](${a.url})`).join('\n')}`;
    }

    // До 4 картинок показываем прямо в отдельных embed'ах (Discord позволяет
    // только одну картинку на embed через setImage)
    const extraEmbeds = imageAttachments.slice(0, 4).map((a) =>
      new EmbedBuilder().setColor(0x5865f2).setImage(a.url),
    );
    if (imageAttachments.length > 4) {
      details += `\n\n(показаны первые 4 картинки из ${imageAttachments.length})`;
    }

    await logAudit(
      message.guild,
      message.author || { tag: 'неизвестно', id: '0' },
      '🗑️ Сообщение удалено',
      details,
      extraEmbeds,
    );
  } catch (err) {
    console.error('Ошибка логирования удаления сообщения:', err);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) {
      return;
    }

    // Диагностика: логируем КАЖДОЕ сообщение с вложением в любом текстовом
    // канале, чтобы точно увидеть, доходит ли обработка сюда вообще и на
    // каком шаге останавливается. Временная мера для отладки — можно
    // убрать позже, когда проблема будет найдена.
    if (message.attachments.size > 0) {
      console.log(`[скриншоты] Сообщение с вложением от ${message.author.tag} (${message.author.id}) в канале #${message.channel.name} (${message.channel.id})`);
    }

    if (message.attachments.size === 0) return;

    const imageUrls = [...message.attachments.values()]
      .filter((a) => (a.contentType || '').startsWith('image/'))
      .map((a) => a.url);
    console.log(`[скриншоты] Всего вложений: ${message.attachments.size}, из них картинок (по contentType): ${imageUrls.length}`);
    if (imageUrls.length === 0) {
      console.log('[скриншоты] Ни одно вложение не распознано как изображение — contentType:', [...message.attachments.values()].map((a) => a.contentType));
      return;
    }

    let participant = await db.get('SELECT * FROM participants WHERE profile_thread_id = ?', [message.channel.id]);
    if (!participant) {
      const extra = await db.get('SELECT discord_id FROM extra_passports WHERE profile_thread_id = ?', [message.channel.id]);
      if (extra) participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [extra.discord_id]);
    }
    if (!participant) {
      console.log(`[скриншоты] Канал ${message.channel.id} НЕ найден ни в participants.profile_thread_id, ни в extra_passports.profile_thread_id — не считается профиль-каналом.`);
      return;
    }
    console.log(`[скриншоты] Канал сопоставлен с участником: ${participant.name} (${participant.discord_id}), паспорт ${participant.static}`);
    if (message.author.id !== participant.discord_id) {
      console.log(`[скриншоты] Автор сообщения (${message.author.id}) не совпадает с владельцем профиля (${participant.discord_id}) — пропускаем.`);
      return; // считаем только скриншоты владельца профиля
    }

    const discordId = participant.discord_id;
    const now = message.createdAt.toISOString();

    // Одно сообщение сразу с 2+ скриншотами — считаем первым "взял", вторым "итог"
    if (imageUrls.length >= 2) {
      console.log('[скриншоты] 2+ картинки в одном сообщении — создаю карточку контракта сразу.');
      await postContractReviewCard(message.guild, discordId, imageUrls[0], now, imageUrls[1], now, message);
      return;
    }

    // Одно изображение — либо это "взял" (ждём итог), либо "итог" (если "взял" уже ждал)
    const pending = await db.get('SELECT * FROM pending_contract_shots WHERE discord_id = ?', [discordId]);
    if (!pending) {
      console.log('[скриншоты] Это первый скриншот ("взял") — ставлю в ожидание пары и реагирую ⏳.');
      await db.run(
        'INSERT INTO pending_contract_shots (discord_id, url, submitted_at) VALUES (?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET url = excluded.url, submitted_at = excluded.submitted_at',
        [discordId, imageUrls[0], now],
      );
      await message.react('⏳').catch((err) => console.log('[скриншоты] Не удалось поставить реакцию ⏳:', err.message));
      return;
    }

    console.log('[скриншоты] Найдена ожидающая пара — создаю карточку контракта.');
    await db.run('DELETE FROM pending_contract_shots WHERE discord_id = ?', [discordId]);
    await postContractReviewCard(message.guild, discordId, pending.url, pending.submitted_at, imageUrls[0], now, message);
  } catch (err) {
    console.error('Ошибка обработки скриншота контракта:', err);
  }
});

client.once('clientReady', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);
  await db.init();
  await registerCommands();

  if (process.env.GUILD_ID) {
    try {
      const startupGuild = await client.guilds.fetch(process.env.GUILD_ID);
      await logAudit(startupGuild, client.user, '🔄 Бот запущен/перезапущен', `${client.user.tag} в сети.`);
    } catch (err) {
      console.error('Не удалось залогировать запуск бота в аудит:', err.message);
    }
  }

  backup.scheduleDailyBackup(async (text) => {
    console.error('Ошибка бэкапа:', text);
    try {
      if (!process.env.GUILD_ID) return;
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      await logAudit(guild, client.user, '⚠️ Сбой резервного копирования БД', text);
    } catch (err) {
      console.error('Не удалось отправить уведомление о сбое бэкапа в аудит:', err.message);
    }
  });

  // Раз в час проверяем, не пробыл ли кто-то из "ожидающих" приглашённых
  // нужный срок, оставаясь в организации (без этого события выхода не было
  // бы повода пересчитать статус) — и обновляем отображаемую статистику.
  setInterval(async () => {
    try {
      await invitations.promotePendingToConfirmed();
      await acceptances.promotePendingToConfirmed();
      if (process.env.GUILD_ID) {
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        await invitationsDisplay.safeUpdateInvitations(guild);
        await applicationsDisplay.safeUpdateApplicationsStats(guild);
        await checkVacationReminders(guild);
        await checkHrReminder(guild);
      }
    } catch (err) {
      console.error('Ошибка периодической проверки приглашений/заявок:', err);
    }
  }, 60 * 60 * 1000);

  // Раз в минуту проверяем, не истекли ли 15 минут бездействия на
  // сообщениях статистики (контракты/приглашения/заявки) — если да,
  // автоматически возвращаем отображение на текущую неделю (п.6/6.2).
  setInterval(async () => {
    try {
      if (!process.env.GUILD_ID) return;
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      await contractsDisplay.checkAndRevertIfExpired(guild);
      await invitationsDisplay.checkAndRevertIfExpired(guild);
      await applicationsDisplay.checkAndRevertIfExpired(guild);

      const expiredGiveaways = await giveaways.getActiveExpired();
      for (const g of expiredGiveaways) {
        await endGiveaway(guild, g.id);
      }
    } catch (err) {
      console.error('Ошибка проверки автовозврата недели статистики:', err);
    }
  }, 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
