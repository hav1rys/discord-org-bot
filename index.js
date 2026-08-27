require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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
  UserSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');

const db = require('./db');
const config = require('./config');
const { logAudit, logSystem } = require('./audit');
const { updateMembersList, changeMembersPage } = require('./members');
const { updateBlacklist, changeBlacklistPage } = require('./blacklist');
const perms = require('./permissions');
const passportsLib = require('./passports');
const { parseDeadline, parseDateOnly, formatDateTime, formatDateOnly, mskDateStr, mskWeekday } = require('./dates');
const dates = require('./dates');
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
const configStore = require('./config_store');
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

// Переключатели /settings_toggle — по умолчанию всё включено, пока явно не выключили
async function isFeatureEnabled(feature) {
  const value = await db.getSetting(`feature_${feature}_enabled`);
  return value !== 'false';
}

async function resolveGuild(interaction) {
  if (interaction.guild) return interaction.guild;
  return client.guilds.fetch(process.env.GUILD_ID);
}

const mentionOpts = { allowedMentions: { roles: config.ROLES_REVIEW_ALLOWED } };

// Справочные таблицы для /помощь и /права_команд — держать в актуальном
// состоянии вручную при добавлении новых команд.
const COMMAND_CATEGORIES = [
  {
    title: '👤 Участники и паспорта',
    commands: ['история', 'кто_это', 'паспорт_история', 'отпуска_календарь', 'список_afk', 'отпуск_статистика', 'повышения_история', 'команды_человека'],
  },
  {
    title: '📄 Контракты и приглашения',
    commands: ['топ_контракты', 'топ_приглашения'],
  },
  {
    title: '🎉 Розыгрыши',
    commands: ['розыгрыш_старт', 'розыгрыш_завершить', 'розыгрыш_отменить', 'розыгрыш_реролл', 'розыгрыш_участники', 'розыгрыш_добавить_участника', 'розыгрыш_повтор_создать', 'розыгрыш_повтор_список', 'розыгрыш_повтор_отменить'],
  },
  {
    title: '📢 Тексты и рассылки',
    commands: ['правила', 'правила_обновить', 'правила_разослать', 'агитация', 'агитация_обновить', 'hr_вакансия', 'hr_вакансия_обновить', 'рассылка_сообщение', 'каналы_отчётов', 'предпросмотр'],
  },
  {
    title: '⚙️ Управление организацией',
    commands: ['меню_создать', 'профили_восстановить'],
  },
  {
    title: '🛠️ Настройки бота',
    commands: ['настройка_изменить', 'настройка_показать', 'настройка_переключить'],
  },
  {
    title: '💾 Резервные копии',
    commands: ['бэкап_сейчас', 'бэкапы_список', 'резерв_восстановить'],
  },
  {
    title: '🩺 Диагностика и отчётность',
    commands: ['пинг', 'статус', 'статистика_организации', 'экспорт_id', 'экспорт_статистика', 'аудит_поиск', 'аудит_экспорт', 'сверка_ролей', 'экспорт_бд', 'поиск_везде'],
  },
  {
    title: '❔ Справка',
    commands: ['помощь', 'права_команд', 'журнал_прав'],
  },
];

// Уровни доступа — ключ (короткий, для хранения в БД) + подпись + функция
// проверки. /права_команд позволяет менять привязку команда→ключ через
// выпадающий список, без единой правки кода.
const TIER_INFO = {
  admin: { label: 'Только роль `+`, `.` (Admin)', check: (m) => perms.hasBotAccess(m) },
  owner: { label: 'Владелец и выше', check: (m) => perms.isOwnerTier(m) },
  deputy: { label: 'Зам. Владелец и выше', check: (m) => perms.isDeputyTier(m) },
  hr: { label: 'HR-Менеджер и выше', check: (m) => perms.isHrTier(m) },
};

// Уровень по умолчанию для каждой команды (используется, пока никто не
// поменял его через /права_команд)
const COMMAND_DEFAULT_TIERS = {
  настройка_изменить: 'admin', настройка_показать: 'admin', настройка_переключить: 'admin',
  бэкап_сейчас: 'admin', бэкапы_список: 'admin', экспорт_id: 'admin', права_команд: 'admin', меню_создать: 'admin',

  розыгрыш_старт: 'owner', розыгрыш_завершить: 'owner', розыгрыш_отменить: 'owner', розыгрыш_реролл: 'owner', розыгрыш_участники: 'owner',
  розыгрыш_добавить_участника: 'owner', розыгрыш_повтор_создать: 'owner', розыгрыш_повтор_список: 'owner', розыгрыш_повтор_отменить: 'owner',
  правила: 'owner', правила_обновить: 'owner', правила_разослать: 'owner', агитация: 'owner', агитация_обновить: 'owner',
  hr_вакансия: 'owner', hr_вакансия_обновить: 'owner', рассылка_сообщение: 'owner', каналы_отчётов: 'owner', предпросмотр: 'owner',
  профили_восстановить: 'owner', статус: 'owner', пинг: 'owner',

  экспорт_статистика: 'deputy', аудит_экспорт: 'deputy',

  топ_приглашения: 'hr', паспорт_история: 'hr', отпуска_календарь: 'hr', список_afk: 'hr', топ_контракты: 'hr',
  статистика_организации: 'hr', аудит_поиск: 'hr', кто_это: 'hr', история: 'hr', помощь: 'hr',
  сверка_ролей: 'hr', поиск_везде: 'hr', отпуск_статистика: 'hr', повышения_история: 'hr', команды_человека: 'hr',
  журнал_прав: 'admin',
  экспорт_бд: 'admin', резерв_восстановить: 'admin',
};

function isSnowflake(value) {
  return /^\d{17,20}$/.test(value || '');
}

function tierLabel(tier) {
  if (isSnowflake(tier)) return `🔒 Только <@${tier}>`;
  return (TIER_INFO[tier] || TIER_INFO.admin).label;
}

// Эффективный уровень команды — переопределение из БД, если есть (роль ИЛИ
// конкретный Discord ID), иначе значение по умолчанию
async function getCommandTier(commandName) {
  const override = await db.get('SELECT tier FROM command_permission_overrides WHERE command_name = ?', [commandName]);
  if (override && (TIER_INFO[override.tier] || isSnowflake(override.tier))) {
    return override.tier;
  }
  return COMMAND_DEFAULT_TIERS[commandName];
}

// Единая точка проверки для всех команд — читает текущий (возможно,
// переопределённый) уровень и сразу применяет соответствующую проверку.
async function checkCommandAccess(commandName, member) {
  const tier = await getCommandTier(commandName);
  if (isSnowflake(tier)) {
    if (perms.hasBotAccess(member)) return true; // владелец/admin никогда не блокируются полностью
    return member.id === tier;
  }
  const info = TIER_INFO[tier] || TIER_INFO.admin;
  return info.check(member);
}

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
      let who;
      if (!v.target_statics || v.target_statics === 'all') {
        who = passports.map((p) => `${p.name} (№ ${p.static})`).join(', ');
      } else {
        const statics = v.target_statics.split(',');
        const matched = passports.filter((p) => statics.includes(p.static));
        who = matched.length > 0 ? matched.map((p) => `${p.name} (№ ${p.static})`).join(', ') : statics.map((s) => `№ ${s}`).join(', ');
      }
      lines.push(`${who} — ${link} | ${v.reason || '—'} | ${formatDateOnly(new Date(v.created_at))} | до ${formatDateOnly(new Date(v.until))}`);
    }
    for (const g of vacationGrants) {
      const label = g.action === 'granted' ? 'Выдан руководством' : 'Снят руководством';
      const extra = g.action === 'granted' && g.until ? ` | до ${formatDateOnly(new Date(g.until))}` : '';
      lines.push(`${g.name} (№ ${g.static}) — ${label} | ${g.reason || '—'} | ${formatDateOnly(new Date(g.at))}${extra}`);
    }
    mainEmbed.addFields({ name: 'Отпуск', value: lines.join('\n').slice(0, 1024) });
  }

  // AFK — своей "заявки" не существует, но выдача/снятие напрямую руководством теперь логируется
  const afkGrants = await history.getStatusHistory(discordId, 'afk');
  if (afkGrants.length > 0) {
    const lines = afkGrants.map((g) => {
      const label = g.action === 'granted' ? 'Выдан' : 'Снят';
      return `${g.name} (№ ${g.static}) — ${label} | ${g.reason || '—'} | ${formatDateOnly(new Date(g.at))}`;
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
// Раз в час — если место на диске заполнено на 90%+, предупреждаем один
// раз (не при каждой проверке), пока не освободится обратно ниже порога.
// Раз в час — если карточка контракта висит на проверке (никто не нажал
// Выполнен/Невыполнен/Не контракт) дольше STUCK_CONTRACT_HOURS, напоминаем
// руководству — но только один раз на конкретный контракт.
// Раз в сутки (проверяется из часового таймера, сравнивает дату последней
// отправки) — короткая сводка Владельцу в ЛС: новые заявки, увольнения,
// просроченные контракты, у кого скоро кончается отпуск.
async function sendDailyDigest(guild) {
  const lastSent = await db.getSetting('daily_digest_last_sent');
  const today = dates.mskDateStr(new Date());
  if (lastSent === today) return;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const newApps = (await db.get(`SELECT COUNT(*) as cnt FROM applications WHERE created_at >= ?`, [yesterday])).cnt;
  const newKicks = (await db.get(`SELECT COUNT(*) as cnt FROM kicks WHERE created_at >= ?`, [yesterday])).cnt;
  const pendingApps = (await db.get(`SELECT COUNT(*) as cnt FROM applications WHERE status = 'pending'`)).cnt;
  const stuckContracts = (await db.get(
    `SELECT COUNT(*) as cnt FROM contracts WHERE status = 'pending' AND submitted_at <= ?`,
    [new Date(Date.now() - config.STUCK_CONTRACT_HOURS * 60 * 60 * 1000).toISOString()],
  )).cnt;

  const vacationCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const participantsOnVacation = await db.all(`SELECT discord_id, name, static, vacation_until FROM participants WHERE vacation_until IS NOT NULL AND vacation_until <= ?`, [vacationCutoff]);
  const extrasOnVacation = await db.all(`SELECT discord_id, name, static, vacation_until FROM extra_passports WHERE vacation_until IS NOT NULL AND vacation_until <= ?`, [vacationCutoff]);
  const endingSoon = [...participantsOnVacation, ...extrasOnVacation];

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Ежедневная сводка по организации')
    .addFields(
      { name: 'Новых заявок за сутки', value: String(newApps), inline: true },
      { name: 'Новых увольнений за сутки', value: String(newKicks), inline: true },
      { name: 'Всего в очереди на рассмотрение', value: String(pendingApps), inline: true },
      { name: 'Просроченных контрактов', value: String(stuckContracts), inline: true },
    );
  if (endingSoon.length > 0) {
    embed.addFields({
      name: 'Отпуск заканчивается в течение суток',
      value: endingSoon.map((p) => `${p.name} (№ ${p.static}) — до ${formatDateTime(new Date(p.vacation_until))}`).join('\n').slice(0, 1024),
    });
  }

  await dmUser(guild, config.OWNER_USER_ID, { embeds: [embed] });
  await db.setSetting('daily_digest_last_sent', today);
}

// Вызывается сразу после проверки контракта (выполнен/невыполнен) — если
// у паспорта сейчас ранг "1. Стажер" и в текущей неделе набралось
// WEEKLY_PROMOTION_CONTRACT_THRESHOLD обработанных контрактов — повышаем
// сразу же, не дожидаясь понедельника.
async function checkContractPromotion(guild, threadId) {
  if (!threadId) return;
  const stazherRoleId = config.ROLE_IDS[4]; // "1. Стажер"
  const freelancerRoleId = config.ROLE_IDS[3]; // "2. Фрилансер"

  let passportInfo = await db.get('SELECT discord_id, static, name, role_id FROM participants WHERE profile_thread_id = ?', [threadId]);
  if (!passportInfo) {
    passportInfo = await db.get('SELECT discord_id, static, name, role_id FROM extra_passports WHERE profile_thread_id = ?', [threadId]);
  }
  if (!passportInfo || passportInfo.role_id !== stazherRoleId) return; // повышаем только тех, кто сейчас именно Стажёр

  const range = contracts.getWeekRange(0); // текущая неделя
  const countRow = await db.get(
    `SELECT COUNT(*) as cnt FROM contracts WHERE thread_id = ? AND status IN ('fulfilled','unfulfilled') AND submitted_at BETWEEN ? AND ?`,
    [threadId, range.start.toISOString(), range.end.toISOString()],
  );
  if (!countRow || countRow.cnt < config.WEEKLY_PROMOTION_CONTRACT_THRESHOLD) return;

  await passportsLib.updatePassportFields(passportInfo.discord_id, passportInfo.static, { role_id: freelancerRoleId });
  await syncEffectiveIdentity(guild, passportInfo.discord_id);
  await safeUpdateMembersList(guild);
  await logAudit(
    guild,
    client.user,
    '⬆️ Авто-повышение по контрактам',
    `${passportInfo.name} (№ ${passportInfo.static}) — <@${passportInfo.discord_id}> повышен(а) до «2. Фрилансер» (${countRow.cnt} обработанных контрактов за эту неделю).`,
  );
}

// Каждый понедельник (или другой день, настраивается через
// WEEKLY_RANK_ADJUSTMENT_DAY) — у кого паспорт сейчас на ранге
// "2. Фрилансер", понижается до "1. Стажер". Повышение сюда больше не
// входит — оно теперь происходит мгновенно при проверке контракта
// (см. checkContractPromotion).
async function runWeeklyRankAdjustment(guild) {
  const now = new Date();
  const isTargetDay = dates.mskWeekday(now) === config.WEEKLY_RANK_ADJUSTMENT_DAY;
  const todayStr = dates.mskDateStr(now);
  const lastRun = await db.getSetting('weekly_rank_adjustment_last_run');
  if (!isTargetDay || lastRun === todayStr) return;

  const stazherRoleId = config.ROLE_IDS[4]; // "1. Стажер"
  const freelancerRoleId = config.ROLE_IDS[3]; // "2. Фрилансер"

  const freelancerParticipants = await db.all('SELECT discord_id, static, name FROM participants WHERE role_id = ?', [freelancerRoleId]);
  const freelancerExtras = await db.all('SELECT discord_id, static, name FROM extra_passports WHERE role_id = ?', [freelancerRoleId]);
  const demotions = [];
  for (const p of [...freelancerParticipants, ...freelancerExtras]) {
    await passportsLib.updatePassportFields(p.discord_id, p.static, { role_id: stazherRoleId });
    demotions.push(p);
  }

  if (demotions.length > 0) {
    for (const p of demotions) {
      await syncEffectiveIdentity(guild, p.discord_id);
    }
    await safeUpdateMembersList(guild);

    const lines = demotions.map((p) => `${p.name} (№ ${p.static}) — <@${p.discord_id}>`);
    await logAudit(
      guild,
      client.user,
      '⬇️ Еженедельное авто-понижение',
      `Понижены до «1. Стажер» (были на «2. Фрилансер»):\n${lines.join('\n')}`.slice(0, 4000),
    );
  }

  await db.setSetting('weekly_rank_adjustment_last_run', todayStr);
}

async function sendWeeklyDigest(guild) {
  const lastSent = await db.getSetting('weekly_digest_last_sent');
  if (lastSent && Date.now() - new Date(lastSent).getTime() < 7 * 24 * 60 * 60 * 1000) return;

  const range = contracts.getWeekRange(0);
  const contractRows = await db.all(
    `SELECT status FROM contracts WHERE status IN ('fulfilled','unfulfilled') AND submitted_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  );
  const fulfilled = contractRows.filter((r) => r.status === 'fulfilled').length;
  const unfulfilled = contractRows.filter((r) => r.status === 'unfulfilled').length;

  const confirmedInvites = (await db.get(
    `SELECT COUNT(*) as cnt FROM invitations WHERE status = 'confirmed' AND joined_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  )).cnt;

  const acceptedApps = (await db.get(
    `SELECT COUNT(*) as cnt FROM applications WHERE status = 'accepted' AND created_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  )).cnt;
  const rejectedApps = (await db.get(
    `SELECT COUNT(*) as cnt FROM applications WHERE status = 'rejected' AND created_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  )).cnt;

  const kicksThisWeek = (await db.get(
    `SELECT COUNT(*) as cnt FROM kicks WHERE status = 'accepted' AND created_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  )).cnt;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📊 Итоги недели: ${contracts.formatWeekLabel(range)}`)
    .addFields(
      { name: 'Контракты', value: `✅ ${fulfilled} / ❌ ${unfulfilled}`, inline: true },
      { name: 'Подтверждённые приглашения', value: String(confirmedInvites), inline: true },
      { name: 'Заявки: принято/отклонено', value: `${acceptedApps} / ${rejectedApps}`, inline: true },
      { name: 'Увольнений за неделю', value: String(kicksThisWeek), inline: true },
    );

  await dmUser(guild, config.OWNER_USER_ID, { embeds: [embed] });
  await db.setSetting('weekly_digest_last_sent', new Date().toISOString());
}

async function checkStuckContracts(guild) {
  const cutoff = new Date(Date.now() - config.STUCK_CONTRACT_HOURS * 60 * 60 * 1000).toISOString();
  const stuck = await db.all(
    `SELECT * FROM contracts WHERE status = 'pending' AND submitted_at <= ? AND stuck_reminder_sent = 0`,
    [cutoff],
  );
  if (stuck.length === 0) return;

  // Группируем по каналу — если у одного человека зависло сразу несколько,
  // не спамим отдельным сообщением на каждый.
  const byChannel = new Map();
  for (const c of stuck) {
    if (!byChannel.has(c.thread_id)) byChannel.set(c.thread_id, []);
    byChannel.get(c.thread_id).push(c);
  }

  for (const [channelId, contractsInChannel] of byChannel) {
    try {
      const channel = await guild.channels.fetch(channelId);
      const lines = contractsInChannel.map((c) => `[Карточка](https://discord.com/channels/${guild.id}/${channelId}/${c.review_message_id}) — с ${formatDateTime(new Date(c.submitted_at))}`);
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('⏰ Контракт(ы) зависли на проверке')
        .setDescription(lines.join('\n').slice(0, 4000));
      await channel.send({ content: perms.mentionManagementRoles(), embeds: [embed], ...mentionOpts });
      for (const c of contractsInChannel) {
        await db.run('UPDATE contracts SET stuck_reminder_sent = 1 WHERE id = ?', [c.id]);
      }
    } catch (err) {
      console.error(`Не удалось отправить напоминание о зависшем контракте в канал ${channelId}:`, err.message);
    }
  }
}

async function checkDiskSpace(guild) {
  const usedBytes = getDirSize(db.dataDir);
  const quotaMb = 5000; // 5 ГБ — типовая квота диска на Bothost Basic
  const percent = (usedBytes / (quotaMb * 1024 * 1024)) * 100;

  const alreadyWarned = (await db.getSetting('disk_warning_sent')) === 'true';
  if (percent >= 90) {
    if (!alreadyWarned) {
      await logSystem(guild, '⚠️ Диск почти заполнен', `Использовано ${(usedBytes / 1024 / 1024).toFixed(1)} МБ из ${quotaMb} МБ (${percent.toFixed(1)}%). Пора почистить старые бэкапы/данные или расширить тариф.`);
      await db.setSetting('disk_warning_sent', 'true');
    }
  } else if (alreadyWarned) {
    await db.setSetting('disk_warning_sent', 'false');
  }
}

async function checkHrReminder(guild) {
  const lastReminder = await db.getSetting('hr_reminder_last_sent');
  const intervalMs = config.HR_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  if (lastReminder && Date.now() - new Date(lastReminder).getTime() < intervalMs) return;

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
  const REMINDER_WINDOW_MS = config.VACATION_REMINDER_HOURS * 60 * 60 * 1000;
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

function buildManualContractModal(status, discordId, staticValue) {
  const modal = new ModalBuilder().setCustomId(`modal_contract_manual:${status}:${discordId}:${staticValue || ''}`).setTitle('Добавить контракт вручную');
  modal.addComponents(
    row(txt(null, 'link', 'Ссылка на скриншот')),
    row(txt(null, 'date', 'Дата (ДД.ММ[.ГГ]), пусто = сегодня', { required: false })),
  );
  return modal;
}

function buildVacationSelfModal() {
  const modal = new ModalBuilder().setCustomId('modal_vacation_apply').setTitle('Заявка на отпуск');
  modal.addComponents(
    row(txt(null, 'deadline', 'Дата (ДД.ММ[.ГГ]) или срок (7d)')),
    row(txt(null, 'reason', 'Причина (необязательно)', { required: false, paragraph: true })),
  );
  return modal;
}

function buildVacationGrantModal(discordId, staticsCsv) {
  const customId = staticsCsv ? `modal_vacation_grant:${discordId}:${staticsCsv}` : `modal_vacation_grant:${discordId}`;
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Выдать отпуск');
  modal.addComponents(
    row(txt(null, 'deadline', 'Дата (ДД.ММ[.ГГ]) или срок (7d)')),
    row(txt(null, 'reason', 'Причина', { required: false })),
  );
  return modal;
}

function buildAfkModal(discordId, staticsCsv) {
  const customId = staticsCsv ? `modal_afk_set:${discordId}:${staticsCsv}` : `modal_afk_set:${discordId}`;
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Указать AFK');
  modal.addComponents(
    row(txt(null, 'date', 'Дата с которой AFK (ДД.ММ[.ГГ])')),
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
    .setName('меню_создать')
    .setDescription('Инициализировать все меню, статистику и FAQ в соответствующих каналах'),
  new SlashCommandBuilder()
    .setName('правила')
    .setDescription('Отправить текущий свод правил в канал правил'),
  new SlashCommandBuilder()
    .setName('правила_обновить')
    .setDescription('Обновить свод правил'),
  new SlashCommandBuilder()
    .setName('правила_разослать')
    .setDescription('Разослать свод правил в ЛС — всем в организации или одному человеку')
    .addStringOption((opt) =>
      opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID — если пусто, отправит всем').setRequired(false).setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('рассылка_сообщение')
    .setDescription('Отправить произвольное сообщение в ЛС от имени бота — всем или одному человеку'),
  new SlashCommandBuilder()
    .setName('агитация')
    .setDescription('Отправить текущую агитацию в канал агитации'),
  new SlashCommandBuilder()
    .setName('агитация_обновить')
    .setDescription('Обновить текст агитации'),
  new SlashCommandBuilder()
    .setName('hr_вакансия')
    .setDescription('Отправить текущее описание вакансии HR-Менеджера в канал'),
  new SlashCommandBuilder()
    .setName('hr_вакансия_обновить')
    .setDescription('Обновить описание вакансии HR-Менеджера'),
  new SlashCommandBuilder()
    .setName('пинг')
    .setDescription('Проверить скорость отклика бота (Discord, база данных)'),
  new SlashCommandBuilder()
    .setName('профили_восстановить')
    .setDescription('Создать каналы-профили для всех, у кого их ещё нет, и заполнить дату вступления'),
  new SlashCommandBuilder()
    .setName('история')
    .setDescription('Полная история вступлений/увольнений человека')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('топ_контракты')
    .setDescription('Топ по контрактам за всё время'),
  new SlashCommandBuilder()
    .setName('аудит_поиск')
    .setDescription('Поиск по логу аудита')
    .addStringOption((opt) => opt.setName('запрос').setDescription('Текст для поиска в действии/деталях/инициаторе').setRequired(true)),
  new SlashCommandBuilder()
    .setName('кто_это')
    .setDescription('Быстрый поиск участника')
    .addStringOption((opt) => opt.setName('запрос').setDescription('№ Паспорта / Discord тег / Имя Фамилия').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('экспорт_статистика')
    .setDescription('Выгрузить статистику текущей недели (контракты/приглашения/заявки) в .csv'),
  new SlashCommandBuilder()
    .setName('каналы_отчётов')
    .setDescription('Отправить в ЛС ссылки на каналы с отчётами — одному человеку или всем в организации')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID — если пусто, отправит всем').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('статистика_организации')
    .setDescription('Общая сводка по организации: люди, отпуск/AFK, контракты за неделю, очередь заявок'),
  new SlashCommandBuilder()
    .setName('статус')
    .setDescription('Проверка здоровья бота: БД, доступ к ключевым каналам, время работы'),
  new SlashCommandBuilder()
    .setName('экспорт_id')
    .setDescription('Выгрузить названия, ID и права доступа всех каналов и ролей сервера в файл'),
  new SlashCommandBuilder()
    .setName('розыгрыш_старт')
    .setDescription('Запустить розыгрыш')
    .addStringOption((opt) => opt.setName('приз').setDescription('Что разыгрывается').setRequired(true))
    .addStringOption((opt) => opt.setName('длительность').setDescription('Например: 30m, 2h, 1d, 1w').setRequired(true))
    .addIntegerOption((opt) => opt.setName('победителей').setDescription('Сколько победителей').setRequired(true).setMinValue(1))
    .addChannelOption((opt) => opt.setName('канал').setDescription('Куда отправить (по умолчанию — этот канал)').setRequired(false))
    .addRoleOption((opt) => opt.setName('условие').setDescription('Только эта роль может участвовать (по умолчанию — кто угодно)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('розыгрыш_добавить_участника')
    .setDescription('Вручную добавить человека в розыгрыш')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш').setRequired(true).setAutocomplete(true))
    .addUserOption((opt) => opt.setName('человек').setDescription('Кого добавить').setRequired(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_повтор_создать')
    .setDescription('Настроить повторяющийся розыгрыш (например, каждую пятницу)')
    .addStringOption((opt) => opt.setName('приз').setDescription('Что разыгрывается').setRequired(true))
    .addStringOption((opt) => opt.setName('длительность').setDescription('Сколько длится каждый запуск: 30m, 2h, 1d, 1w').setRequired(true))
    .addIntegerOption((opt) => opt.setName('победителей').setDescription('Сколько победителей').setRequired(true).setMinValue(1))
    .addStringOption((opt) =>
      opt.setName('день_недели').setDescription('В какой день недели запускать').setRequired(true).addChoices(
        { name: 'Воскресенье', value: '0' },
        { name: 'Понедельник', value: '1' },
        { name: 'Вторник', value: '2' },
        { name: 'Среда', value: '3' },
        { name: 'Четверг', value: '4' },
        { name: 'Пятница', value: '5' },
        { name: 'Суббота', value: '6' },
      ),
    )
    .addChannelOption((opt) => opt.setName('канал').setDescription('Куда отправлять (по умолчанию — этот канал)').setRequired(false))
    .addRoleOption((opt) => opt.setName('условие').setDescription('Только эта роль может участвовать (по умолчанию — кто угодно)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('розыгрыш_повтор_список')
    .setDescription('Список настроенных повторяющихся розыгрышей'),
  new SlashCommandBuilder()
    .setName('розыгрыш_повтор_отменить')
    .setDescription('Остановить повторяющийся розыгрыш')
    .addStringOption((opt) => opt.setName('правило').setDescription('Какое правило остановить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_завершить')
    .setDescription('Досрочно завершить розыгрыш и выбрать победителей')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш завершить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_реролл')
    .setDescription('Выбрать новых победителей уже завершённого розыгрыша')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш перевыбрать').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_отменить')
    .setDescription('Отменить розыгрыш без выбора победителей')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш отменить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_участники')
    .setDescription('Показать, кто участвует (или участвовал) в розыгрыше')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('настройка_изменить')
    .setDescription('Изменить настройку бота (ID канала/роли, число) без правки кода')
    .addStringOption((opt) => opt.setName('ключ').setDescription('Какую настройку менять').setRequired(true).setAutocomplete(true))
    .addStringOption((opt) => opt.setName('значение').setDescription('Новое значение (или "сброс", чтобы вернуть по умолчанию)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('настройка_показать')
    .setDescription('Посмотреть текущее значение настройки')
    .addStringOption((opt) => opt.setName('ключ').setDescription('Какую настройку посмотреть — если пусто, покажет все переопределённые').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('настройка_переключить')
    .setDescription('Включить/выключить приём заявок, контрактов или напоминаний')
    .addStringOption((opt) =>
      opt.setName('функция').setDescription('Что переключить').setRequired(true).addChoices(
        { name: 'Заявки на вступление', value: 'applications' },
        { name: 'Приём скриншотов контрактов', value: 'contracts' },
        { name: 'Напоминания (отпуск/HR)', value: 'reminders' },
      ),
    )
    .addStringOption((opt) =>
      opt.setName('состояние').setDescription('Включить или выключить').setRequired(true).addChoices(
        { name: 'Включить', value: 'on' },
        { name: 'Выключить', value: 'off' },
      ),
    ),
  new SlashCommandBuilder()
    .setName('отпуска_календарь')
    .setDescription('Кто сейчас в отпуске и до какого числа'),
  new SlashCommandBuilder()
    .setName('список_afk')
    .setDescription('Кто сейчас AFK'),
  new SlashCommandBuilder()
    .setName('топ_приглашения')
    .setDescription('Топ по приглашениям за всё время'),
  new SlashCommandBuilder()
    .setName('бэкап_сейчас')
    .setDescription('Сделать резервную копию БД прямо сейчас'),
  new SlashCommandBuilder()
    .setName('бэкапы_список')
    .setDescription('Список доступных резервных копий БД'),
  new SlashCommandBuilder()
    .setName('аудит_экспорт')
    .setDescription('Выгрузить лог аудита в .csv за период')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 30)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('помощь')
    .setDescription('Список всех команд бота по темам'),
  new SlashCommandBuilder()
    .setName('права_команд')
    .setDescription('Какая роль нужна для каждой команды'),
  new SlashCommandBuilder()
    .setName('паспорт_история')
    .setDescription('История изменений конкретного паспорта (смена Имени Фамилии, вступление/увольнение)')
    .addStringOption((opt) => opt.setName('паспорт').setDescription('№ Паспорта').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('сверка_ролей')
    .setDescription('Найти расхождения между рангом в базе и реальной ролью на сервере'),
  new SlashCommandBuilder()
    .setName('экспорт_бд')
    .setDescription('Выгрузить все таблицы базы данных в .csv файлы'),
  new SlashCommandBuilder()
    .setName('поиск_везде')
    .setDescription('Поиск текста сразу по всем ключевым таблицам')
    .addStringOption((opt) => opt.setName('текст').setDescription('Что искать').setRequired(true)),
  new SlashCommandBuilder()
    .setName('отпуск_статистика')
    .setDescription('Сколько раз и на сколько суммарно человек уходил в отпуск за период')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID — если пусто, по всем').setRequired(false).setAutocomplete(true))
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 90)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('повышения_история')
    .setDescription('История авто-повышений/понижений по контрактам (не ручные действия)')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 90)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('журнал_прав')
    .setDescription('История изменений через /права_команд — кто, когда и что поменял'),
  new SlashCommandBuilder()
    .setName('команды_человека')
    .setDescription('Какие команды бота доступны конкретному человеку')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('резерв_восстановить')
    .setDescription('⚠️ Откатить базу данных к резервной копии (перезаписывает текущие данные)')
    .addStringOption((opt) => opt.setName('файл').setDescription('Какую резервную копию восстановить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('предпросмотр')
    .setDescription('Показать себе, как выглядит текущий текст, прежде чем рассылать всем')
    .addStringOption((opt) =>
      opt.setName('тип').setDescription('Какой текст показать').setRequired(true).addChoices(
        { name: 'Правила', value: 'rules' },
        { name: 'Агитация', value: 'agitation' },
        { name: 'Вакансия HR', value: 'hr_info' },
      ),
    ),
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
  const conditionLine = giveaway.required_role_id ? `\nУсловие: только роль <@&${giveaway.required_role_id}>` : '';
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x2b2d31 : 0x57f287)
    .setTitle(`🎉 ${giveaway.prize}`)
    .setDescription(
      ended
        ? `Розыгрыш завершён.`
        : `Нажмите на кнопку ниже, чтобы участвовать!\nОрганизатор: <@${giveaway.host_id}>${conditionLine}`,
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

async function startGiveawayFromRule(guild, rule) {
  const endsAt = new Date(Date.now() + rule.duration_ms);
  const channel = await guild.channels.fetch(rule.channel_id);
  const giveawayId = await giveaways.createGiveaway(rule.channel_id, rule.prize, rule.winners_count, rule.host_id, endsAt.toISOString(), rule.required_role_id, rule.id);
  const embed = buildGiveawayEmbed({ prize: rule.prize, winners_count: rule.winners_count, ends_at: endsAt.toISOString(), host_id: rule.host_id, required_role_id: rule.required_role_id }, 0);
  const sent = await channel.send({ content: '🎉 **РОЗЫГРЫШ** 🎉', embeds: [embed], components: buildGiveawayComponents(giveawayId) });
  await giveaways.setMessageId(giveawayId, sent.id);
  return giveawayId;
}

// Раз в день (проверяется из часового таймера) — если сегодня день недели
// какого-то активного повторяющегося правила и оно ещё не запускалось
// сегодня, создаёт новый розыгрыш по этому шаблону.
async function checkRecurringGiveaways(guild) {
  const rules = await giveaways.getActiveRecurringRules();
  if (rules.length === 0) return;
  const now = new Date();
  const todayStr = dates.mskDateStr(now);
  const todayWeekday = dates.mskWeekday(now);

  for (const rule of rules) {
    if (rule.weekday !== todayWeekday || rule.last_run_date === todayStr) continue;
    try {
      await startGiveawayFromRule(guild, rule);
      await giveaways.setRecurringRuleLastRun(rule.id, todayStr);
      await logAudit(guild, client.user, 'Повторяющийся розыгрыш запущен', `«${rule.prize}» (правило #${rule.id}) в <#${rule.channel_id}>`);
    } catch (err) {
      console.error(`Не удалось запустить повторяющийся розыгрыш (правило #${rule.id}):`, err.message);
    }
  }
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

// Отправляет файл бэкапа в отдельный Discord-канал (п. "чтобы она не
// потерялась, если сайт умрёт") — используется и ежедневным авто-бэкапом,
// и командой /бэкап_сейчас.
const searchQueryCache = new Map(); // короткий id -> текст запроса (для кнопок пагинации)
const SEARCH_PAGE_SIZE = 10;

function buildGlobalSearchQueries(q) {
  return [
    {
      table: '👤 Участники (participants)',
      sql: () => `SELECT name, static, discord_tag FROM participants WHERE name LIKE ? OR static LIKE ? OR discord_tag LIKE ? OR discord_id LIKE ? LIMIT ? OFFSET ?`,
      params: [q, q, q, q],
      format: (r) => `${r.name} (№ ${r.static}, ${r.discord_tag})`,
    },
    {
      table: '👤 Доп. паспорта (extra_passports)',
      sql: () => `SELECT name, static FROM extra_passports WHERE name LIKE ? OR static LIKE ? LIMIT ? OFFSET ?`,
      params: [q, q],
      format: (r) => `${r.name} (№ ${r.static})`,
    },
    {
      table: '📝 Заявки на вступление (applications)',
      sql: () => `SELECT id, name, static, discord_tag FROM applications WHERE name LIKE ? OR static LIKE ? OR discord_tag LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      params: [q, q, q],
      format: (r) => `#${r.id} — ${r.name} (№ ${r.static}, ${r.discord_tag})`,
    },
    {
      table: '🚫 Заявки на увольнение (kicks)',
      sql: () => `SELECT id, name, target_static, reason FROM kicks WHERE name LIKE ? OR target_static LIKE ? OR reason LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      params: [q, q, q],
      format: (r) => `#${r.id} — ${r.name} (№ ${r.target_static})${r.reason ? `: ${r.reason.slice(0, 60)}` : ''}`,
    },
    {
      table: '🤡 ЧС (blacklist)',
      sql: () => `SELECT id, discord_tag, static, reason FROM blacklist WHERE discord_tag LIKE ? OR static LIKE ? OR reason LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      params: [q, q, q],
      format: (r) => `#${r.id} — ${r.discord_tag || '—'} (№ ${r.static || '—'})${r.reason ? `: ${r.reason.slice(0, 60)}` : ''}`,
    },
    {
      table: '📋 Заявки на роль HR (hr_applications)',
      sql: () => `SELECT id, discord_tag FROM hr_applications WHERE discord_tag LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      params: [q],
      format: (r) => `#${r.id} — ${r.discord_tag}`,
    },
    {
      table: '✏️ Изменение данных (data_change_requests)',
      sql: () => `SELECT id, old_name, new_name, target_static FROM data_change_requests WHERE old_name LIKE ? OR new_name LIKE ? OR target_static LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      params: [q, q, q],
      format: (r) => `#${r.id} — «${r.old_name}» → «${r.new_name}» (№ ${r.target_static})`,
    },
    {
      table: '📋 Аудит (audit_log)',
      sql: () => `SELECT id, action, actor_tag, details FROM audit_log WHERE action LIKE ? OR details LIKE ? OR actor_tag LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      params: [q, q, q],
      format: (r) => `**${r.action}** — ${r.actor_tag}: ${r.details.slice(0, 80)}`,
    },
  ];
}

// Постранично: запрашиваем на 1 больше, чем помещается — если пришло
// больше SEARCH_PAGE_SIZE, значит есть следующая страница.
async function runGlobalSearch(text, page) {
  const q = `%${text}%`;
  const searches = buildGlobalSearchQueries(q);
  const offset = page * SEARCH_PAGE_SIZE;

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🔍 Поиск: «${text}»${page > 0 ? ` — стр. ${page + 1}` : ''}`);
  let totalFound = 0;
  let hasMore = false;

  for (const s of searches) {
    const rows = await db.all(s.sql(), [...s.params, SEARCH_PAGE_SIZE + 1, offset]);
    if (rows.length === 0) continue;
    const pageRows = rows.slice(0, SEARCH_PAGE_SIZE);
    if (rows.length > SEARCH_PAGE_SIZE) hasMore = true;
    totalFound += pageRows.length;
    embed.addFields({ name: `${s.table} (стр. ${page + 1})`, value: pageRows.map(s.format).join('\n').slice(0, 1024) });
  }

  return { embed, totalFound, hasMore };
}

function buildSearchComponents(searchId, page, hasMore) {
  return [row(
    new ButtonBuilder().setCustomId(`search_page:${searchId}:${page - 1}`).setLabel('◀ Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`search_page:${searchId}:${page + 1}`).setLabel('Вперёд ▶').setStyle(ButtonStyle.Secondary).setDisabled(!hasMore),
  )];
}

async function uploadBackupFile(filePath, reason) {
  try {
    const channel = await client.channels.fetch(config.CHANNEL_BACKUPS);
    const rawBuffer = fs.readFileSync(filePath);
    // Сжимаем gzip'ом (встроен в Node, никаких доп. зависимостей) — если
    // база вырастет, это сильно уменьшит размер вложения. Чтобы
    // восстановить: разархивировать .gz любым архиватором (7-Zip,
    // WinRAR и т.д. понимают .gz) перед тем, как класть файл боту.
    const compressed = zlib.gzipSync(rawBuffer);
    const file = new AttachmentBuilder(compressed, { name: `${path.basename(filePath)}.gz` });
    await channel.send({
      content: `💾 Резервная копия БД (${reason}) — ${formatDateTime(new Date())}\nСжато gzip: ${(rawBuffer.length / 1024 / 1024).toFixed(2)} МБ → ${(compressed.length / 1024 / 1024).toFixed(2)} МБ. Перед восстановлением распакуйте.`,
      files: [file],
    });
  } catch (err) {
    console.error('Не удалось отправить резервную копию в канал:', err.message);
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
      if (interaction.commandName === 'паспорт_история') {
        const focused = interaction.options.getFocused();
        const q = `%${focused}%`;
        const rows = await db.all(
          `SELECT DISTINCT static, name FROM membership_events WHERE static LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 25`,
          [q, q],
        );
        const choices = rows.map((r) => ({ name: `№ ${r.static} — ${r.name}`.slice(0, 100), value: r.static }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      if (interaction.commandName === 'резерв_восстановить') {
        const focused = interaction.options.getFocused().toLowerCase();
        const files = backup.listBackups().filter((f) => f.name.toLowerCase().includes(focused));
        const choices = files.slice(0, 25).map((f) => ({
          name: `${f.name} — ${(f.size / 1024 / 1024).toFixed(2)} МБ — ${formatDateTime(f.mtime)}`.slice(0, 100),
          value: f.name,
        }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      if (interaction.commandName === 'настройка_изменить' || interaction.commandName === 'настройка_показать') {
        const focused = interaction.options.getFocused().toLowerCase();
        const keys = configStore.getSettableKeys().filter((k) => k.toLowerCase().includes(focused));
        const choices = keys.slice(0, 25).map((k) => ({ name: `${k} (сейчас: ${config[k]})`.slice(0, 100), value: k }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      if (interaction.commandName === 'розыгрыш_завершить' || interaction.commandName === 'розыгрыш_отменить' || interaction.commandName === 'розыгрыш_реролл' || interaction.commandName === 'розыгрыш_участники' || interaction.commandName === 'розыгрыш_добавить_участника') {
        const focused = interaction.options.getFocused();
        let statusClause = '';
        let params = [`%${focused}%`];
        if (interaction.commandName === 'розыгрыш_реролл') {
          statusClause = "AND status = 'ended'";
        } else if (interaction.commandName === 'розыгрыш_завершить' || interaction.commandName === 'розыгрыш_отменить' || interaction.commandName === 'розыгрыш_добавить_участника') {
          statusClause = "AND status = 'active'";
        } // giveaway_participants — любой статус, без фильтра
        const rows = await db.all(
          `SELECT * FROM giveaways WHERE prize LIKE ? ${statusClause} ORDER BY id DESC LIMIT 25`,
          params,
        );
        const statusLabels = { active: '🟢 идёт', ended: '⚪ завершён', cancelled: '❌ отменён' };
        const choices = rows.map((g) => ({
          name: `${g.prize} — ${statusLabels[g.status] || g.status}`.slice(0, 100),
          value: String(g.id),
        }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      if (interaction.commandName === 'розыгрыш_повтор_отменить') {
        const focused = interaction.options.getFocused();
        const rules = await db.all(`SELECT * FROM giveaway_recurring_rules WHERE status = 'active' AND prize LIKE ? ORDER BY id DESC LIMIT 25`, [`%${focused}%`]);
        const choices = rules.map((r) => ({
          name: `#${r.id} — ${r.prize} (каждый(ую) ${giveaways.WEEKDAY_NAMES[r.weekday]})`.slice(0, 100),
          value: String(r.id),
        }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      const autocompleteCommands = ['история', 'кто_это', 'правила_разослать', 'каналы_отчётов', 'отпуск_статистика', 'команды_человека'];
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

      if (cmd === 'пинг') {
        if (!(await checkCommandAccess('пинг', interaction.member))) {
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

      if (cmd === 'профили_восстановить') {
        if (!(await checkCommandAccess('профили_восстановить', interaction.member))) {
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

      if (cmd === 'история') {
        if (!(await checkCommandAccess('история', interaction.member))) {
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

      if (cmd === 'топ_контракты') {
        if (!(await checkCommandAccess('топ_контракты', interaction.member))) {
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

      if (cmd === 'аудит_поиск') {
        if (!(await checkCommandAccess('аудит_поиск', interaction.member))) {
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

      if (cmd === 'кто_это') {
        if (!(await checkCommandAccess('кто_это', interaction.member))) {
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

      if (cmd === 'экспорт_статистика') {
        if (!(await checkCommandAccess('экспорт_статистика', interaction.member))) {
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

      if (cmd === 'каналы_отчётов') {
        if (!(await checkCommandAccess('каналы_отчётов', interaction.member))) {
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

      if (cmd === 'статистика_организации') {
        if (!(await checkCommandAccess('статистика_организации', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const totalAccounts = (await db.get('SELECT COUNT(*) as cnt FROM participants')).cnt;
        const totalExtraPassports = (await db.get('SELECT COUNT(*) as cnt FROM extra_passports')).cnt;
        const totalPeople = totalAccounts + totalExtraPassports; // паспортов, не Discord-аккаунтов
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
            { name: 'Всего людей (паспортов)', value: String(totalPeople), inline: true },
            { name: 'Discord-аккаунтов', value: String(totalAccounts), inline: true },
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

      if (cmd === 'статус') {
        if (!(await checkCommandAccess('статус', interaction.member))) {
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

      if (cmd === 'экспорт_id') {
        if (!(await checkCommandAccess('экспорт_id', interaction.member))) {
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

        const formatOverwriteTarget = (overwrite) => {
          if (overwrite.type === 0) {
            const role = guild.roles.cache.get(overwrite.id);
            return role ? `роль «${role.name}»` : `роль ${overwrite.id}`;
          }
          const member = guild.members.cache.get(overwrite.id);
          return member ? `участник ${member.user.tag}` : `участник/бот ${overwrite.id}`;
        };

        const formatOverwrites = (channel, indent) => {
          const overwrites = [...channel.permissionOverwrites.cache.values()];
          if (overwrites.length === 0) return [];
          const result = [];
          for (const ow of overwrites) {
            const target = formatOverwriteTarget(ow);
            const allow = ow.allow.toArray();
            const deny = ow.deny.toArray();
            const parts = [];
            if (allow.length > 0) parts.push(`разрешено: ${allow.join(', ')}`);
            if (deny.length > 0) parts.push(`запрещено: ${deny.join(', ')}`);
            if (parts.length > 0) result.push(`${indent}  ↳ ${target} — ${parts.join(' | ')}`);
          }
          return result;
        };

        const lines = [];
        lines.push(`Сервер: ${guild.name} (${guild.id})`);
        lines.push(`Сформировано: ${formatDateTime(new Date())}`);
        lines.push('');
        lines.push('=== КАТЕГОРИИ И КАНАЛЫ (с переопределениями прав, если есть) ===');
        lines.push('');

        const allChannels = [...guild.channels.cache.values()];
        const categories = allChannels
          .filter((c) => c.type === ChannelType.GuildCategory)
          .sort((a, b) => a.position - b.position);

        for (const cat of categories) {
          lines.push(`[Категория] ${cat.name} — ${cat.id}`);
          lines.push(...formatOverwrites(cat, ''));
          const children = allChannels
            .filter((c) => c.parentId === cat.id && c.type !== ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);
          for (const ch of children) {
            lines.push(`  #${ch.name} (${typeLabel(ch.type)}) — ${ch.id}`);
            lines.push(...formatOverwrites(ch, '  '));
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
            lines.push(...formatOverwrites(ch, '  '));
          }
          lines.push('');
        }

        lines.push('=== РОЛИ (от старшей к младшей, с их правами на сервере) ===');
        lines.push('');
        const roles = [...guild.roles.cache.values()]
          .filter((r) => r.name !== '@everyone')
          .sort((a, b) => b.position - a.position);
        for (const role of roles) {
          const rolePerms = role.permissions.toArray();
          lines.push(`${role.name} — ${role.id}`);
          if (role.permissions.has(PermissionFlagsBits.Administrator)) {
            lines.push('  Права: Administrator (обходит вообще все ограничения каналов)');
          } else if (rolePerms.length > 0) {
            lines.push(`  Права: ${rolePerms.join(', ')}`);
          } else {
            lines.push('  Права: нет прав на уровне сервера (только то, что разрешено точечно на конкретных каналах)');
          }
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

      if (cmd === 'розыгрыш_старт') {
        if (!(await checkCommandAccess('розыгрыш_старт', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const prize = interaction.options.getString('приз');
        const durationStr = interaction.options.getString('длительность');
        const winnersCount = interaction.options.getInteger('победителей');
        const targetChannel = interaction.options.getChannel('канал') || interaction.channel;
        const requiredRole = interaction.options.getRole('условие');

        const durationMs = giveaways.parseDuration(durationStr);
        if (!durationMs) {
          return interaction.reply({ content: '⛔ Неверный формат длительности. Используйте, например: 30m, 2h, 1d, 1w.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const endsAt = new Date(Date.now() + durationMs);

        const giveawayId = await giveaways.createGiveaway(targetChannel.id, prize, winnersCount, interaction.user.id, endsAt.toISOString(), requiredRole ? requiredRole.id : null);
        const embed = buildGiveawayEmbed({ prize, winners_count: winnersCount, ends_at: endsAt.toISOString(), host_id: interaction.user.id, required_role_id: requiredRole ? requiredRole.id : null }, 0);
        const sent = await targetChannel.send({
          content: '🎉 **РОЗЫГРЫШ** 🎉',
          embeds: [embed],
          components: buildGiveawayComponents(giveawayId),
        });
        await giveaways.setMessageId(giveawayId, sent.id);

        await logAudit(guild, interaction.user, 'Розыгрыш запущен', `«${prize}» в <#${targetChannel.id}>, победителей: ${winnersCount}, до ${formatDateTime(endsAt)}${requiredRole ? `, условие: роль ${requiredRole.name}` : ''}`);
        await interaction.editReply(`Розыгрыш запущен в <#${targetChannel.id}>.`);
        return;
      }

      if (cmd === 'розыгрыш_добавить_участника') {
        if (!(await checkCommandAccess('розыгрыш_добавить_участника', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('розыгрыш');
        const targetUser = interaction.options.getUser('человек');
        const giveaway = await giveaways.getGiveaway(giveawayId);
        if (!giveaway || giveaway.status !== 'active') {
          await interaction.editReply('⛔ Розыгрыш не найден или уже завершён.');
          return;
        }

        if (giveaway.required_role_id) {
          let targetMember;
          try {
            targetMember = await guild.members.fetch(targetUser.id);
          } catch (_) {
            await interaction.editReply('⛔ Этого человека нет на сервере.');
            return;
          }
          if (!targetMember.roles.cache.has(giveaway.required_role_id)) {
            await interaction.editReply(`⛔ У этого розыгрыша есть условие участия (роль <@&${giveaway.required_role_id}>) — у выбранного человека её нет. Если всё равно нужно добавить — снимите условие через новый розыгрыш или временно выдайте роль.`);
            return;
          }
        }

        const already = await giveaways.hasEntry(giveawayId, targetUser.id);
        if (already) {
          await interaction.editReply('Этот человек уже участвует.');
          return;
        }
        await giveaways.addEntry(giveawayId, targetUser.id);
        const count = await giveaways.countEntries(giveawayId);
        try {
          const channel = await guild.channels.fetch(giveaway.channel_id);
          const msg = await channel.messages.fetch(giveaway.message_id);
          await msg.edit({ embeds: [buildGiveawayEmbed(giveaway, count)] });
        } catch (_) {}

        await logAudit(guild, interaction.user, 'Участник добавлен в розыгрыш вручную', `«${giveaway.prize}» — <@${targetUser.id}>`);
        await interaction.editReply(`✅ <@${targetUser.id}> добавлен(а) в розыгрыш «${giveaway.prize}».`);
        return;
      }

      if (cmd === 'розыгрыш_повтор_создать') {
        if (!(await checkCommandAccess('розыгрыш_повтор_создать', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const prize = interaction.options.getString('приз');
        const durationStr = interaction.options.getString('длительность');
        const winnersCount = interaction.options.getInteger('победителей');
        const weekday = parseInt(interaction.options.getString('день_недели'), 10);
        const targetChannel = interaction.options.getChannel('канал') || interaction.channel;
        const requiredRole = interaction.options.getRole('условие');

        const durationMs = giveaways.parseDuration(durationStr);
        if (!durationMs) {
          return interaction.reply({ content: '⛔ Неверный формат длительности. Используйте, например: 30m, 2h, 1d, 1w.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ruleId = await giveaways.createRecurringRule(targetChannel.id, prize, winnersCount, durationMs, weekday, interaction.user.id, requiredRole ? requiredRole.id : null);

        await logAudit(guild, interaction.user, 'Повторяющийся розыгрыш настроен', `«${prize}» — каждый(ую) ${giveaways.WEEKDAY_NAMES[weekday]} в <#${targetChannel.id}>${requiredRole ? `, условие: роль ${requiredRole.name}` : ''}`);
        await interaction.editReply(`Готово. Правило #${ruleId}: «${prize}» будет запускаться каждый(ую) ${giveaways.WEEKDAY_NAMES[weekday]} в <#${targetChannel.id}>.`);
        return;
      }

      if (cmd === 'розыгрыш_повтор_список') {
        if (!(await checkCommandAccess('розыгрыш_повтор_список', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rules = await giveaways.getActiveRecurringRules();
        if (rules.length === 0) {
          await interaction.editReply('Повторяющихся розыгрышей пока не настроено.');
          return;
        }
        const lines = rules.map((r) => `#${r.id} — «${r.prize}», каждый(ую) ${giveaways.WEEKDAY_NAMES[r.weekday]}, в <#${r.channel_id}>, победителей: ${r.winners_count}${r.required_role_id ? `, условие: <@&${r.required_role_id}>` : ''}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🔁 Повторяющиеся розыгрыши').setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'розыгрыш_повтор_отменить') {
        if (!(await checkCommandAccess('розыгрыш_повтор_отменить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ruleId = interaction.options.getString('правило');
        const ruleRow = await giveaways.getRecurringRule(ruleId);
        if (!ruleRow || ruleRow.status !== 'active') {
          await interaction.editReply('⛔ Такое правило не найдено или уже остановлено.');
          return;
        }
        await giveaways.setRecurringRuleStatus(ruleId, 'paused');
        await logAudit(guild, interaction.user, 'Повторяющийся розыгрыш остановлен', `«${ruleRow.prize}» (правило #${ruleId})`);
        await interaction.editReply(`Правило #${ruleId} («${ruleRow.prize}») остановлено — новые розыгрыши по нему создаваться не будут.`);
        return;
      }

      if (cmd === 'розыгрыш_завершить') {
        if (!(await checkCommandAccess('розыгрыш_завершить', interaction.member))) {
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

      if (cmd === 'розыгрыш_отменить') {
        if (!(await checkCommandAccess('розыгрыш_отменить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('розыгрыш');
        const cancelled = await cancelGiveaway(guild, giveawayId, interaction.user);
        await interaction.editReply(cancelled ? 'Розыгрыш отменён.' : '⛔ Розыгрыш не найден или уже завершён.');
        return;
      }

      if (cmd === 'розыгрыш_участники') {
        if (!(await checkCommandAccess('розыгрыш_участники', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('розыгрыш');
        const giveaway = await giveaways.getGiveaway(giveawayId);
        if (!giveaway) {
          await interaction.editReply('⛔ Розыгрыш не найден.');
          return;
        }
        const entries = await giveaways.getEntries(giveawayId);
        const statusLabels = { active: '🟢 Идёт', ended: '⚪ Завершён', cancelled: '❌ Отменён' };
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🎉 Участники: ${giveaway.prize}`)
          .addFields(
            { name: 'Статус', value: statusLabels[giveaway.status] || giveaway.status, inline: true },
            { name: 'Победителей', value: String(giveaway.winners_count), inline: true },
            { name: 'Всего участников', value: String(entries.length), inline: true },
          );
        if (entries.length > 0) {
          const list = entries.map((discordId, i) => `${i + 1}. <@${discordId}>`).join('\n');
          embed.addFields({ name: 'Список', value: list.slice(0, 4000) });
          if (list.length > 4000) {
            embed.setFooter({ text: 'Список обрезан — слишком много участников для одного сообщения.' });
          }
        } else {
          embed.addFields({ name: 'Список', value: 'Пока никто не участвует.' });
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'настройка_изменить') {
        if (!(await checkCommandAccess('настройка_изменить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const key = interaction.options.getString('ключ');
        const rawValue = interaction.options.getString('значение');
        try {
          if (rawValue.trim().toLowerCase() === 'сброс') {
            await configStore.clearOverride(key);
            await logAudit(guild, interaction.user, 'Настройка сброшена', `${key} → значение по умолчанию`);
            await interaction.editReply(`Настройка «${key}» сброшена на значение по умолчанию: ${config[key]}`);
            return;
          }
          const oldValue = config[key];
          const newValue = await configStore.setOverride(key, rawValue, interaction.user.id);
          await logAudit(guild, interaction.user, 'Настройка изменена', `${key}: ${oldValue} → ${newValue}`);
          await interaction.editReply(`Готово. «${key}» теперь: ${newValue}\n\n(применилось сразу, без перезапуска — но проверьте, что значение корректное, например реальный ID канала/роли)`);
        } catch (err) {
          await interaction.editReply(`⛔ ${err.message}`);
        }
        return;
      }

      if (cmd === 'настройка_показать') {
        if (!(await checkCommandAccess('настройка_показать', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const key = interaction.options.getString('ключ');
        if (key) {
          const override = await configStore.getOverride(key);
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`Настройка: ${key}`)
            .addFields(
              { name: 'Текущее значение', value: String(config[key]), inline: true },
              { name: 'Переопределено?', value: override ? `Да (кем: <@${override.updated_by}>, ${formatDateTime(new Date(override.updated_at))})` : 'Нет (значение по умолчанию)', inline: true },
            );
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        const allOverrides = await db.all('SELECT * FROM config_overrides ORDER BY key');
        if (allOverrides.length === 0) {
          await interaction.editReply('Переопределений нет — все настройки используют значения по умолчанию из кода.');
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Переопределённые настройки')
          .setDescription(allOverrides.map((o) => `**${o.key}** = ${o.value} (кем: <@${o.updated_by}>, ${formatDateTime(new Date(o.updated_at))})`).join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'настройка_переключить') {
        if (!(await checkCommandAccess('настройка_переключить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const feature = interaction.options.getString('функция');
        const state = interaction.options.getString('состояние');
        const featureLabels = { applications: 'Заявки на вступление', contracts: 'Приём скриншотов контрактов', reminders: 'Напоминания' };
        await db.setSetting(`feature_${feature}_enabled`, state === 'on' ? 'true' : 'false');
        await logAudit(guild, interaction.user, 'Переключена функция бота', `${featureLabels[feature]}: ${state === 'on' ? 'включено' : 'выключено'}`);
        await interaction.editReply(`${featureLabels[feature]}: **${state === 'on' ? 'включено' : 'выключено'}**.`);
        return;
      }

      if (cmd === 'отпуска_календарь') {
        if (!(await checkCommandAccess('отпуска_календарь', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const participants = await db.all('SELECT discord_id, name, static, vacation_until FROM participants WHERE vacation_until IS NOT NULL');
        const extras = await db.all('SELECT discord_id, name, static, vacation_until FROM extra_passports WHERE vacation_until IS NOT NULL');
        const all = [...participants, ...extras].sort((a, b) => new Date(a.vacation_until) - new Date(b.vacation_until));
        const embed = new EmbedBuilder().setColor(0xfee75c).setTitle('🏖️ Кто сейчас в отпуске');
        if (all.length === 0) {
          embed.setDescription('Сейчас никто не в отпуске.');
        } else {
          embed.setDescription(all.map((p) => `<@${p.discord_id}> — ${p.name} (№ ${p.static}) — до ${formatDateTime(new Date(p.vacation_until))}`).join('\n').slice(0, 4000));
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'список_afk') {
        if (!(await checkCommandAccess('список_afk', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const participants = await db.all('SELECT discord_id, name, static, afk_since FROM participants WHERE afk_since IS NOT NULL');
        const extras = await db.all('SELECT discord_id, name, static, afk_since FROM extra_passports WHERE afk_since IS NOT NULL');
        const all = [...participants, ...extras];
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('💤 Кто сейчас AFK');
        if (all.length === 0) {
          embed.setDescription('Сейчас никто не AFK.');
        } else {
          embed.setDescription(all.map((p) => `<@${p.discord_id}> — ${p.name} (№ ${p.static}) — с ${p.afk_since}`).join('\n').slice(0, 4000));
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'топ_приглашения') {
        if (!(await checkCommandAccess('топ_приглашения', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const board = await invitations.getAllTimeLeaderboard();
        if (board.length === 0) {
          await interaction.editReply('Пока нет подтверждённых приглашений.');
          return;
        }
        const lines = board.slice(0, 25).map((row, i) => `${i + 1}. <@${row.inviter_discord_id}> — ${row.cnt}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🏆 Топ по приглашениям за всё время').setDescription(lines.join('\n'));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'бэкап_сейчас') {
        if (!(await checkCommandAccess('бэкап_сейчас', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const filePath = backup.backupNow();
        await logAudit(guild, interaction.user, 'Резервная копия создана вручную', filePath ? 'Успешно' : 'Ошибка — см. консоль/канал аудита');
        if (filePath) {
          await uploadBackupFile(filePath, `вручную, ${interaction.user.tag}`);
        }
        await interaction.editReply(filePath ? '✅ Резервная копия создана и отправлена в канал бэкапов.' : '⛔ Не удалось создать резервную копию — подробности в консоли.');
        return;
      }

      if (cmd === 'бэкапы_список') {
        if (!(await checkCommandAccess('бэкапы_список', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const files = backup.listBackups();
        if (files.length === 0) {
          await interaction.editReply('Резервных копий пока нет.');
          return;
        }
        const lines = files.map((f) => `${f.name} — ${(f.size / 1024 / 1024).toFixed(2)} МБ — ${formatDateTime(f.mtime)}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('💾 Резервные копии БД').setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'резерв_восстановить') {
        if (!(await checkCommandAccess('резерв_восстановить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const filename = interaction.options.getString('файл');
        const files2 = backup.listBackups();
        const target = files2.find((f) => f.name === filename);
        if (!target) {
          return interaction.reply({ content: '⛔ Такой резервной копии не существует.', flags: MessageFlags.Ephemeral });
        }

        const confirmEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('⚠️ Восстановление базы данных')
          .setDescription(
            `Вы собираетесь заменить **текущую** базу данных файлом:\n\`${target.name}\` (${(target.size / 1024 / 1024).toFixed(2)} МБ, от ${formatDateTime(target.mtime)}).\n\n` +
            `**Все данные, добавленные после этой резервной копии, будут потеряны безвозвратно.**\nПеред восстановлением рекомендуется сделать свежий бэкап через \`/бэкап_сейчас\`.\n\n` +
            `После подтверждения бот нужно будет **вручную перезапустить** (Restart на Bothost), чтобы изменения точно применились.`,
          );
        return interaction.reply({
          embeds: [confirmEmbed],
          components: [row(
            new ButtonBuilder().setCustomId(`restore_confirm:${filename}`).setLabel('⚠️ Да, восстановить').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('restore_cancel').setLabel('Отмена').setStyle(ButtonStyle.Secondary),
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (cmd === 'аудит_экспорт') {
        if (!(await checkCommandAccess('аудит_экспорт', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = await db.all('SELECT * FROM audit_log WHERE at >= ? ORDER BY at ASC', [since]);
        if (rows.length === 0) {
          await interaction.editReply(`Записей за последние ${days} дней не найдено.`);
          return;
        }
        const csv = buildCsv(
          ['дата', 'действие', 'инициатор_тег', 'инициатор_id', 'детали'],
          rows.map((r) => [r.at, r.action, r.actor_tag, r.actor_id, r.details]),
        );
        const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `audit_${days}d.csv` });
        await logAudit(guild, interaction.user, 'Экспорт аудита', `За последние ${days} дней, записей: ${rows.length}`);
        await interaction.editReply({ content: `Аудит за последние ${days} дней (${rows.length} записей):`, files: [file] });
        return;
      }

      if (cmd === 'помощь') {
        if (!(await checkCommandAccess('помощь', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const descByName = new Map(commands.map((c) => [c.name, c.description]));
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📖 Все команды бота');
        for (const cat of COMMAND_CATEGORIES) {
          const lines = cat.commands.map((name) => `\`/${name}\` — ${descByName.get(name) || '—'}`);
          embed.addFields({ name: cat.title, value: lines.join('\n').slice(0, 1024) });
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'права_команд') {
        if (!(await checkCommandAccess('права_команд', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const overrides = await db.all('SELECT command_name, tier FROM command_permission_overrides');
        const overrideMap = new Map(overrides.map((o) => [o.command_name, o.tier]));

        const grouped = { admin: [], owner: [], deputy: [], hr: [], specific: [] };
        for (const [name, defaultTier] of Object.entries(COMMAND_DEFAULT_TIERS)) {
          const effectiveTier = overrideMap.has(name) ? overrideMap.get(name) : defaultTier;
          const mark = overrideMap.has(name) ? ' *' : '';
          if (isSnowflake(effectiveTier)) {
            grouped.specific.push(`\`/${name}\`${mark} → <@${effectiveTier}>`);
          } else {
            (grouped[effectiveTier] || grouped[defaultTier]).push(`\`/${name}\`${mark}`);
          }
        }

        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🔐 Права доступа к командам');
        for (const [tierKey, info] of Object.entries(TIER_INFO)) {
          embed.addFields({ name: info.label, value: grouped[tierKey].join(', ').slice(0, 1024) || '—' });
        }
        if (grouped.specific.length > 0) {
          embed.addFields({ name: '🔒 Только конкретный человек', value: grouped.specific.join('\n').slice(0, 1024) });
        }
        if (overrides.length > 0) {
          embed.setFooter({ text: '* — переопределено вручную (отличается от значения по умолчанию)' });
        }

        await interaction.editReply({
          embeds: [embed],
          components: [row(new ButtonBuilder().setCustomId('perm_edit_start').setLabel('✏️ Изменить право команды').setStyle(ButtonStyle.Primary))],
        });
        return;
      }

      if (cmd === 'паспорт_история') {
        if (!(await checkCommandAccess('паспорт_история', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const staticValue = interaction.options.getString('паспорт').trim();

        const changes = await db.all(
          `SELECT * FROM data_change_requests WHERE target_static = ? ORDER BY id ASC`,
          [staticValue],
        );
        const events = await db.all(
          `SELECT * FROM membership_events WHERE static = ? ORDER BY at ASC`,
          [staticValue],
        );

        if (changes.length === 0 && events.length === 0) {
          await interaction.editReply(`По паспорту № ${staticValue} истории не найдено.`);
          return;
        }

        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`История паспорта № ${staticValue}`);

        if (events.length > 0) {
          const lines = events.map((e) => `${e.event === 'joined' ? '✅ Вступил(а)' : '🚫 Покинул(а)'} — ${e.name} — ${formatDateTime(new Date(e.at))}${e.note ? `: ${e.note}` : ''}`);
          embed.addFields({ name: 'Вступление/увольнение', value: lines.join('\n').slice(0, 1024) });
        }

        if (changes.length > 0) {
          const lines = changes
            .filter((c) => c.status === 'accepted')
            .map((c) => `«${c.old_name}» → «${c.new_name}» — ${formatDateTime(new Date(c.created_at))}`);
          if (lines.length > 0) {
            embed.addFields({ name: 'Смена Имени Фамилии', value: lines.join('\n').slice(0, 1024) });
          }
        }

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'сверка_ролей') {
        if (!(await checkCommandAccess('сверка_ролей', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const allParticipants = await db.all('SELECT discord_id FROM participants');
        const mismatches = [];

        for (const p of allParticipants) {
          if (p.discord_id.startsWith('nodiscord-')) continue;
          const identity = await passportsLib.computeEffectiveIdentity(p.discord_id);
          if (!identity || !identity.role_id) continue;

          let member;
          try {
            member = await guild.members.fetch(p.discord_id);
          } catch (_) {
            continue; // человек мог покинуть сервер — тут сверять нечего
          }

          const expectedRoleId = identity.role_id;
          const hasExpected = member.roles.cache.has(expectedRoleId);
          const otherRankRoles = config.ROLE_IDS.filter((r) => r !== expectedRoleId && member.roles.cache.has(r));

          if (!hasExpected || otherRankRoles.length > 0) {
            let expectedRoleName = expectedRoleId;
            try {
              const r = await guild.roles.fetch(expectedRoleId);
              if (r) expectedRoleName = r.name;
            } catch (_) {}

            const actualNames = [];
            for (const rid of config.ROLE_IDS) {
              if (member.roles.cache.has(rid)) {
                try {
                  const r = await guild.roles.fetch(rid);
                  actualNames.push(r ? r.name : rid);
                } catch (_) {
                  actualNames.push(rid);
                }
              }
            }

            mismatches.push(`<@${p.discord_id}> (${identity.name}) — в базе: **${expectedRoleName}**, на сервере: **${actualNames.join(', ') || 'нет ранговой роли'}**`);
          }
        }

        if (mismatches.length === 0) {
          await interaction.editReply('✅ Расхождений не найдено — роли на сервере совпадают с базой у всех.');
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('⚠️ Расхождения роль на сервере ↔ ранг в базе')
          .setDescription(mismatches.join('\n').slice(0, 4000));
        if (mismatches.length > 1 || mismatches.join('\n').length > 4000) {
          embed.setFooter({ text: `Всего расхождений: ${mismatches.length}` });
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'экспорт_бд') {
        if (!(await checkCommandAccess('экспорт_бд', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
        const files = [];
        for (const t of tables) {
          const rows = await db.all(`SELECT * FROM ${t.name}`);
          if (rows.length === 0) continue; // пустые таблицы пропускаем
          const headers = Object.keys(rows[0]);
          const csv = buildCsv(headers, rows.map((r) => headers.map((h) => r[h])));
          files.push(new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `${t.name}.csv` }));
        }

        if (files.length === 0) {
          await interaction.editReply('В базе пока нет данных для выгрузки.');
          return;
        }

        await logAudit(guild, interaction.user, 'Экспорт базы данных', `Таблиц с данными: ${files.length} из ${tables.length}`);

        for (let i = 0; i < files.length; i += 10) {
          const chunk = files.slice(i, i + 10);
          if (i === 0) {
            await interaction.editReply({ content: `Экспорт БД — ${files.length} таблиц с данными (пустые пропущены):`, files: chunk });
          } else {
            await interaction.followUp({ files: chunk, flags: MessageFlags.Ephemeral });
          }
        }
        return;
      }

      if (cmd === 'отпуск_статистика') {
        if (!(await checkCommandAccess('отпуск_статистика', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const personQuery = interaction.options.getString('человек');
        const days = interaction.options.getInteger('дней') || 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        let targetDiscordId = null;
        if (personQuery) {
          const target = await invitations.resolveInviter(personQuery);
          if (!target) {
            await interaction.editReply('⛔ Человек не найден.');
            return;
          }
          targetDiscordId = target.discord_id;
        }

        const selfServiceRows = await db.all(
          `SELECT * FROM vacations WHERE status = 'accepted' AND created_at >= ?${targetDiscordId ? ' AND discord_id = ?' : ''}`,
          targetDiscordId ? [since.toISOString(), targetDiscordId] : [since.toISOString()],
        );
        const grantedRows = await db.all(
          `SELECT * FROM status_events WHERE type = 'vacation' AND action = 'granted' AND at >= ?${targetDiscordId ? ' AND discord_id = ?' : ''}`,
          targetDiscordId ? [since.toISOString(), targetDiscordId] : [since.toISOString()],
        );

        const perPerson = new Map(); // discordId -> {count, days}
        const addInstance = (discordId, startIso, endIso) => {
          if (!startIso || !endIso) return;
          const start = new Date(startIso);
          const end = new Date(endIso);
          const durationDays = Math.max(0, Math.round((end - start) / (24 * 60 * 60 * 1000)));
          const cur = perPerson.get(discordId) || { count: 0, days: 0 };
          cur.count += 1;
          cur.days += durationDays;
          perPerson.set(discordId, cur);
        };

        for (const r of selfServiceRows) addInstance(r.discord_id, r.created_at, r.until);
        for (const r of grantedRows) addInstance(r.discord_id, r.at, r.until);

        if (perPerson.size === 0) {
          await interaction.editReply(`За последние ${days} дней отпусков не найдено${targetDiscordId ? ' у этого человека' : ''}.`);
          return;
        }

        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🏖️ Статистика отпусков за последние ${days} дней`);
        if (targetDiscordId) {
          const stat = perPerson.get(targetDiscordId);
          if (!stat) {
            await interaction.editReply(`За последние ${days} дней у этого человека отпусков не найдено.`);
            return;
          }
          embed.setDescription(`<@${targetDiscordId}> — уходил(а) в отпуск **${stat.count}** раз(а), суммарно **${stat.days}** дней.`);
        } else {
          const sorted = [...perPerson.entries()].sort((a, b) => b[1].days - a[1].days).slice(0, 25);
          embed.setDescription(sorted.map(([id, s], i) => `${i + 1}. <@${id}> — ${s.count} раз(а), ${s.days} дней`).join('\n').slice(0, 4000));
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'повышения_история') {
        if (!(await checkCommandAccess('повышения_история', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = await db.all(
          `SELECT * FROM audit_log WHERE action IN ('⬆️ Авто-повышение по контрактам', '⬇️ Еженедельное авто-понижение') AND at >= ? ORDER BY at DESC LIMIT 15`,
          [since],
        );
        if (rows.length === 0) {
          await interaction.editReply(`За последние ${days} дней авто-корректировок рангов не было.`);
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🔄 История авто-повышений/понижений (за ${days} дней)`)
          .setDescription(rows.map((r) => `**${formatDateTime(new Date(r.at))}**\n${r.details.slice(0, 500)}`).join('\n\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'журнал_прав') {
        if (!(await checkCommandAccess('журнал_прав', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rows = await db.all(
          `SELECT * FROM audit_log WHERE action IN ('Право команды изменено', 'Право команды сброшено') ORDER BY at DESC LIMIT 20`,
        );
        if (rows.length === 0) {
          await interaction.editReply('Изменений прав команд ещё не было.');
          return;
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🔐 Журнал изменений прав команд')
          .setDescription(rows.map((r) => `**${r.action}** — ${r.actor_tag}, ${formatDateTime(new Date(r.at))}\n${r.details}`).join('\n\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'команды_человека') {
        if (!(await checkCommandAccess('команды_человека', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('человек');
        const target = await invitations.resolveInviter(query);
        if (!target) {
          await interaction.editReply('⛔ Человек не найден.');
          return;
        }
        let member;
        try {
          member = await guild.members.fetch(target.discord_id);
        } catch (_) {
          await interaction.editReply('⛔ Этого человека нет на сервере — оценить его роли невозможно.');
          return;
        }

        const allowed = [];
        for (const commandName of Object.keys(COMMAND_DEFAULT_TIERS)) {
          if (await checkCommandAccess(commandName, member)) {
            allowed.push(commandName);
          }
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Команды, доступные: ${target.name} (<@${target.discord_id}>)`);
        if (allowed.length === 0) {
          embed.setDescription('Этому человеку не доступна ни одна команда.');
        } else {
          embed.setDescription(allowed.map((c) => `\`/${c}\``).join(', ').slice(0, 4000));
          embed.setFooter({ text: `Всего: ${allowed.length} из ${Object.keys(COMMAND_DEFAULT_TIERS).length}` });
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'поиск_везде') {
        if (!(await checkCommandAccess('поиск_везде', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const text = interaction.options.getString('текст');

        const { embed, totalFound, hasMore } = await runGlobalSearch(text, 0);
        if (totalFound === 0) {
          await interaction.editReply('Ничего не найдено ни в одной из таблиц.');
          return;
        }

        const searchId = Math.random().toString(36).slice(2, 10);
        searchQueryCache.set(searchId, text);
        // Чистим совсем старые запросы, чтобы Map не рос бесконечно
        if (searchQueryCache.size > 200) {
          const oldestKey = searchQueryCache.keys().next().value;
          searchQueryCache.delete(oldestKey);
        }

        await interaction.editReply({ embeds: [embed], components: buildSearchComponents(searchId, 0, hasMore) });
        return;
      }

      if (cmd === 'предпросмотр') {
        if (!(await checkCommandAccess('предпросмотр', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const type = interaction.options.getString('тип');
        const defaults = { rules: DEFAULT_RULES, agitation: DEFAULT_AGITATION, hr_info: DEFAULT_HR_INFO };
        const titles = { rules: '📕 Свод правил (предпросмотр)', agitation: '🗣️ Агитация (предпросмотр)', hr_info: '📋 Вакансия HR (предпросмотр)' };
        const text = await getCurrentText(type, defaults[type]);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(titles[type]).setDescription(text.slice(0, 4000));
        await interaction.editReply({ content: 'Вот как это выглядит сейчас — видите только вы, никому не отправлено:', embeds: [embed] });
        return;
      }


      if (cmd === 'розыгрыш_реролл') {
        if (!(await checkCommandAccess('розыгрыш_реролл', interaction.member))) {
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

      if (cmd === 'меню_создать') {
        if (!(await checkCommandAccess('меню_создать', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await initMenus(guild);
        await interaction.editReply('Меню успешно инициализированы.');
        return;
      }

      if (cmd === 'правила' || cmd === 'агитация') {
        if (!(await checkCommandAccess(cmd, interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        if (cmd === 'правила') {
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

      if (cmd === 'hr_вакансия') {
        if (!(await checkCommandAccess('hr_вакансия', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const text = await getCurrentText('hr_info', DEFAULT_HR_INFO);
        const channel = await guild.channels.fetch(config.CHANNEL_HR_APPLY_MENU);
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text)] });
        return interaction.reply({ content: 'Описание вакансии HR отправлено в канал.', flags: MessageFlags.Ephemeral });
      }

      if (cmd === 'правила_разослать') {
        if (!(await checkCommandAccess('правила_разослать', interaction.member))) {
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

      if (cmd === 'рассылка_сообщение') {
        if (!(await checkCommandAccess('рассылка_сообщение', interaction.member))) {
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

      if (cmd === 'правила_обновить' || cmd === 'агитация_обновить' || cmd === 'hr_вакансия_обновить') {
        if (!(await checkCommandAccess(cmd, interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const type = cmd === 'правила_обновить' ? 'rules' : cmd === 'агитация_обновить' ? 'agitation' : 'hr_info';
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

        if (status === 'fulfilled' || status === 'unfulfilled') {
          await checkContractPromotion(guild, contract.thread_id);
        }
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
        const passports = await passportsLib.getAllPassports(discordId);

        if (passports.length <= 1) {
          const staticValue = passports.length === 1 ? passports[0].static : '';
          return interaction.showModal(buildManualContractModal(status, discordId, staticValue));
        }

        const passportSelect = new StringSelectMenuBuilder()
          .setCustomId(`select_contract_manual_passport:${status}:${discordId}`)
          .setPlaceholder('По какому паспорту засчитать контракт?')
          .addOptions(passports.map((p) => new StringSelectMenuOptionBuilder().setLabel(`${p.name} (№ ${p.static})`).setValue(p.static)));
        return safeReply(interaction, { content: 'У этого человека несколько паспортов — выберите, по какому засчитать контракт:', components: [row(passportSelect)] });
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
        if (!(await isFeatureEnabled('applications'))) {
          return safeReply(interaction, '⛔ Приём заявок на вступление временно приостановлен. Попробуйте позже.');
        }
        const existing = await db.get('SELECT id FROM participants WHERE discord_id = ?', [interaction.user.id]);
        if (existing) {
          return interaction.showModal(buildPassportRequestModal());
        }

        const lastRejected = await db.get(
          `SELECT * FROM applications WHERE discord_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1`,
          [interaction.user.id],
        );
        if (lastRejected) {
          const cooldownMs = config.APPLICATION_COOLDOWN_HOURS * 60 * 60 * 1000;
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
        if (!already && giveaway.required_role_id && !interaction.member.roles.cache.has(giveaway.required_role_id)) {
          return safeReply(interaction, `⛔ Участвовать может только роль <@&${giveaway.required_role_id}>.`);
        }
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

      if (id.startsWith('afk_return:')) {
        const [, discordId, staticValue] = id.split(':');
        if (interaction.user.id !== discordId) {
          return safeReply(interaction, '⛔ Это не ваше уведомление.');
        }
        const passports = await passportsLib.getAllPassports(discordId);
        const passport = passports.find((p) => p.static === staticValue);
        if (!passport || !passport.afk_since) {
          return safeReply(interaction, '⛔ AFK по этому паспорту уже снят или не найден.');
        }

        const requestKey = `${discordId}:${staticValue}`;
        const already = await db.get(
          'SELECT * FROM afk_return_requests WHERE key = ? AND afk_since = ?',
          [requestKey, passport.afk_since],
        );
        if (already) {
          return safeReply(interaction, '⛔ Вы уже отправляли это уведомление — дождитесь, пока руководство снимет AFK.');
        }
        await db.run(
          `INSERT INTO afk_return_requests (key, discord_id, static, afk_since, requested_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET afk_since = excluded.afk_since, requested_at = excluded.requested_at`,
          [requestKey, discordId, staticValue, passport.afk_since, new Date().toISOString()],
        );

        try {
          const membersChannel = await guild.channels.fetch(config.CHANNEL_AFK_RETURN);
          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ Возврат из AFK — требуется проверка')
            .addFields(
              { name: 'Участник', value: `<@${discordId}>`, inline: true },
              { name: 'Имя Фамилия', value: passport.name, inline: true },
              { name: '№ Паспорта', value: passport.static, inline: true },
            )
            .setDescription('Сообщил(а), что вернулся(лась) в игру. Проверьте и снимите AFK.');
          await membersChannel.send({
            content: perms.mentionManagementRoles(),
            embeds: [embed],
            components: [row(new ButtonBuilder().setCustomId(`afk_return_confirm:${discordId}:${staticValue}`).setLabel('✅ Снять AFK').setStyle(ButtonStyle.Success))],
            ...mentionOpts,
          });
        } catch (err) {
          console.error('Не удалось отправить уведомление о возврате из AFK:', err.message);
          await db.run('DELETE FROM afk_return_requests WHERE key = ?', [requestKey]);
          return safeReply(interaction, '⛔ Не удалось отправить уведомление руководству — сообщите им напрямую.');
        }

        // Отключаем именно эту кнопку в ЛС (остальные, если по другим
        // паспортам, остаются рабочими) — чтобы нельзя было спамить.
        try {
          const newComponents = interaction.message.components.map((r) => {
            const newRow = ActionRowBuilder.from(r);
            newRow.components = newRow.components.map((c) => {
              const btn = ButtonBuilder.from(c);
              if (c.customId === id) btn.setDisabled(true).setLabel(`✅ Уведомление отправлено`);
              return btn;
            });
            return newRow;
          });
          await interaction.message.edit({ components: newComponents });
        } catch (_) {}

        return safeReply(interaction, '✅ Уведомление отправлено руководству, ждите снятия AFK.');
      }

      if (id.startsWith('afk_return_confirm:')) {
        if (!perms.isHrTier(interaction.member)) {
          return safeReply(interaction, '⛔ Снимать AFK по такому уведомлению может только HR-Менеджер и выше.');
        }
        const [, discordId, staticValue] = id.split(':');
        const passports = await passportsLib.getAllPassports(discordId);
        const passport = passports.find((p) => p.static === staticValue);
        if (!passport || !passport.afk_since) {
          return safeReply(interaction, 'AFK по этому паспорту уже снят.');
        }

        await passportsLib.updatePassportFields(discordId, staticValue, { afk_since: null });
        await history.logStatusRevoked('afk', discordId, staticValue, passport.name, interaction.user.id);
        await db.run('DELETE FROM afk_return_requests WHERE key = ?', [`${discordId}:${staticValue}`]);
        await syncStatusRoles(guild, discordId);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'AFK снят по уведомлению о возврате', `<@${discordId}> (${passport.name}, № ${staticValue})`);

        try {
          await interaction.message.edit({
            content: '',
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x2b2d31).setDescription(`✅ AFK снят — <@${interaction.user.id}>, ${formatDateTime(new Date())}`)],
            components: [],
          });
        } catch (_) {}

        await dmUser(guild, discordId, `✅ AFK снят по паспорту № ${staticValue} (${passport.name}). С возвращением!`);
        return safeReply(interaction, `AFK снят: ${passport.name} (№ ${staticValue}).`);
      }

      if (id.startsWith('restore_confirm:')) {
        if (!(await checkCommandAccess('резерв_восстановить', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const filename = id.split(':')[1];
        await interaction.update({ content: '⏳ Восстанавливаю...', embeds: [], components: [] });
        try {
          backup.restoreFromBackup(filename);
          await logAudit(guild, interaction.user, '⚠️ База данных восстановлена из резервной копии', `Файл: ${filename}. Требуется перезапуск бота.`);
          await interaction.editReply(`✅ База данных восстановлена из \`${filename}\`.\n\n⚠️ **Перезапустите бота вручную (Restart на Bothost) прямо сейчас**, чтобы изменения точно применились.`);
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось восстановить: ${err.message}`);
        }
        return;
      }

      if (id === 'restore_cancel') {
        return interaction.update({ content: '❌ Восстановление отменено.', embeds: [], components: [] });
      }

      if (id.startsWith('search_page:')) {
        if (!(await checkCommandAccess('поиск_везде', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const [, searchId, pageStr] = id.split(':');
        const text = searchQueryCache.get(searchId);
        if (!text) {
          return safeReply(interaction, '⛔ Этот поиск устарел — выполните `/поиск_везде` заново.');
        }
        const page = parseInt(pageStr, 10);
        await interaction.deferUpdate();
        const { embed, hasMore } = await runGlobalSearch(text, page);
        await interaction.editReply({ embeds: [embed], components: buildSearchComponents(searchId, page, hasMore) });
        return;
      }

      if (id === 'perm_edit_start') {
        if (!(await checkCommandAccess('права_команд', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const allNames = Object.keys(COMMAND_DEFAULT_TIERS).sort();
        const half = Math.ceil(allNames.length / 2);
        const chunks = [allNames.slice(0, half), allNames.slice(half)];
        const components = chunks.map((chunk, i) =>
          row(
            new StringSelectMenuBuilder()
              .setCustomId(`perm_pick_cmd_${i}`)
              .setPlaceholder(`Выберите команду (${i === 0 ? 'A–' : ''}${i + 1}/${chunks.length})`)
              .addOptions(chunk.map((name) => new StringSelectMenuOptionBuilder().setLabel(`/${name}`).setValue(name))),
          ),
        );
        return safeReply(interaction, { content: 'Выберите команду, у которой хотите поменять уровень доступа:', components });
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
    if (interaction.isAnySelectMenu()) {
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

      if (customId === 'perm_pick_cmd_0' || customId === 'perm_pick_cmd_1') {
        if (!(await checkCommandAccess('права_команд', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const commandName = interaction.values[0];
        const currentTier = await getCommandTier(commandName);
        const tierSelect = new StringSelectMenuBuilder()
          .setCustomId(`perm_set_tier:${commandName}`)
          .setPlaceholder('Выберите новый уровень доступа')
          .addOptions(
            ...Object.entries(TIER_INFO).map(([key, info]) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(info.label)
                .setValue(key)
                .setDefault(key === currentTier),
            ),
            new StringSelectMenuOptionBuilder().setLabel('🔒 Только конкретный человек').setValue('__specific_user__').setDefault(isSnowflake(currentTier)),
            new StringSelectMenuOptionBuilder().setLabel('↩️ Сбросить на значение по умолчанию').setValue('__reset__'),
          );
        return safeReply(interaction, { content: `Команда: \`/${commandName}\` — текущий уровень: **${tierLabel(currentTier)}**`, components: [row(tierSelect)] });
      }

      if (customId.startsWith('perm_set_tier:')) {
        if (!(await checkCommandAccess('права_команд', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const commandName = customId.split(':')[1];
        const chosen = interaction.values[0];

        if (chosen === '__reset__') {
          await db.run('DELETE FROM command_permission_overrides WHERE command_name = ?', [commandName]);
          const defaultTier = COMMAND_DEFAULT_TIERS[commandName];
          await logAudit(guild, interaction.user, 'Право команды сброшено', `/${commandName} → ${tierLabel(defaultTier)} (по умолчанию)`);
          return safeReply(interaction, `Готово. \`/${commandName}\` сброшена на уровень по умолчанию: **${tierLabel(defaultTier)}**.`);
        }

        if (chosen === '__specific_user__') {
          const userSelect = new UserSelectMenuBuilder()
            .setCustomId(`perm_set_user:${commandName}`)
            .setPlaceholder('Выберите человека');
          return safeReply(interaction, { content: `Команда: \`/${commandName}\` — выберите единственного человека, кому будет доступна:`, components: [row(userSelect)] });
        }

        if (!TIER_INFO[chosen]) return safeReply(interaction, '⛔ Неизвестный уровень.');

        await db.run(
          `INSERT INTO command_permission_overrides (command_name, tier, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(command_name) DO UPDATE SET tier = excluded.tier, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          [commandName, chosen, interaction.user.id, new Date().toISOString()],
        );
        await logAudit(guild, interaction.user, 'Право команды изменено', `/${commandName} → ${tierLabel(chosen)}`);
        return safeReply(interaction, `Готово. \`/${commandName}\` теперь требует: **${tierLabel(chosen)}**\n\n(применилось сразу, без перезапуска)`);
      }

      if (customId.startsWith('perm_set_user:')) {
        if (!(await checkCommandAccess('права_команд', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const commandName = customId.split(':')[1];
        const chosenUserId = interaction.values[0];

        await db.run(
          `INSERT INTO command_permission_overrides (command_name, tier, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(command_name) DO UPDATE SET tier = excluded.tier, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          [commandName, chosenUserId, interaction.user.id, new Date().toISOString()],
        );
        await logAudit(guild, interaction.user, 'Право команды изменено', `/${commandName} → только <@${chosenUserId}>`);
        return safeReply(interaction, `Готово. \`/${commandName}\` теперь доступна только <@${chosenUserId}> (плюс Владелец/Admin по умолчанию).\n\n(применилось сразу, без перезапуска)`);
      }

      if (customId.startsWith('select_contract_manual_passport:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const [, status, discordId] = customId.split(':');
        const staticValue = interaction.values[0];
        return interaction.showModal(buildManualContractModal(status, discordId, staticValue));
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

        if (participants.length === 1) {
          return handleParticipantAction(interaction, guild, action, participants[0].discord_id, participants[0]);
        }

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
        const [, status, discordId, staticValue] = id.split(':');
        const link = get('link').trim();
        const dateInput = get('date').trim();
        let submittedAt;
        if (dateInput) {
          const date = parseDateOnly(dateInput);
          if (!date) return safeReply(interaction, '⛔ Неверный формат даты. Используйте ДД.ММ.ГГГГ (или ДД.ММ.ГГ / ДД.ММ) — разделитель точка, пробел или / — либо оставьте поле пустым.');
          submittedAt = date.toISOString();
        } else {
          submittedAt = new Date().toISOString();
        }

        let threadId = null;
        if (staticValue) {
          const passports = await passportsLib.getAllPassports(discordId);
          const passport = passports.find((p) => p.static === staticValue);
          threadId = passport ? passport.profile_thread_id : null;
        }

        await contracts.recordManualContract(discordId, link, submittedAt, status, interaction.user.id, threadId);
        await contractsDisplay.safeUpdateContractsStats(guild);

        const label = status === 'fulfilled' ? '✅ Выполнен' : '❌ Невыполнен';
        await logAudit(guild, interaction.user, 'Контракт добавлен вручную', `<@${discordId}>: ${label} — ${link}${staticValue ? ` (паспорт № ${staticValue})` : ''}`);

        if (threadId && (status === 'fulfilled' || status === 'unfulfilled')) {
          await checkContractPromotion(guild, threadId);
        }

        return safeReply(interaction, `Контракт добавлен (${label}).`);
      }

      // Заявка на отпуск (самостоятельно)
      if (id === 'modal_vacation_apply') {
        const deadline = parseDeadline(get('deadline'));
        if (!deadline) {
          return safeReply(interaction, '⛔ Неверный формат или дата уже прошла. Используйте ДД.ММ.ГГГГ / ДД.ММ.ГГ / ДД.ММ (год не указан — берётся текущий), разделитель точка/пробел/\/, либо число+d, например 7d.');
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
          return safeReply(interaction, '⛔ Неверный формат или дата уже прошла. Используйте ДД.ММ.ГГГГ / ДД.ММ.ГГ / ДД.ММ (год не указан — берётся текущий), разделитель точка/пробел/\/, либо число+d, например 7d.');
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
        if (!date) return safeReply(interaction, '⛔ Неверный формат даты. Используйте ДД.ММ.ГГГГ / ДД.ММ.ГГ / ДД.ММ, разделитель точка/пробел/\/.');

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
        const returnButtons = targets.map((p) =>
          new ButtonBuilder()
            .setCustomId(`afk_return:${discordId}:${p.static}`)
            .setLabel(targets.length > 1 ? `✅ Вошёл(а) — ${p.name}` : '✅ Вошёл(а)')
            .setStyle(ButtonStyle.Success),
        );
        // Кнопки в один ряд не больше 5 — на случай, если паспортов вдруг больше
        const buttonRows = [];
        for (let i = 0; i < returnButtons.length; i += 5) {
          buttonRows.push(row(...returnButtons.slice(i, i + 5)));
        }
        await dmUser(guild, discordId, {
          content: `💤 Вам выставлен статус AFK с ${formatDateOnly(date)}.${reason ? ` Причина: ${reason}.` : ''} Пожалуйста, зайдите в игру под именем **${names}**, чтобы статус отобразился.\n\nКогда вернётесь — нажмите кнопку ниже, руководство проверит и снимет AFK.`,
          components: buttonRows,
        });
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

client.on('shardDisconnect', (event, shardId) => {
  // В момент разрыва соединения слать сообщение в Discord бессмысленно —
  // связи как раз и нет. Логируем в консоль, а факт восстановления
  // подтверждаем через shardResume ниже.
  console.warn(`Шард ${shardId} отключился от Discord (код ${event.code}).`);
});

client.on('shardReconnecting', (shardId) => {
  console.warn(`Шард ${shardId} переподключается к Discord...`);
});

client.on('shardResume', async (shardId) => {
  console.log(`Шард ${shardId} восстановил соединение с Discord.`);
  try {
    if (!process.env.GUILD_ID) return;
    const resumeGuild = await client.guilds.fetch(process.env.GUILD_ID);
    await logSystem(resumeGuild, '🟢 Соединение восстановлено', `Бот снова на связи (шард ${shardId}).`);
  } catch (err) {
    console.error('Не удалось отправить уведомление о восстановлении связи:', err.message);
  }
});

client.on('error', (err) => {
  console.error('Ошибка клиента Discord:', err);
});

async function notifyShutdown(reason) {
  try {
    if (!process.env.GUILD_ID) return;
    const shutdownGuild = await client.guilds.fetch(process.env.GUILD_ID);
    await logSystem(shutdownGuild, '🔴 Бот останавливается', reason);
  } catch (err) {
    console.error('Не удалось отправить уведомление об остановке:', err.message);
  }
}

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен сигнал ${signal} — завершаю работу...`);
  await notifyShutdown(`Получен сигнал ${signal} — обычно означает перезапуск/остановку/новый деплой на хостинге.`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  if (process.env.GUILD_ID) {
    client.guilds.fetch(process.env.GUILD_ID)
      .then((crashGuild) => logSystem(crashGuild, '⚠️ Неперехваченная ошибка (uncaughtException)', `${err.message}\n\`\`\`${String(err.stack || '').slice(0, 1500)}\`\`\``))
      .catch(() => {});
  }
});

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
  if (process.env.GUILD_ID) {
    client.guilds.fetch(process.env.GUILD_ID)
      .then((rejectionGuild) => logSystem(rejectionGuild, '⚠️ Необработанный reject (unhandledRejection)', `${err && err.message ? err.message : String(err)}`))
      .catch(() => {});
  }
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

    if (!(await isFeatureEnabled('contracts'))) {
      await message.react('⏸️').catch(() => {});
      return;
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
  const overridesCount = await configStore.loadOverrides();
  if (overridesCount > 0) console.log(`Применено переопределений конфига из БД: ${overridesCount}`);
  await registerCommands();

  if (process.env.GUILD_ID) {
    try {
      const startupGuild = await client.guilds.fetch(process.env.GUILD_ID);
      await logSystem(startupGuild, '🔄 Бот запущен/перезапущен', `${client.user.tag} в сети.`);
    } catch (err) {
      console.error('Не удалось залогировать запуск бота в аудит:', err.message);
    }
  }

  // Отключение/переподключение к Discord (шард) — best-effort: если бот
  // реально offline, сообщение может не дойти (это неизбежное ограничение,
  // отправить сообщение можно только пока есть связь). Используем
  // guild.cache, а не fetch — не делает лишний сетевой запрос, работает,
  // даже если гейтвей уже нестабилен.
  client.on('shardDisconnect', async (event) => {
    console.warn('Бот отключился от Discord (shardDisconnect):', event && event.code);
    if (!process.env.GUILD_ID) return;
    const g = client.guilds.cache.get(process.env.GUILD_ID);
    if (!g) return;
    try {
      await logSystem(g, '🔌 Бот отключился от Discord', `Код: ${event ? event.code : '—'}. Пытается переподключиться автоматически.`);
    } catch (_) {}
  });

  client.on('shardReconnecting', async () => {
    console.warn('Бот переподключается к Discord...');
    if (!process.env.GUILD_ID) return;
    const g = client.guilds.cache.get(process.env.GUILD_ID);
    if (!g) return;
    try {
      await logSystem(g, '🔄 Переподключение к Discord', 'Соединение прервалось, бот пытается восстановить связь.');
    } catch (_) {}
  });

  client.on('shardResume', async () => {
    console.log('Соединение с Discord восстановлено.');
    if (!process.env.GUILD_ID) return;
    try {
      const g = await client.guilds.fetch(process.env.GUILD_ID);
      await logSystem(g, '✅ Соединение с Discord восстановлено', `${client.user.tag} снова в сети.`);
    } catch (err) {
      console.error('Не удалось залогировать восстановление соединения:', err.message);
    }
  });

  client.on('error', async (err) => {
    console.error('Ошибка клиента Discord:', err);
    if (!process.env.GUILD_ID) return;
    const g = client.guilds.cache.get(process.env.GUILD_ID);
    if (!g) return;
    try {
      await logSystem(g, '❌ Ошибка соединения с Discord', err.message);
    } catch (_) {}
  });

  // Остановка процесса (перезапуск/выключение контейнера на Bothost и т.п.)
  // — пока соединение ещё живо, успеваем уведомить перед выходом.
  const handleShutdownSignal = (signalName) => async () => {
    console.log(`Получен сигнал ${signalName} — бот приостанавливается.`);
    if (process.env.GUILD_ID) {
      const g = client.guilds.cache.get(process.env.GUILD_ID);
      if (g) {
        try {
          await logSystem(g, '⏸️ Бот приостановлен/выключается', `Сигнал: ${signalName}. ${client.user.tag} уходит из сети.`);
        } catch (_) {}
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', handleShutdownSignal('SIGINT'));

  backup.scheduleDailyBackup(
    async (text) => {
      console.error('Ошибка бэкапа:', text);
      try {
        if (!process.env.GUILD_ID) return;
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        await logSystem(guild, '⚠️ Сбой резервного копирования БД', text);
      } catch (err) {
        console.error('Не удалось отправить уведомление о сбое бэкапа в аудит:', err.message);
      }
    },
    async (filePath) => {
      await uploadBackupFile(filePath, 'ежедневный автоматический');
    },
  );

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
        if (await isFeatureEnabled('reminders')) {
          await checkVacationReminders(guild);
          await checkHrReminder(guild);
        }
        await checkDiskSpace(guild);
        await checkStuckContracts(guild);
        await runWeeklyRankAdjustment(guild);
        await checkRecurringGiveaways(guild);
        await sendDailyDigest(guild);
        await sendWeeklyDigest(guild);
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
