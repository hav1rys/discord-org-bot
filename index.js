require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
let _backupTimeCache = null; // "HH:MM" МСК из настроек сайта; обновляется в часовом цикле
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
const mediaCache = require('./media_cache');
const { DEFAULT_RULES, DEFAULT_AGITATION, DEFAULT_HR_INFO } = require('./content');
const contentVersions = require('./content_versions');
const backup = require('./backup');
const faq = require('./faq');
const faqDisplay = require('./faq_display');
const contracts = require('./contracts');
const contractsDisplay = require('./contracts_display');
const invitations = require('./invitations');
const history = require('./history');
const { buildCsv, parseCsvObjects } = require('./csv');
const giveaways = require('./giveaways');
const configStore = require('./config_store');
const commandPermSync = require('./command_permissions_sync');
const invitationsDisplay = require('./invitations_display');
const acceptances = require('./acceptances');
const applicationsDisplay = require('./applications_display');
const badges = require('./badges');
const { notify, isMuted } = require('./notify');
const web = require('./web');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    ...(config.ENABLE_PRESENCE ? [GatewayIntentBits.GuildPresences] : []),
  ],
  partials: [Partials.Channel, Partials.GuildMember],
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

// Очереди на рассмотрение — общий реестр для кнопки «Беру на рассмотрение»
// и часового SLA-напоминания. Ключ (type) кодируется в customId кнопок.
const REVIEW_TABLES = {
  application: 'applications',
  kick: 'kicks',
  vacation: 'vacations',
  hr: 'hr_applications',
  data_change: 'data_change_requests',
  passport: 'passport_requests',
};
const REVIEW_CHANNELS = {
  application: config.CHANNEL_APPLY_REVIEW,
  kick: config.CHANNEL_KICK_REVIEW,
  vacation: config.CHANNEL_VACATION_REVIEW,
  hr: config.CHANNEL_HR_APPLY_REVIEW,
  data_change: config.CHANNEL_DATA_CHANGE_REVIEW,
  passport: config.CHANNEL_APPLY_REVIEW,
};

const TICKET_CAT_LABEL = { question: 'Вопрос', complaint: 'Жалоба', other: 'Другое', appeal: 'Апелляция ЧС', bug: 'Баг на сайте', bug_discord: 'Баг Discord' };

// Кнопки в шапке тикета: взять на себя / освободить + закрыть.
function ticketButtonsRow(ticketId, assignedTo) {
  return new ActionRowBuilder().addComponents(
    assignedTo
      ? new ButtonBuilder().setCustomId(`ticket_unclaim:${ticketId}`).setLabel('↩️ Освободить').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId(`ticket_claim:${ticketId}`).setLabel('🙋 Беру').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_close:${ticketId}`).setLabel('🔒 Закрыть тикет').setStyle(ButtonStyle.Danger),
  );
}
const appealMentionRoles = () => config.ROLES_BLACKLIST_ALLOWED.map((r) => `<@&${r}>`).join(' ');
const appealMentionOpts = { allowedMentions: { roles: config.ROLES_BLACKLIST_ALLOWED } };

// Второй ряд кнопок карточки рассмотрения: взять заявку в работу / освободить.
function claimButtonRow(type, r) {
  const btn = r && r.assigned_to
    ? new ButtonBuilder().setCustomId(`review_unclaim:${type}:${r.id}`).setLabel('↩️ Освободить').setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder().setCustomId(`review_claim:${type}:${r.id}`).setLabel('🙋 Беру на рассмотрение').setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder().addComponents(btn);
}

// Справочные таблицы для /помощь и /права_команд — держать в актуальном
// состоянии вручную при добавлении новых команд.
const COMMAND_CATEGORIES = [
  {
    title: '👤 Участники и паспорта',
    commands: ['история', 'кто_это', 'паспорт_история', 'ник_история', 'профиль_экспорт', 'отпуска_календарь', 'список_afk', 'отпуск_статистика', 'повышения_история', 'команды_человека'],
  },
  {
    title: '📄 Контракты и приглашения',
    commands: ['топ_контракты', 'топ_приглашения'],
  },
  {
    title: '🎉 Розыгрыши',
    commands: ['розыгрыш_старт', 'розыгрыш_завершить', 'розыгрыш_отменить', 'розыгрыш_реролл', 'розыгрыш_участники', 'розыгрыш_участники_экспорт', 'розыгрыш_история', 'розыгрыш_добавить_участника', 'розыгрыш_удалить_участника', 'розыгрыш_повтор_создать', 'розыгрыш_повтор_список', 'розыгрыш_повтор_отменить', 'розыгрыш_повтор_возобновить', 'розыгрыш_чс_добавить', 'розыгрыш_чс_убрать', 'розыгрыш_чс_список'],
  },
  {
    title: '📢 Тексты и рассылки',
    commands: ['правила', 'правила_обновить', 'правила_разослать', 'агитация', 'агитация_обновить', 'hr_вакансия', 'hr_вакансия_обновить', 'рассылка_сообщение', 'каналы_отчётов', 'предпросмотр'],
  },
  {
    title: '⚙️ Управление организацией',
    commands: ['меню_создать', 'профили_восстановить', 'импорт_участники', 'тикеты', 'чс_апелляция'],
  },
  {
    title: '🛠️ Настройки бота',
    commands: ['настройка_изменить', 'настройка_показать', 'настройка_переключить', 'причины_отказа', 'discord_права_настроить', 'discord_права_синхронизировать', 'discord_права_статус'],
  },
  {
    title: '💾 Резервные копии',
    commands: ['бэкап_сейчас', 'бэкапы_список', 'резерв_восстановить', 'резерв_загрузить'],
  },
  {
    title: '🩺 Диагностика и отчётность',
    commands: ['пинг', 'статус', 'статистика_организации', 'статистика_hr', 'воронка_найма', 'выплаты_hr', 'экспорт_id', 'экспорт_статистика', 'сравнить_недели', 'заявки_скорость', 'аудит_поиск', 'аудит_экспорт', 'сверка_ролей', 'экспорт_бд', 'поиск_везде', 'кэш_статистика', 'статус_бд', 'ранги_пересчитать_сейчас'],
  },
  {
    title: '❔ Справка',
    commands: ['faq', 'faq_отзывы', 'помощь', 'права_команд', 'журнал_прав'],
  },
];

// Уровни доступа — ключ (короткий, для хранения в БД) + подпись + функция
// проверки. /права_команд позволяет менять привязку команда→ключ через
// выпадающий список, без единой правки кода.
const TIER_INFO = {
  everyone: { label: 'Все участники сервера', check: () => true },
  admin: { label: 'Только роль `+`, `.` (Admin)', check: (m) => perms.hasBotAccess(m) },
  owner: { label: 'Владелец и выше', check: (m) => perms.isOwnerTier(m) },
  deputy: { label: 'Зам. Владелец и выше', check: (m) => perms.isDeputyTier(m) },
  hr: { label: 'HR-Менеджер и выше', check: (m) => perms.isHrTier(m) },
  owner_account_only: { label: `🔒 Только аккаунт <@${config.OWNER_USER_ID}> (без обхода через роли)`, check: (m) => m.id === config.OWNER_USER_ID },
};

// Уровень по умолчанию для каждой команды (используется, пока никто не
// поменял его через /права_команд)
const COMMAND_DEFAULT_TIERS = {
  // --- Все участники сервера ---
  faq: 'everyone',
  сайт: 'everyone',

  // --- Только роль `+`, `.` (Admin) ---
  настройка_изменить: 'admin', настройка_показать: 'admin', настройка_переключить: 'admin',
  бэкап_сейчас: 'admin', бэкапы_список: 'admin', экспорт_id: 'admin', права_команд: 'admin',
  меню_создать: 'admin', профили_восстановить: 'admin', журнал_прав: 'admin', команды_человека: 'admin',
  предпросмотр: 'admin', розыгрыш_чс_добавить: 'admin', розыгрыш_чс_убрать: 'admin', розыгрыш_чс_список: 'admin',
  экспорт_бд: 'admin', резерв_восстановить: 'admin', резерв_загрузить: 'admin', импорт_участники: 'admin',

  // --- Владелец и выше ---
  розыгрыш_старт: 'owner', розыгрыш_завершить: 'owner', розыгрыш_отменить: 'owner', розыгрыш_реролл: 'owner',
  розыгрыш_участники: 'owner', розыгрыш_добавить_участника: 'owner', розыгрыш_повтор_создать: 'owner',
  розыгрыш_повтор_список: 'owner', розыгрыш_повтор_отменить: 'owner', розыгрыш_повтор_возобновить: 'owner',
  розыгрыш_удалить_участника: 'owner', розыгрыш_история: 'owner',
  правила: 'owner', правила_обновить: 'owner', правила_разослать: 'owner', агитация: 'owner', агитация_обновить: 'owner',
  hr_вакансия: 'owner', hr_вакансия_обновить: 'owner', рассылка_сообщение: 'owner', каналы_отчётов: 'owner',
  статус: 'owner', пинг: 'owner', статистика_организации: 'owner', заявки_скорость: 'owner', причины_отказа: 'owner',
  faq_отзывы: 'owner', сравнить_недели: 'owner', выплаты_hr: 'owner', воронка_найма: 'owner', статистика_hr: 'owner',
  кэш_статистика: 'owner', статус_бд: 'owner', розыгрыш_участники_экспорт: 'owner', чс_апелляция: 'owner',

  // --- Зам. Владелец и выше ---
  экспорт_статистика: 'deputy', аудит_экспорт: 'deputy',

  // --- HR-Менеджер и выше ---
  топ_приглашения: 'hr', паспорт_история: 'hr', отпуска_календарь: 'hr', список_afk: 'hr', топ_контракты: 'hr',
  аудит_поиск: 'hr', кто_это: 'hr', история: 'hr', помощь: 'hr', сверка_ролей: 'hr', поиск_везде: 'hr',
  отпуск_статистика: 'hr', повышения_история: 'hr', ник_история: 'hr', профиль_экспорт: 'hr',
  ранги_пересчитать_сейчас: 'hr', тикеты: 'hr',

  // --- Только аккаунт владельца (без обхода через роли) ---
  discord_права_настроить: 'owner_account_only', discord_права_синхронизировать: 'owner_account_only', discord_права_статус: 'owner_account_only',
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

// Переводит уровень команды (tier) в списки role_id/user_id, которым нужно
// разрешить видимость в самом Discord — используется только для
// синхронизации с нативной системой прав Discord (см. /discord_права_*).
// Уровни "и выше" разворачиваются в конкретные роли (owner → ещё и все
// роли выше по иерархии не нужны, у нас "и выше" уже означает "этот и
// более privileged" — Владелец/Зам./HR тут не вложены друг в друга по
// ролям Discord, поэтому перечисляем явно под каждый уровень).
function resolveTierToDiscordPermissions(tier) {
  if (tier === 'owner_account_only') {
    return { roleIds: [], userIds: [config.OWNER_USER_ID].filter(Boolean) };
  }
  if (tier === 'everyone') {
    // '@everyone' — маркер, вызывающая сторона подменит его на guild.id (это и есть id роли @everyone)
    return { roleIds: ['@everyone'], userIds: [] };
  }

  const roleIds = new Set([config.ROLE_PLUS, config.ROLE_ADMIN]);
  const userIds = new Set([config.OWNER_USER_ID]);

  if (isSnowflake(tier)) {
    userIds.add(tier);
    return { roleIds: [...roleIds].filter(Boolean), userIds: [...userIds].filter(Boolean) };
  }

  if (tier === 'owner' || tier === 'deputy' || tier === 'hr') roleIds.add(config.ROLE_OWNER);
  if (tier === 'deputy' || tier === 'hr') roleIds.add(config.ROLE_DEPUTY);
  if (tier === 'hr') roleIds.add(config.ROLE_HR);

  return { roleIds: [...roleIds].filter(Boolean), userIds: [...userIds].filter(Boolean) };
}

// Синхронизирует видимость ОДНОЙ команды в Discord под её текущий
// (возможно, только что изменённый) уровень доступа. Тихо ничего не
// делает, если OAuth ещё не настроен — /права_команд продолжает работать
// как обычно (проверка внутри бота), просто без нативного скрытия.
async function syncOneCommandPermissions(guild, commandName) {
  if (!(await commandPermSync.isAuthorized())) return;
  try {
    const discordCommands = await guild.commands.fetch();
    const discordCommand = discordCommands.find((c) => c.name === commandName);
    if (!discordCommand) return;
    const tier = await getCommandTier(commandName);
    const { roleIds, userIds } = resolveTierToDiscordPermissions(tier);
    const finalRoleIds = roleIds.map((r) => (r === '@everyone' ? guild.id : r));
    await commandPermSync.setCommandPermissions(guild.id, client.application.id, discordCommand.id, finalRoleIds, userIds);
    await db.setSetting('command_perm_last_sync', new Date().toISOString());
  } catch (err) {
    console.error(`Не удалось синхронизировать видимость команды /${commandName} с Discord:`, err.message);
  }
}

// Полная пересинхронизация всех команд разом — для первой настройки и
// команды /discord_права_синхронизировать.
async function syncAllCommandPermissions(guild) {
  const discordCommands = await guild.commands.fetch();
  const result = { ok: 0, failed: [] };
  const names = Object.keys(COMMAND_DEFAULT_TIERS);
  for (let i = 0; i < names.length; i++) {
    const commandName = names[i];
    const discordCommand = discordCommands.find((c) => c.name === commandName);
    if (!discordCommand) continue;
    const tier = await getCommandTier(commandName);
    const { roleIds, userIds } = resolveTierToDiscordPermissions(tier);
    const finalRoleIds = roleIds.map((r) => (r === '@everyone' ? guild.id : r));
    try {
      await commandPermSync.setCommandPermissions(guild.id, client.application.id, discordCommand.id, finalRoleIds, userIds);
      result.ok++;
    } catch (err) {
      result.failed.push(`/${commandName}: ${err.message}`);
    }
    if (i < names.length - 1) await new Promise((resolve) => setTimeout(resolve, 1200)); // упреждающая пауза — этот эндпоинт лимитирует строго
  }
  return result;
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

  // Смена ника на сервере (ручные правки людей, не авто-синхронизация бота)
  const nickRows = await db.all('SELECT * FROM nickname_history WHERE discord_id = ? ORDER BY id DESC LIMIT 10', [discordId]);
  if (nickRows.length > 0) {
    const lines = nickRows.map((n) => {
      const who = n.changed_by && n.changed_by !== 'unknown' ? `<@${n.changed_by}>` : 'кто-то';
      return `«${n.old_nick || '—'}» → «${n.new_nick || '—'}» — ${who}, ${formatDateOnly(new Date(n.at))}`;
    });
    mainEmbed.addFields({ name: 'Смена ника (сервер)', value: lines.join('\n').slice(0, 1024) });
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
// Раз в сутки: у кого 5+ непрочитанных уведомлений висят дольше суток —
// мягкий пинок в ЛС со ссылкой на сайт (уважает mute-настройку колокольчика).
async function sendUnreadNudges(guild) {
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const rows = await db.all(
    "SELECT discord_id, COUNT(*) c FROM notifications WHERE read_at IS NULL AND created_at <= ? AND (snooze_until IS NULL OR snooze_until <= ?) GROUP BY discord_id HAVING c >= 5",
    [dayAgo, new Date().toISOString()],
  ).catch(() => []);
  for (const r of rows) {
    if (String(r.discord_id).startsWith('local:') || String(r.discord_id).startsWith('nodiscord-')) continue;
    if (await isMuted(r.discord_id, 'unread_digest')) continue;
    await dmUser(guild, r.discord_id, `🔔 У вас ${r.c} непрочитанных уведомлений на сайте организации — загляните в раздел «Уведомления».`).catch(() => {});
  }
}

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

// В 23:59 МСК — список подтверждённых за день кодовых слов уходит Владельцу
// в ЛС для возврата денег (Имя Фамилия, № Паспорта | N слов | сумма).
async function sendCodewordRefundList(guild) {
  const approved = await db.all("SELECT * FROM codeword_submissions WHERE status = 'approved' AND (counted IS NULL OR counted = 0)");
  if (approved.length === 0) return;

  const perPerson = new Map();
  for (const s of approved) {
    if (!perPerson.has(s.discord_id)) perPerson.set(s.discord_id, { name: s.name, static: s.static, tag: s.discord_tag, count: 0 });
    perPerson.get(s.discord_id).count += 1;
  }

  const amount = config.CODEWORD_REFUND_AMOUNT;
  let total = 0;
  const lines = [];
  for (const [discordId, p] of perPerson) {
    const sum = p.count * amount;
    total += sum;
    const who = p.name ? `${p.name}, № ${p.static}` : (p.tag || discordId);
    lines.push(`${who} | ${p.count} кодовых слов | ${formatMoney(sum)}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`📰 Возврат за кодовые слова — ${formatDateOnly(new Date())}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: `Итого к возврату: ${formatMoney(total)}` });
  await dmUser(guild, config.OWNER_USER_ID, { embeds: [embed] });

  for (const s of approved) {
    await db.run('UPDATE codeword_submissions SET counted = 1 WHERE id = ?', [s.id]);
  }
  console.log(`Список возврата за кодовые слова отправлен Владельцу: ${perPerson.size} чел., ${formatMoney(total)}.`);
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
async function runWeeklyRankAdjustment(guild, force = false) {
  const now = new Date();
  const isTargetDay = dates.mskWeekday(now) === config.WEEKLY_RANK_ADJUSTMENT_DAY;
  const todayStr = dates.mskDateStr(now);
  const lastRun = await db.getSetting('weekly_rank_adjustment_last_run');
  if (!force && (!isTargetDay || lastRun === todayStr)) return 0;

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

    await logAudit(
      guild,
      client.user,
      '⬇️ Еженедельное авто-понижение',
      [
        { name: 'Запуск', value: force ? 'Вручную (/ранги_пересчитать_сейчас)' : 'По расписанию', inline: true },
        { name: 'Понижено', value: String(demotions.length), inline: true },
        { name: 'Кто понижен', value: demotions.map((p) => `${p.name} (№ ${p.static}) — <@${p.discord_id}>`).join('\n').slice(0, 1024), inline: false },
      ],
    );
  }

  await db.setSetting('weekly_rank_adjustment_last_run', todayStr);
  return demotions.length;
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

  // Ведомость выплат за принятых, кто пробыл 3+ дня (за последние 7 дней)
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { rows: payoutRows, total: payoutTotal } = await computeHrPayouts(guild, since);
    if (payoutRows.length > 0) {
      const lines = payoutRows.map((r) => {
        const who = r.name ? `${r.name}, № ${r.static}` : `<@${r.staffId}>`;
        return `${who} | принятых: ${r.count} | ${formatMoney(r.sum)}`;
      });
      embed.addFields({ name: `💰 К выплате за неделю (итого ${formatMoney(payoutTotal)})`, value: lines.join('\n').slice(0, 1024) });
    }
  } catch (err) {
    console.error('Не удалось посчитать выплаты HR для недельной сводки:', err.message);
  }

  await dmUser(guild, config.OWNER_USER_ID, { embeds: [embed] });
  await db.setSetting('weekly_digest_last_sent', new Date().toISOString());
}

// Личный еженедельный отчёт каждому участнику в ЛС: контракты, приглашения,
// стрик за прошлую полную неделю. Один раз в неделю (метка last_weekly_digest).
async function sendPersonalWeeklyDigests(guild) {
  const lastSent = await db.getSetting('personal_digest_last_sent');
  if (lastSent && Date.now() - new Date(lastSent).getTime() < 6.5 * 24 * 60 * 60 * 1000) return;
  const range = contracts.getWeekRange(1); // прошлая полная неделя
  const weekTag = range.start.toISOString().slice(0, 10);
  const label = contracts.formatWeekLabel(range);
  const parts = await db.all('SELECT discord_id, name, last_weekly_digest FROM participants').catch(() => []);
  let sent = 0;
  for (const p of parts) {
    if (p.last_weekly_digest === weekTag) continue;
    if (await isMuted(p.discord_id, 'weekly_digest')) continue; // участник отключил отчёт
    try {
      const w = await contracts.getUserWeekStats(p.discord_id, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
      const inv = await db.get(
        "SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed' AND joined_at BETWEEN ? AND ?",
        [p.discord_id, range.start.toISOString(), range.end.toISOString()],
      ).catch(() => null);
      let streak = 0;
      try { streak = (await badges.compute(p.discord_id)).streak || 0; } catch (_) {}
      const f = w.fulfilled.length; const uf = w.unfulfilled.length;
      await dmUser(guild, p.discord_id,
        `📊 Ваш отчёт за ${label}\n`
        + `Контракты: ✅ ${f} / ❌ ${uf}\n`
        + `Подтверждённых приглашений: ${inv ? inv.c : 0}\n`
        + `Недельный стрик: ${streak} ${streak === 1 ? 'неделя' : 'нед.'}${streak >= 2 ? ' 🔥' : ''}\n`
        + `${f === 0 && uf === 0 ? 'На прошлой неделе контрактов не было — самое время начать!' : 'Так держать!'}`);
      await db.run('UPDATE participants SET last_weekly_digest = ? WHERE discord_id = ?', [weekTag, p.discord_id]).catch(() => {});
      sent++;
      await new Promise((r) => setTimeout(r, 600));
    } catch (_) { /* участник закрыл ЛС и т.п. */ }
  }
  await db.setSetting('personal_digest_last_sent', new Date().toISOString());
  if (sent) console.log(`Личный еженедельный отчёт отправлен ${sent} участникам.`);
}

async function checkStuckContracts(guild) {
  const cutoff = new Date(Date.now() - config.STUCK_CONTRACT_HOURS * 60 * 60 * 1000).toISOString();

  // «Взял, но не сдал итог» дольше нормы — напоминаем самому участнику (один раз).
  const takenStuck = await db.all(
    "SELECT id, discord_id, taken_submitted_at FROM contracts WHERE status = 'taken' AND taken_submitted_at <= ? AND stuck_reminder_sent = 0",
    [cutoff],
  ).catch(() => []);
  for (const t of takenStuck) {
    const hrs = Math.floor((Date.now() - new Date(t.taken_submitted_at)) / 36e5);
    await dmUser(guild, t.discord_id, `⏰ Ваш взятый контракт #${t.id} висит ${hrs} ч — не забудьте сдать итог на сайте («Контракты в работе») или в канале-профиле.`).catch(() => {});
    await notify(t.discord_id, 'contract', `Взятый контракт #${t.id} висит ${hrs} ч — сдайте итог`, '/me').catch(() => {});
    await db.run('UPDATE contracts SET stuck_reminder_sent = 1 WHERE id = ?', [t.id]).catch(() => {});
  }

  // «Взял», но так и не сдал итог 7+ дней — помечаем abandoned (не считается).
  const abandonCutoff = new Date(Date.now() - 7 * 864e5).toISOString();
  const abandoned = await db.all("SELECT id, discord_id FROM contracts WHERE status = 'taken' AND taken_submitted_at <= ?", [abandonCutoff]).catch(() => []);
  for (const a of abandoned) {
    await db.run("UPDATE contracts SET status = 'abandoned' WHERE id = ?", [a.id]).catch(() => {});
    await notify(a.discord_id, 'contract', `Взятый контракт #${a.id} снят автоматически — итог не сдан 7 дней`, '/me').catch(() => {});
  }

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

// Тикеты без активности 4+ дней — предупреждаем; 5+ дней — авто-закрываем.
async function checkSilentTickets(guild) {
  const now = Date.now();
  const open = await db.all("SELECT * FROM tickets WHERE status = 'open'").catch(() => []);
  for (const t of open) {
    const last = new Date(t.last_activity || t.created_at || now).getTime();
    const days = (now - last) / 864e5;
    try {
      const ch = await guild.channels.fetch(t.channel_id).catch(() => null);
      if (!ch) continue;
      if (days >= 5) {
        await ch.permissionOverwrites.edit(t.opener_id, { ViewChannel: false, SendMessages: false }).catch(() => {});
        await ch.setParent(config.CHANNEL_TICKETS_ARCHIVE_CATEGORY, { lockPermissions: false }).catch(() => {});
        if (!ch.name.startsWith('закрыт-')) await ch.setName(`закрыт-${ch.name}`.slice(0, 100)).catch(() => {});
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription('🔒 Тикет закрыт автоматически — 5 дней без ответа.')] }).catch(() => {});
        await db.run("UPDATE tickets SET status = 'archived', closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ?",
          [new Date().toISOString(), client.user.id, 'авто: 5 дней тишины', t.id]);
        await dmUser(guild, t.opener_id, {
          content: `Ваш тикет «${t.subject || '—'}» закрыт автоматически (5 дней без ответа). Помогло ли обращение?`,
          components: [row(
            new ButtonBuilder().setCustomId(`ticket_rate:${t.id}:1`).setLabel('👍 Помогло').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`ticket_rate:${t.id}:0`).setLabel('👎 Не помогло').setStyle(ButtonStyle.Secondary),
          )],
        }).catch(() => {});
      } else if (days >= 4 && !t.autoclose_warned) {
        await ch.send({ content: `<@${t.opener_id}>`, embeds: [new EmbedBuilder().setColor(0xfee75c).setDescription('⏳ По этому тикету 4 дня нет ответа. Если вопрос ещё актуален — напишите здесь, иначе тикет закроется автоматически через сутки.')] }).catch(() => {});
        await db.run('UPDATE tickets SET autoclose_warned = 1 WHERE id = ?', [t.id]).catch(() => {});
      }
    } catch (e) { console.error('checkSilentTickets:', e.message); }
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

// Раз в час — если заявка в любой из 6 очередей висит без решения дольше
// REVIEW_SLA_HOURS, один раз пингуем руководство в канале этой очереди.
// Флаг sla_reminder_sent не даёт слать повторно по той же заявке.
async function checkReviewSla(guild) {
  const cutoff = new Date(Date.now() - config.REVIEW_SLA_HOURS * 60 * 60 * 1000).toISOString();
  for (const [type, table] of Object.entries(REVIEW_TABLES)) {
    const rows = await db.all(
      `SELECT * FROM ${table} WHERE status = 'pending' AND created_at <= ? AND (sla_reminder_sent IS NULL OR sla_reminder_sent = 0) ORDER BY id`,
      [cutoff],
    );
    if (rows.length === 0) continue;
    try {
      const channel = await guild.channels.fetch(REVIEW_CHANNELS[type]);
      const lines = rows.map((r) => `#${r.id} — с ${formatDateTime(new Date(r.created_at))}${r.assigned_to ? ` (у <@${r.assigned_to}>)` : ' — никто не взял'}`);
      await channel.send({
        content: perms.mentionManagementRoles(),
        embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`⏰ Заявки висят дольше ${config.REVIEW_SLA_HOURS} ч`).setDescription(lines.join('\n').slice(0, 4000))],
        ...mentionOpts,
      });
      for (const r of rows) {
        await db.run(`UPDATE ${table} SET sla_reminder_sent = 1 WHERE id = ?`, [r.id]);
      }
    } catch (err) {
      console.error(`SLA-напоминание (${type}):`, err.message);
    }
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
    await notify(c.discord_id, 'vacation', `Отпуск заканчивается ${formatDateTime(new Date(c.vacation_until))}`, '/me');
    await db.run(
      'INSERT INTO vacation_reminders_sent (discord_id, static, until, sent_at) VALUES (?, ?, ?, ?)',
      [c.discord_id, c.static, c.vacation_until, new Date().toISOString()],
    );
  }
}

// Раз в час: поздравляет участников с годовщиной вступления (ровно N полных
// лет сегодня), одно поздравление за год — флаг participants.last_anniv_year.
async function checkAnniversaries(guild) {
  const now = new Date();
  const rows = await db.all('SELECT discord_id, name, joined_at, last_anniv_year FROM participants WHERE joined_at IS NOT NULL').catch(() => []);
  for (const p of rows) {
    const j = new Date(p.joined_at);
    if (Number.isNaN(j.getTime())) continue;
    let years = now.getFullYear() - j.getFullYear();
    const passed = (now.getMonth() > j.getMonth()) || (now.getMonth() === j.getMonth() && now.getDate() >= j.getDate());
    if (!passed) years -= 1;
    if (years < 1) continue;
    if (now.getMonth() !== j.getMonth() || now.getDate() !== j.getDate()) continue; // годовщина именно сегодня
    if ((p.last_anniv_year || 0) >= years) continue;
    await db.run('UPDATE participants SET last_anniv_year = ? WHERE discord_id = ?', [years, p.discord_id]).catch(() => {});
    await dmUser(guild, p.discord_id, `🎂 Поздравляем! Сегодня ${years === 1 ? 'год' : years + ' года/лет'} с момента вступления в организацию «${config.SITE_BRAND}». Спасибо, что с нами!`).catch(() => {});
    await notify(p.discord_id, 'info', `🎂 ${years} ${years === 1 ? 'год' : 'года/лет'} в организации — поздравляем!`, '/me').catch(() => {});
  }
}

// Раз в час — автоматически снимает отпуска, у которых истёк срок
// (vacation_until <= сейчас): чистит поле у паспорта, логирует снятие,
// синхронизирует статусные роли, обновляет список и шлёт ЛС. Не гейтится
// переключателем «Напоминания» — это действие, а не напоминание.
async function checkExpiredVacations(guild) {
  const nowIso = new Date().toISOString();
  const participants = await db.all(
    'SELECT discord_id, static, name, vacation_until FROM participants WHERE vacation_until IS NOT NULL AND vacation_until <= ?',
    [nowIso],
  );
  const extras = await db.all(
    'SELECT discord_id, static, name, vacation_until FROM extra_passports WHERE vacation_until IS NOT NULL AND vacation_until <= ?',
    [nowIso],
  );
  const expired = [...participants, ...extras];
  if (expired.length === 0) return;

  const affected = new Set();
  for (const p of expired) {
    await passportsLib.updatePassportFields(p.discord_id, p.static, { vacation_until: null });
    await history.logStatusRevoked('vacation', p.discord_id, p.static, p.name, client.user.id);
    affected.add(p.discord_id);
  }

  for (const discordId of affected) {
    await syncStatusRoles(guild, discordId);
  }
  await safeUpdateMembersList(guild);

  for (const p of expired) {
    await dmUser(guild, p.discord_id, `🏖️ Ваш отпуск (${p.name}, № ${p.static}) закончился — статус снят автоматически. С возвращением!`);
  }

  await logAudit(guild, client.user, '🏖️ Отпуск(а) сняты автоматически (истёк срок)', [
    { name: 'Снято паспортов', value: String(expired.length), inline: true },
    { name: 'Кому', value: expired.map((p) => `${p.name} (№ ${p.static}) — <@${p.discord_id}>`).join('\n').slice(0, 1024), inline: false },
  ]);
}

// Раз в час — снимает записи временного ЧС, у которых истёк срок (until <= сейчас).
async function checkExpiredBlacklist(guild) {
  const nowIso = new Date().toISOString();
  const rows = await db.all('SELECT * FROM blacklist WHERE until IS NOT NULL AND until <= ?', [nowIso]);
  if (rows.length === 0) return;
  for (const r of rows) {
    await db.run('DELETE FROM blacklist WHERE id = ?', [r.id]);
  }
  await safeUpdateBlacklist(guild);
  await logAudit(guild, client.user, '🤡 Временный ЧС снят автоматически (истёк срок)', [
    { name: 'Снято записей', value: String(rows.length), inline: true },
    {
      name: 'Кого',
      value: rows.map((r) => `${r.discord_id.startsWith('nodiscord-') ? r.discord_tag : `<@${r.discord_id}>`} — № ${r.static || '—'} (${r.reason || 'без причины'})`).join('\n').slice(0, 1024),
      inline: false,
    },
  ]);
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

  // Общая роль организации — есть у любого действующего участника (у кого
  // есть хоть один паспорт). Выдаётся здесь, потому что эта функция
  // вызывается на всех путях вступления/добавления/повышения.
  if (config.ROLE_ORGANIZATION) {
    try {
      const member = await guild.members.fetch(discordId);
      await member.roles.add(config.ROLE_ORGANIZATION);
    } catch (err) {
      console.error(`Не удалось выдать роль организации для ${discordId}:`, err.message);
    }
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
  try { web.invalidateAccess(discordId); } catch (_) {}
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
  ), claimButtonRow('data_change', reqRow)];
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
  ), claimButtonRow('hr', reqRow)];
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
  ), claimButtonRow('passport', reqRow)];
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

function buildBlacklistAddModal(prefillReason = '') {
  const modal = new ModalBuilder().setCustomId('modal_blacklist_add').setTitle('Внести в чёрный список');
  modal.addComponents(
    row(txt(null, 'discord_id', 'Discord ID')),
    row(txt(null, 'static', '№ Паспорта', { required: false })),
    row(txt(null, 'reason', 'Причина', { required: false, paragraph: true, value: prefillReason, maxLength: 1000 })),
    row(txt(null, 'until', 'Срок (пусто = навсегда; 7d или ДД.ММ.ГГГГ)', { required: false })),
  );
  return modal;
}

function buildBlacklistAddNoDiscordModal(prefillReason = '') {
  const modal = new ModalBuilder().setCustomId('modal_blacklist_add_nodiscord').setTitle('Внести в ЧС (без Discord)');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { required: false })),
    row(txt(null, 'static', '№ Паспорта')),
    row(txt(null, 'reason', 'Причина', { required: false, paragraph: true, value: prefillReason, maxLength: 1000 })),
    row(txt(null, 'until', 'Срок (пусто = навсегда; 7d или ДД.ММ.ГГГГ)', { required: false })),
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
    .setDescription('Топ по контрактам — за всё время или за конкретную неделю')
    .addIntegerOption((opt) => opt.setName('недель_назад').setDescription('Если задано: топ за эту неделю (0 = текущая, 1 = прошлая…)').setRequired(false).setMinValue(0)),
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
    .setDescription('Выгрузить статистику за период (контракты/приглашения/заявки) в .csv')
    .addIntegerOption((opt) => opt.setName('недель_назад').setDescription('0 = текущая неделя, 1 = прошлая и т.д. (игнорируется, если задано «дней»)').setRequired(false).setMinValue(0))
    .addIntegerOption((opt) => opt.setName('дней').setDescription('Скользящее окно: последние N дней от текущего момента').setRequired(false).setMinValue(1)),
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
    .setName('розыгрыш_история')
    .setDescription('Кто что выигрывал в розыгрышах за период')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 30)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('розыгрыш_повтор_отменить')
    .setDescription('Остановить повторяющийся розыгрыш')
    .addStringOption((opt) => opt.setName('правило').setDescription('Какое правило остановить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_повтор_возобновить')
    .setDescription('Возобновить ранее остановленный повторяющийся розыгрыш')
    .addStringOption((opt) => opt.setName('правило').setDescription('Какое правило возобновить').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_удалить_участника')
    .setDescription('Удалить человека из розыгрыша')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш').setRequired(true).setAutocomplete(true))
    .addUserOption((opt) => opt.setName('человек').setDescription('Кого удалить').setRequired(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_чс_добавить')
    .setDescription('Добавить человека в ЧС розыгрышей (не сможет участвовать ни в одном)')
    .addUserOption((opt) => opt.setName('человек').setDescription('Кого добавить').setRequired(true))
    .addStringOption((opt) => opt.setName('причина').setDescription('Причина').setRequired(false)),
  new SlashCommandBuilder()
    .setName('розыгрыш_чс_убрать')
    .setDescription('Убрать человека из ЧС розыгрышей')
    .addUserOption((opt) => opt.setName('человек').setDescription('Кого убрать').setRequired(true)),
  new SlashCommandBuilder()
    .setName('розыгрыш_чс_список')
    .setDescription('Список ЧС розыгрышей'),
  new SlashCommandBuilder()
    .setName('discord_права_настроить')
    .setDescription('Одноразовая настройка: чтобы недоступные команды пропадали из списка / у людей в Discord'),
  new SlashCommandBuilder()
    .setName('discord_права_синхронизировать')
    .setDescription('Заново применить видимость всех команд в Discord (после массовых изменений прав)'),
  new SlashCommandBuilder()
    .setName('discord_права_статус')
    .setDescription('Состояние синхронизации видимости команд с Discord'),
  new SlashCommandBuilder()
    .setName('кэш_статистика')
    .setDescription('Сколько места занимает локальный кэш скриншотов'),
  new SlashCommandBuilder()
    .setName('ранги_пересчитать_сейчас')
    .setDescription('Принудительно запустить еженедельную авто-корректировку рангов прямо сейчас'),
  new SlashCommandBuilder()
    .setName('статус_бд')
    .setDescription('Размер базы данных и количество записей в ключевых таблицах'),
  new SlashCommandBuilder()
    .setName('розыгрыш_участники_экспорт')
    .setDescription('Выгрузить список участников розыгрыша в .csv')
    .addStringOption((opt) => opt.setName('розыгрыш').setDescription('Какой розыгрыш').setRequired(true).setAutocomplete(true)),
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
    .setDescription('Топ по приглашениям — за всё время или за конкретную неделю')
    .addIntegerOption((opt) => opt.setName('недель_назад').setDescription('Если задано: топ за эту неделю (0 = текущая, 1 = прошлая…)').setRequired(false).setMinValue(0)),
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
    .setName('ник_история')
    .setDescription('История смены ника на сервере у человека')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('профиль_экспорт')
    .setDescription('Выгрузить всю информацию о человеке в .txt (история, контракты, отпуска, тикеты и т.д.)')
    .addStringOption((opt) => opt.setName('человек').setDescription('Имя Фамилия / № Паспорта / Discord тег или ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('заявки_скорость')
    .setDescription('Среднее время рассмотрения заявок на вступление по каждому HR')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 30)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('импорт_участники')
    .setDescription('Импорт участников из .csv (формат participants.csv из /экспорт_бд)')
    .addAttachmentOption((opt) => opt.setName('файл').setDescription('.csv, минимум колонки discord_id, name, static').setRequired(true)),
  new SlashCommandBuilder()
    .setName('тикеты')
    .setDescription('Список открытых тикетов поддержки'),
  new SlashCommandBuilder()
    .setName('чс_апелляция')
    .setDescription('Разрешить или запретить человеку подавать апелляцию на чёрный список')
    .addUserOption((opt) => opt.setName('человек').setDescription('Кого').setRequired(true))
    .addStringOption((opt) =>
      opt.setName('состояние').setDescription('Запретить или разрешить').setRequired(true).addChoices(
        { name: 'Запретить апелляции', value: 'off' },
        { name: 'Разрешить апелляции', value: 'on' },
      ),
    ),
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
    .setName('резерв_загрузить')
    .setDescription('⚠️ Заменить базу данных загруженным .db файлом (перезаписывает текущие данные)')
    .addAttachmentOption((opt) => opt.setName('файл').setDescription('.db файл базы данных').setRequired(true)),
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
  new SlashCommandBuilder()
    .setName('причины_отказа')
    .setDescription('Редактировать шаблоны причин отказа для заявок (вступление/увольнение/отпуск)'),
  new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Найти ответ в гайдах FAQ по ключевым словам')
    .addStringOption((opt) => opt.setName('запрос').setDescription('Что искать').setRequired(true)),
  new SlashCommandBuilder()
    .setName('faq_отзывы')
    .setDescription('Оценки «Помог ли ответ?» по гайдам FAQ — какие гайды стоит доработать'),
  new SlashCommandBuilder()
    .setName('сравнить_недели')
    .setDescription('Статистика двух недель бок о бок (контракты, приглашения, заявки, увольнения)')
    .addIntegerOption((opt) => opt.setName('неделя_а').setDescription('Сколько недель назад (0 = текущая)').setRequired(false).setMinValue(0))
    .addIntegerOption((opt) => opt.setName('неделя_б').setDescription('Сколько недель назад (по умолчанию 1 = прошлая)').setRequired(false).setMinValue(0)),
  new SlashCommandBuilder()
    .setName('выплаты_hr')
    .setDescription('Ведомость выплат за принятых, кто пробыл 3+ дня (25k HR / 10k не HR)')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 7)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('воронка_найма')
    .setDescription('Конверсия: заявок → принято → досидело 3 дня → всё ещё в организации')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 30)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('статистика_hr')
    .setDescription('Сводка по каждому HR: принято, удержано, проверено контрактов, закрыто тикетов')
    .addIntegerOption((opt) => opt.setName('дней').setDescription('За сколько последних дней (по умолчанию 30)').setRequired(false).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('сайт')
    .setDescription('Прислать в ЛС одноразовую ссылку для входа на сайт организации'),
  // Доступ ограничивается не через Discord-права, а проверкой роли/прав
  // в обработчике ниже — так гарантированно работает независимо от
  // настроек интеграций на сервере.
].map((c) => c.toJSON());

const BOT_TOKEN = process.env.API_TOKEN || process.env.DISCORD_TOKEN;

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;
  if (!clientId) {
    console.warn('CLIENT_ID не задан — слэш-команды не будут зарегистрированы.');
    return;
  }

  // Если синхронизация видимости команд с Discord настроена (см.
  // /discord_права_настроить) — прячем команды по умолчанию (видны только
  // тем, кому явно разрешено через per-command overwrite). Пока не
  // настроено — оставляем как раньше (видны всем), чтобы ничего не
  // сломать до завершения одноразовой настройки.
  const isPermSyncSetUp = await commandPermSync.isAuthorized().catch(() => false);
  const payload = isPermSyncSetUp ? commands.map((c) => ({ ...c, default_member_permissions: '0' })) : commands;

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
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: payload });
  }
}

async function sendFaqManagePanel(guild) {
  const channel = await guild.channels.fetch(config.CHANNEL_FAQ_MANAGE);
  if (!channel) return;

  const payload = {
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Управление гайдами FAQ').setDescription('Добавление / изменение / удаление / порядок гайдов для каналов FAQ (общий, участники, HR).')],
    components: [row(
      new ButtonBuilder().setCustomId('faq_add').setLabel('➕ Добавить гайд').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('faq_edit').setLabel('✏️ Изменить гайд').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('faq_delete').setLabel('➖ Удалить гайд').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('faq_reorder').setLabel('↕️ Порядок гайдов').setStyle(ButtonStyle.Secondary),
    )],
  };

  const messageId = await db.getSetting('faq_manage_message_id');
  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(payload);
      return;
    } catch (_) {
      // сообщение удалили — отправим новое ниже
    }
  }
  const sent = await channel.send(payload);
  await db.setSetting('faq_manage_message_id', sent.id);
}

// Панель изменения порядка гайдов одной категории (эфемерная, для кнопки «↕️ Порядок»)
async function faqReorderPanel(category, focusId) {
  const labels = { member: 'участники', hr: 'HR', public: 'общий' };
  const entries = await faq.listEntries(category);
  const lines = entries.map((e, i) => {
    const focused = String(e.id) === String(focusId);
    return `${i + 1}. ${focused ? '**' : ''}${e.title}${focused ? '** ◄' : ''}`;
  });
  const comps = [];
  if (focusId && entries.some((e) => String(e.id) === String(focusId))) {
    comps.push(row(
      new ButtonBuilder().setCustomId(`faq_move:${category}:${focusId}:up`).setLabel('▲ Выше').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`faq_move:${category}:${focusId}:down`).setLabel('▼ Ниже').setStyle(ButtonStyle.Primary),
    ));
  }
  if (entries.length > 0) {
    comps.push(row(
      new StringSelectMenuBuilder()
        .setCustomId(`select_faq_reorder:${category}`)
        .setPlaceholder('Выбрать гайд для перемещения')
        .addOptions(entries.slice(0, 25).map((e) => new StringSelectMenuOptionBuilder().setLabel(e.title.slice(0, 100)).setValue(String(e.id)))),
    ));
  }
  return { content: `**Порядок гайдов — ${labels[category] || category}** (сверху вниз):\n\n${lines.join('\n') || '_(гайдов нет)_'}`, components: comps };
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
  const tiers = giveaways.parsePrizeTiers(giveaway.prize_tiers);
  if (tiers.length) {
    embed.addFields({ name: 'Призовые места', value: tiers.map((t) => `${t.from === t.to ? t.from : `${t.from}-${t.to}`} место — ${t.text}`).join('\n').slice(0, 1024) });
  }
  if (ended) {
    embed.addFields({
      name: 'Победители',
      value: winners && winners.length > 0
        ? (tiers.length
          ? winners.map((w, i) => `${i + 1}. <@${w}> — ${giveaways.prizeForPlace(tiers, i + 1, giveaway.prize)}`).join('\n').slice(0, 1024)
          : winners.map((w) => `<@${w}>`).join(', '))
        : 'Никто не участвовал 😔',
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
  const weights = giveaway.weight_by_contracts ? await giveaways.contractWeights(entries).catch(() => null) : null;
  const winners = giveaways.pickWinners(entries, giveaway.winners_count, weights);
  await giveaways.setStatus(giveawayId, 'ended');
  await giveaways.setWinners(giveawayId, winners.join(','));

  try {
    const channel = await guild.channels.fetch(giveaway.channel_id);
    const embed = buildGiveawayEmbed(giveaway, entries.length, true, winners);
    try {
      const msg = await channel.messages.fetch(giveaway.message_id);
      await msg.edit({ embeds: [embed], components: buildGiveawayComponents(giveawayId, true) });
    } catch (_) {}

    if (winners.length > 0) {
      const tiers = giveaways.parsePrizeTiers(giveaway.prize_tiers);
      if (tiers.length) {
        const lines = winners.map((w, i) => `${i + 1} место — <@${w}> → **${giveaways.prizeForPlace(tiers, i + 1, giveaway.prize)}**`);
        await channel.send(`🎉 Итоги розыгрыша «${giveaway.prize}»:\n${lines.join('\n')}`);
      } else {
        await channel.send(`🎉 Поздравляем ${winners.map((w) => `<@${w}>`).join(', ')} — вы выиграли **${giveaway.prize}**!`);
      }
    } else {
      await channel.send(`😔 Розыгрыш «${giveaway.prize}» завершён — участников не было.`);
    }
    for (let i = 0; i < winners.length; i++) {
      const tiers = giveaways.parsePrizeTiers(giveaway.prize_tiers);
      await notify(winners[i], 'giveaway', `Вы выиграли розыгрыш «${giveaway.prize}»${tiers.length ? ` (${i + 1} место — ${giveaways.prizeForPlace(tiers, i + 1, giveaway.prize)})` : ''}!`, giveaway.message_id ? `https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id}` : '/giveaways');
    }
  } catch (err) {
    console.error('Не удалось объявить итоги розыгрыша:', err.message);
  }

  await logAudit(
    guild,
    actor || client.user,
    actor ? 'Розыгрыш завершён вручную' : 'Розыгрыш завершён (автоматически по таймеру)',
    [
      { name: 'Розыгрыш', value: giveaway.message_id ? `[Ссылка на розыгрыш](https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id})` : '—', inline: true },
      { name: 'Приз', value: giveaway.prize, inline: true },
      { name: 'Инициатор', value: actor ? `<@${actor.id}> | ${actor.tag}` : 'Автоматически', inline: true },
      { name: 'Участников', value: String(entries.length), inline: true },
      { name: 'Победители', value: winners.length > 0 ? winners.map((w) => `<@${w}>`).join(', ') : 'Никто не участвовал', inline: true },
    ],
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

  await logAudit(guild, actor || client.user, 'Розыгрыш отменён', [
    { name: 'Розыгрыш', value: giveaway.message_id ? `[Ссылка на розыгрыш](https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id})` : '—', inline: true },
    { name: 'Приз', value: giveaway.prize, inline: true },
    { name: 'Инициатор', value: actor ? `<@${actor.id}> | ${actor.tag}` : 'Автоматически', inline: true },
  ]);
  return true;
}

async function startGiveawayFromRule(guild, rule) {
  const endsAt = new Date(Date.now() + rule.duration_ms);
  const channel = await guild.channels.fetch(rule.channel_id);
  const giveawayId = await giveaways.createGiveaway(rule.channel_id, rule.prize, rule.winners_count, rule.host_id, endsAt.toISOString(), rule.required_role_id, rule.id);
  const embed = buildGiveawayEmbed({ prize: rule.prize, winners_count: rule.winners_count, ends_at: endsAt.toISOString(), host_id: rule.host_id, required_role_id: rule.required_role_id }, 0);
  const sent = await channel.send({
    content: '🎉 **РОЗЫГРЫШ** 🎉\n||@everyone||',
    embeds: [embed],
    components: buildGiveawayComponents(giveawayId),
    allowedMentions: { parse: ['everyone'] },
  });
  await giveaways.setMessageId(giveawayId, sent.id);
  return giveawayId;
}

// Отложенные розыгрыши (создаются с сайта): когда наступает start_at —
// бот создаёт обычный розыгрыш и публикует его в канал.
async function fireScheduledGiveaways(guild) {
  let due;
  try {
    due = await db.all("SELECT * FROM scheduled_giveaways WHERE status = 'pending' AND start_at <= ?", [new Date().toISOString()]);
  } catch (_) { return; }
  for (const s of due) {
    try {
      const endsAt = new Date(Date.now() + (s.duration_ms || 3600000));
      const gid = await giveaways.createGiveaway(
        s.channel_id, s.prize, s.winners_count, s.host_id, endsAt.toISOString(),
        s.required_role_id || null, null, s.min_role_id || null, s.prize_tiers || null,
      );
      const channel = await guild.channels.fetch(s.channel_id);
      const embed = buildGiveawayEmbed({
        prize: s.prize, winners_count: s.winners_count, ends_at: endsAt.toISOString(),
        host_id: s.host_id, required_role_id: s.required_role_id, prize_tiers: s.prize_tiers,
      }, 0);
      const sent = await channel.send({
        content: '🎉 **РОЗЫГРЫШ** 🎉',
        embeds: [embed],
        components: buildGiveawayComponents(gid),
      });
      await giveaways.setMessageId(gid, sent.id);
      await db.run("UPDATE scheduled_giveaways SET status = 'fired', fired_giveaway_id = ? WHERE id = ?", [gid, s.id]);
      await logAudit(guild, client.user, 'Отложенный розыгрыш запущен', [
        { name: 'Приз', value: s.prize, inline: true },
        { name: 'Победителей', value: String(s.winners_count), inline: true },
      ]);
    } catch (err) {
      console.error('Не удалось запустить отложенный розыгрыш', s.id, err.message);
      await db.run("UPDATE scheduled_giveaways SET status = 'cancelled' WHERE id = ?", [s.id]).catch(() => {});
    }
  }
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
      await logAudit(guild, client.user, 'Повторяющийся розыгрыш запущен', [
        { name: 'Приз', value: rule.prize, inline: true },
        { name: 'Правило', value: `#${rule.id}`, inline: true },
        { name: 'Канал', value: `<#${rule.channel_id}>`, inline: true },
      ]);
    } catch (err) {
      console.error(`Не удалось запустить повторяющийся розыгрыш (правило #${rule.id}):`, err.message);
    }
  }
}

async function rerollGiveaway(guild, giveawayId, actor) {
  const giveaway = await giveaways.getGiveaway(giveawayId);
  if (!giveaway || giveaway.status !== 'ended') return [];

  const entries = await giveaways.getEntries(giveawayId);
  const weights = giveaway.weight_by_contracts ? await giveaways.contractWeights(entries).catch(() => null) : null;
  const winners = giveaways.pickWinners(entries, giveaway.winners_count, weights);
  await giveaways.setWinners(giveawayId, winners.join(','));

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
    [
      { name: 'Розыгрыш', value: giveaway.message_id ? `[Ссылка на розыгрыш](https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id})` : '—', inline: true },
      { name: 'Приз', value: giveaway.prize, inline: true },
      { name: 'Инициатор', value: actor ? `<@${actor.id}> | ${actor.tag}` : 'Автоматически', inline: true },
      { name: 'Новые победители', value: winners.length > 0 ? winners.map((w) => `<@${w}>`).join(', ') : 'Никто не участвовал', inline: false },
    ],
  );

  return winners;
}

// Общая логика команды /сайт и кнопки «Войти на сайт»: создаёт одноразовую
// ссылку и присылает её в ЛС (с эфемерным фолбэком, если ЛС закрыты).
// interaction должен быть уже deferReply({ ephemeral }).
async function sendMagicLinkDM(interaction) {
  try {
    const url = await web.createMagicLink(interaction.user.id);
    let dmOk = true;
    try {
      await interaction.user.send({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔗 Вход на сайт организации')
          .setDescription(`Ссылка действует **10 минут** и сработает **один раз**:\n${url}\n\nЕсли ссылку запрашивали не вы — просто не переходите по ней.`)],
      });
    } catch (_) { dmOk = false; }
    return interaction.editReply(dmOk
      ? '📩 Отправил ссылку для входа тебе в личные сообщения.'
      : `⚠️ Не удалось написать в ЛС — открой личные сообщения от участников сервера.\nТвоя ссылка (10 минут, один переход):\n${url}`);
  } catch (err) {
    console.error('[сайт] не удалось создать ссылку входа:', err.message);
    return interaction.editReply('❌ Не удалось создать ссылку входа. Попробуйте позже.');
  }
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

  await safeInitStep('канал тикетов', async () => {
    const ticketsChannel = await guild.channels.fetch(config.CHANNEL_TICKETS_MENU);
    await sendOrEditMenu(ticketsChannel, 'tickets_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 Поддержка').setDescription('Нажмите кнопку, чтобы открыть приватный тикет — переписку увидите только вы и руководство.')],
      components: [row(new ButtonBuilder().setCustomId('ticket_open').setLabel('🎫 Открыть тикет').setStyle(ButtonStyle.Primary))],
    });
  });

  await safeInitStep('канал входа на сайт', async () => {
    const loginChannel = await guild.channels.fetch(config.CHANNEL_SITE_LOGIN);
    await sendOrEditMenu(loginChannel, 'site_login_menu_message_id', {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔗 Вход на сайт организации')
        .setDescription('Нажмите кнопку — бот пришлёт в личные сообщения одноразовую ссылку для входа (действует 10 минут).\n\nМожно также использовать команду `/сайт` или войти через Discord прямо на сайте.')],
      components: [row(new ButtonBuilder().setCustomId('magic_link_request').setLabel('🔗 Войти на сайт').setStyle(ButtonStyle.Primary))],
    });
  });

  await safeInitStep('список участников', () => safeUpdateMembersList(guild));
  await safeInitStep('чёрный список', () => safeUpdateBlacklist(guild));
  await safeInitStep('статистика по контрактам', () => contractsDisplay.safeUpdateContractsStats(guild));
  await safeInitStep('статистика по приглашениям', () => invitationsDisplay.safeUpdateInvitations(guild));
  await safeInitStep('статистика по заявкам', () => applicationsDisplay.safeUpdateApplicationsStats(guild));
  await safeInitStep('FAQ участников', () => faqDisplay.safeUpdateFaqChannel(guild, 'member'));
  await safeInitStep('FAQ HR', () => faqDisplay.safeUpdateFaqChannel(guild, 'hr'));
  await safeInitStep('FAQ общий', () => faqDisplay.safeUpdateFaqChannel(guild, 'public'));
  await safeInitStep('панель управления FAQ', () => sendFaqManagePanel(guild));
}

// ---------- Шаблоны причин отказа (в БД, правятся через /причины_отказа) ----------

const REJECT_QUEUE_LABEL = {
  application: 'Заявки на вступление',
  kick: 'Заявки на увольнение',
  vacation: 'Заявки на отпуск',
  blacklist: 'Чёрный список',
};
const REJECT_MODAL_ID = {
  application: 'modal_apply_reject',
  kick: 'modal_kick_reject',
  vacation: 'modal_vacation_reject',
};

async function getRejectTemplates(queue) {
  return db.all('SELECT * FROM reject_reason_templates WHERE queue = ? ORDER BY position, id', [queue]);
}

// При первом старте наполняет очередь application дефолтными формулировками
// (только если для неё вообще нет шаблонов — чтобы не мешать ручным правкам).
async function seedRejectTemplates() {
  const existing = await db.get("SELECT id FROM reject_reason_templates WHERE queue = 'application' LIMIT 1");
  if (existing) return;
  const defaults = [
    'Недостаточный уровень навыков',
    'Низкий LVL персонажа',
    'Неполная заявка / нет ответа на уточнения',
    'Не подходите по требованиям организации',
  ];
  for (let i = 0; i < defaults.length; i++) {
    await db.run(
      'INSERT INTO reject_reason_templates (queue, text, position, created_at) VALUES (?, ?, ?, ?)',
      ['application', defaults[i], i, new Date().toISOString()],
    );
  }
  console.log('Наполнены дефолтные шаблоны причин отказа (queue=application).');
}

// Показывает кнопки-шаблоны причин отказа + «Своя причина». Работает для
// любой очереди из REJECT_QUEUE_LABEL.
async function sendRejectPicker(interaction, queue, rowId) {
  const templates = await getRejectTemplates(queue);
  const buttons = templates.slice(0, 20).map((t) =>
    new ButtonBuilder().setCustomId(`rej_preset:${queue}:${rowId}:${t.id}`).setLabel(t.text.slice(0, 80)).setStyle(ButtonStyle.Secondary),
  );
  buttons.push(new ButtonBuilder().setCustomId(`rej_custom:${queue}:${rowId}`).setLabel('✏️ Своя причина').setStyle(ButtonStyle.Primary));
  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  return safeReply(interaction, { content: 'Причина отказа — выберите шаблон или «Своя причина»:', components: rows });
}

// Панель управления шаблонами одной очереди (для /причины_отказа)
async function rejtplPanel(queue) {
  const templates = await getRejectTemplates(queue);
  const list = templates.length
    ? templates.map((t, i) => `${i + 1}. ${t.text}`).join('\n')
    : '_(шаблонов нет — при отказе будет только «Своя причина»)_';
  return {
    content: `**Шаблоны причин отказа — ${REJECT_QUEUE_LABEL[queue]}**\n\n${list}`,
    components: [row(
      new ButtonBuilder().setCustomId(`rejtpl_add:${queue}`).setLabel('➕ Добавить').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rejtpl_edit:${queue}`).setLabel('✏️ Изменить').setStyle(ButtonStyle.Secondary).setDisabled(templates.length === 0),
      new ButtonBuilder().setCustomId(`rejtpl_del:${queue}`).setLabel('🗑 Удалить').setStyle(ButtonStyle.Danger).setDisabled(templates.length === 0),
    )],
  };
}

// ---------- Обработка заявок на вступление ----------

// Общая логика отказа заявке на вступление (кнопка-шаблон или модалка со
// своей причиной). interaction может быть уже обновлён (кнопка) или нет
// (модалка) — финальный ответ идёт через safeReply, который сам разберётся.
async function applyApplicationRejection(interaction, guild, appId, reason) {
  const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
  if (!app || app.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
  await db.run(
    'UPDATE applications SET status = ?, reject_reason = ?, rejected_by = ?, reviewed_at = ? WHERE id = ?',
    ['rejected', reason, interaction.user.id, new Date().toISOString(), appId],
  );
  await refreshReviewMessage(
    interaction.channel,
    app.message_id,
    await applicationReviewEmbed({ ...app, status: 'rejected', reject_reason: reason }, guild.id),
    [],
    actionSummary(interaction.user.id, '❌ Отклонено', reason),
  );
  await dmUser(guild, app.discord_id, `❌ Ваша заявка на вступление была отклонена. Причина: ${reason}`);
  await notify(app.discord_id, 'apply', `Заявка на вступление отклонена. Причина: ${reason}`, '/apply');
  await logAudit(guild, interaction.user, 'Заявка отклонена', [
    { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
    { name: 'Чья заявка', value: `<@${app.discord_id}> | № ${appId}`, inline: true },
    { name: 'Причина', value: reason, inline: false },
  ]);
  return safeReply(interaction, 'Заявка отклонена.');
}

// Общая логика отказа в заявке на увольнение (кнопка-шаблон или модалка).
async function applyKickRejection(interaction, guild, kickId, reason) {
  const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
  if (!k || k.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
  await db.run('UPDATE kicks SET status = ?, reject_reason = ?, reviewed_at = ? WHERE id = ?', ['rejected', reason, new Date().toISOString(), kickId]);
  await refreshReviewMessage(
    interaction.channel,
    k.message_id,
    await kickReviewEmbed({ ...k, status: 'rejected', reject_reason: reason }),
    [],
    actionSummary(interaction.user.id, '❌ Отклонено', reason),
  );
  await dmUser(guild, k.discord_id, `❌ Ваша заявка на увольнение была отклонена. Причина: ${reason}`);
  await logAudit(guild, interaction.user, 'Заявка на увольнение отклонена', [
    { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
    { name: 'Чья заявка', value: `<@${k.discord_id}> | № ${kickId}`, inline: true },
    { name: 'Причина', value: reason, inline: false },
  ]);
  return safeReply(interaction, 'Заявка отклонена.');
}

// Общая логика отказа в заявке на отпуск (кнопка-шаблон или модалка).
async function applyVacationRejection(interaction, guild, vId, reason) {
  const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
  if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
  await db.run('UPDATE vacations SET status = ?, reject_reason = ?, reviewed_at = ? WHERE id = ?', ['rejected', reason, new Date().toISOString(), vId]);
  await refreshReviewMessage(
    interaction.channel,
    v.message_id,
    vacationReviewEmbed({ ...v, status: 'rejected', reject_reason: reason }),
    [],
    actionSummary(interaction.user.id, '❌ Отклонено', reason),
  );
  await dmUser(guild, v.discord_id, `❌ Ваша заявка на отпуск отклонена. Причина: ${reason}`);
  await notify(v.discord_id, 'vacation', `Заявка на отпуск отклонена. Причина: ${reason}`, '/me');
  await logAudit(guild, interaction.user, 'Отпуск отклонён', [
    { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
    { name: 'Чья заявка', value: `<@${v.discord_id}> | № ${vId}`, inline: true },
    { name: 'Причина', value: reason, inline: false },
  ]);
  return safeReply(interaction, 'Заявка отклонена.');
}

const REJECT_APPLY = {
  application: (interaction, guild, id, reason) => applyApplicationRejection(interaction, guild, id, reason),
  kick: (interaction, guild, id, reason) => applyKickRejection(interaction, guild, id, reason),
  vacation: (interaction, guild, id, reason) => applyVacationRejection(interaction, guild, id, reason),
};

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
    claimButtonRow('application', app),
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
    claimButtonRow('kick', k),
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
    claimButtonRow('vacation', v),
  ];
}

function appealReviewEmbed(a, blRows) {
  const embed = new EmbedBuilder()
    .setColor(a.status === 'accepted' ? 0x57f287 : a.status === 'rejected' ? 0xed4245 : 0xfee75c)
    .setTitle(`🚫 Апелляция на ЧС #${a.id}`)
    .setDescription(a.text ? String(a.text).slice(0, 4000) : '—')
    .addFields(
      { name: 'Автор', value: `<@${a.discord_id}> | ${a.discord_tag || a.discord_id}`, inline: false },
      { name: 'Статус', value: statusLabel(a.status), inline: true },
    );
  if (blRows && blRows.length) {
    embed.addFields({
      name: 'Записи в ЧС',
      value: blRows.map((r) => `• № ${r.static || '—'} — ${r.reason || 'без причины'} (${formatDateOnly(new Date(r.created_at))}${r.until ? `, до ${formatDateOnly(new Date(r.until))}` : ''})`).join('\n').slice(0, 1024),
    });
  }
  if (a.reject_reason) embed.addFields({ name: 'Причина отказа', value: a.reject_reason });
  return embed;
}

function appealReviewComponents(a) {
  if (a.status !== 'pending') return [];
  return [row(
    new ButtonBuilder().setCustomId(`appeal_accept:${a.id}`).setLabel('✅ Снять из ЧС').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal_reject:${a.id}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`appeal_block:${a.discord_id}`).setLabel('🔒 Запретить апелляции').setStyle(ButtonStyle.Secondary),
  )];
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
const pendingDbUploads = new Map(); // короткий id -> { path, uploadedBy } (для подтверждения /резерв_загрузить)
const pendingImports = new Map(); // короткий id -> { rows, skipped, by } (для подтверждения /импорт_участники)
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

const auditSearchCache = new Map(); // короткий id -> текст запроса (для кнопок пагинации /аудит_поиск)
const AUDIT_PAGE_SIZE = 10;

async function runAuditSearch(queryText, page) {
  const q = `%${queryText}%`;
  const offset = page * AUDIT_PAGE_SIZE;
  const rows = await db.all(
    `SELECT * FROM audit_log WHERE action LIKE ? OR details LIKE ? OR actor_tag LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    [q, q, q, AUDIT_PAGE_SIZE + 1, offset],
  );
  const hasMore = rows.length > AUDIT_PAGE_SIZE;
  const pageRows = rows.slice(0, AUDIT_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Поиск по аудиту: «${queryText}»${page > 0 ? ` — стр. ${page + 1}` : ''}`)
    .setDescription(
      pageRows.length > 0
        ? pageRows.map((r) => `**${r.action}** — <@${r.actor_id}> — ${formatDateTime(new Date(r.at))}\n${r.details.slice(0, 200)}`).join('\n\n').slice(0, 4000)
        : 'Ничего не найдено на этой странице.',
    );
  return { embed, hasMore, total: pageRows.length };
}

function buildAuditSearchComponents(searchId, page, hasMore) {
  return [row(
    new ButtonBuilder().setCustomId(`audit_search_page:${searchId}:${page - 1}`).setLabel('◀ Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`audit_search_page:${searchId}:${page + 1}`).setLabel('Вперёд ▶').setStyle(ButtonStyle.Secondary).setDisabled(!hasMore),
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
    await member.roles.remove([...config.ROLE_IDS, config.ROLE_VACATION, config.ROLE_AFK, config.ROLE_ORGANIZATION].filter(Boolean));
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
          await logAudit(guild, interaction.user, 'Приглашение добавлено вручную', [
          { name: 'Кто добавил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Пригласитель', value: `<@${inviterId}>`, inline: true },
          { name: 'Приглашённый', value: `<@${discordId}>`, inline: true },
        ]);
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
            await logAudit(guild, interaction.user, 'Отпуск снят', [
              { name: 'Кто снял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
              { name: 'У кого', value: `<@${discordId}> | ${onVacation[0].name} (№ ${onVacation[0].static})`, inline: true },
            ]);
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
            await logAudit(guild, interaction.user, 'AFK снят', [
              { name: 'Кто снял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
              { name: 'У кого', value: `<@${discordId}> | ${onAfk[0].name} (№ ${onAfk[0].static})`, inline: true },
            ]);
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

// Какие разделы FAQ доступны для поиска этому человеку:
//  public — всем; member — тем, кто в организации (есть ранговая роль) и выше;
//  hr — HR-Менеджеру и выше.
function faqSearchableCategories(member) {
  const cats = ['public'];
  if (!member) return cats;
  const inOrg = config.ROLE_IDS.some((r) => member.roles.cache.has(r)) || perms.hasBotAccess(member) || perms.isHrTier(member);
  if (inOrg) cats.push('member');
  if (perms.isHrTier(member)) cats.push('hr');
  return cats;
}

// Поиск по гайдам FAQ с учётом доступных человеку разделов.
async function runFaqSearch(member, query) {
  const cats = faqSearchableCategories(member);
  const q = `%${query}%`;
  const placeholders = cats.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT * FROM faq_entries WHERE category IN (${placeholders}) AND (title LIKE ? OR content LIKE ?) ORDER BY category, position LIMIT 10`,
    [...cats, q, q],
  );
  if (rows.length === 0) return { content: `По запросу «${query}» в FAQ ничего не найдено.` };
  if (rows.length === 1) {
    const e = rows[0];
    return {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`❓ ${e.title}`).setDescription(e.content.slice(0, 4000))],
      components: [row(
        new ButtonBuilder().setCustomId(`faq_helpful:${e.id}:1`).setLabel('👍 Помогло').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`faq_helpful:${e.id}:0`).setLabel('👎 Не помогло').setStyle(ButtonStyle.Secondary),
      )],
    };
  }
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🔍 FAQ: «${query}» — найдено ${rows.length}`);
  for (const e of rows) {
    embed.addFields({ name: e.title.slice(0, 256), value: (e.content.slice(0, 280) + (e.content.length > 280 ? '…' : '')).slice(0, 1024) });
  }
  return { embeds: [embed] };
}

// Ведомость выплат за принятых, кто пробыл 3+ дня. Возвращает массив
// { staffId, name, static, count, isHr, perHead, sum } + total.
async function computeHrPayouts(guild, sinceIso) {
  const rows = await db.all(
    `SELECT staff_discord_id, COUNT(*) AS cnt FROM acceptances
     WHERE status = 'confirmed' AND COALESCE(resolved_at, joined_at) >= ?
     GROUP BY staff_discord_id`,
    [sinceIso],
  );
  const result = [];
  let total = 0;
  for (const r of rows) {
    if (!r.staff_discord_id) continue;
    let isHr = false;
    try {
      const m = await guild.members.fetch(r.staff_discord_id);
      isHr = m.roles.cache.has(config.ROLE_HR);
    } catch (_) {
      // ушёл с сервера — считаем как не HR
    }
    const identity = await passportsLib.computeEffectiveIdentity(r.staff_discord_id);
    const perHead = isHr ? config.HR_PAYOUT_CONFIRMED : config.HR_PAYOUT_OTHER;
    const sum = r.cnt * perHead;
    total += sum;
    result.push({
      staffId: r.staff_discord_id,
      name: identity ? identity.name : null,
      static: identity ? identity.static : null,
      count: r.cnt,
      isHr,
      perHead,
      sum,
    });
  }
  result.sort((a, b) => b.sum - a.sum);
  return { rows: result, total };
}

function formatMoney(n) {
  return `${Number(n).toLocaleString('ru-RU')}$`;
}

// Сводка одной недели для /сравнить_недели (n = сколько недель назад)
async function weekSummaryForCompare(n) {
  const range = contracts.getWeekRange(n);
  const s = range.start.toISOString();
  const e = range.end.toISOString();
  const cr = await db.all(`SELECT status FROM contracts WHERE status IN ('fulfilled','unfulfilled') AND submitted_at BETWEEN ? AND ?`, [s, e]);
  const one = async (sql) => (await db.get(sql, [s, e])).c;
  return {
    label: contracts.formatWeekLabel(range),
    fulfilled: cr.filter((r) => r.status === 'fulfilled').length,
    unfulfilled: cr.filter((r) => r.status === 'unfulfilled').length,
    invites: await one(`SELECT COUNT(*) AS c FROM invitations WHERE status = 'confirmed' AND joined_at BETWEEN ? AND ?`),
    accepted: await one(`SELECT COUNT(*) AS c FROM applications WHERE status = 'accepted' AND created_at BETWEEN ? AND ?`),
    rejected: await one(`SELECT COUNT(*) AS c FROM applications WHERE status = 'rejected' AND created_at BETWEEN ? AND ?`),
    kicks: await one(`SELECT COUNT(*) AS c FROM kicks WHERE status = 'accepted' AND created_at BETWEEN ? AND ?`),
  };
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

      if (interaction.commandName === 'розыгрыш_завершить' || interaction.commandName === 'розыгрыш_отменить' || interaction.commandName === 'розыгрыш_реролл' || interaction.commandName === 'розыгрыш_участники' || interaction.commandName === 'розыгрыш_участники_экспорт' || interaction.commandName === 'розыгрыш_добавить_участника' || interaction.commandName === 'розыгрыш_удалить_участника') {
        const focused = interaction.options.getFocused();
        let statusClause = '';
        let params = [`%${focused}%`];
        if (interaction.commandName === 'розыгрыш_реролл') {
          statusClause = "AND status = 'ended'";
        } else if (interaction.commandName === 'розыгрыш_завершить' || interaction.commandName === 'розыгрыш_отменить' || interaction.commandName === 'розыгрыш_добавить_участника' || interaction.commandName === 'розыгрыш_удалить_участника') {
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

      if (interaction.commandName === 'розыгрыш_повтор_отменить' || interaction.commandName === 'розыгрыш_повтор_возобновить') {
        const focused = interaction.options.getFocused();
        const wantStatus = interaction.commandName === 'розыгрыш_повтор_возобновить' ? 'paused' : 'active';
        const rules = await db.all(`SELECT * FROM giveaway_recurring_rules WHERE status = ? AND prize LIKE ? ORDER BY id DESC LIMIT 25`, [wantStatus, `%${focused}%`]);
        const choices = rules.map((r) => ({
          name: `#${r.id} — ${r.prize} (каждый(ую) ${giveaways.WEEKDAY_NAMES[r.weekday]})`.slice(0, 100),
          value: String(r.id),
        }));
        try {
          await interaction.respond(choices);
        } catch (_) {}
        return;
      }

      const autocompleteCommands = ['история', 'кто_это', 'правила_разослать', 'каналы_отчётов', 'отпуск_статистика', 'команды_человека', 'ник_история', 'профиль_экспорт'];
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

      if (cmd === 'сайт') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return sendMagicLinkDM(interaction);
      }

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

        await logAudit(guild, interaction.user, 'Backfill профилей выполнен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Создано каналов', value: String(createdChannels), inline: true },
          { name: 'Восстановлено из архива', value: String(restoredChannels), inline: true },
          { name: 'Записей о вступлении', value: String(loggedJoins), inline: true },
          { name: 'Исправлено рангов', value: String(fixedRanks), inline: true },
          { name: 'Осиротевших каналов', value: String(orphanChannels.length), inline: true },
        ]);
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
        const weeksAgo = interaction.options.getInteger('недель_назад');
        let board;
        let title;
        if (weeksAgo === null) {
          board = await contracts.getAllTimeLeaderboard();
          title = '🏆 Топ по контрактам за всё время';
        } else {
          const range = contracts.getWeekRange(weeksAgo);
          board = await contracts.getWeekLeaderboard(range);
          title = `🏆 Топ по контрактам — ${contracts.formatWeekLabel(range)}`;
        }
        if (board.length === 0) {
          await interaction.editReply('Обработанных контрактов за этот период нет.');
          return;
        }
        const lines = board.slice(0, 25).map((row, i) => `${i + 1}. <@${row.discord_id}> — ✅ ${row.fulfilled} / ❌ ${row.unfulfilled}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(lines.join('\n'));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'аудит_поиск') {
        if (!(await checkCommandAccess('аудит_поиск', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('запрос');

        const { embed, hasMore, total } = await runAuditSearch(query, 0);
        if (total === 0) {
          await interaction.editReply('Ничего не найдено.');
          return;
        }

        const searchId = Math.random().toString(36).slice(2, 10);
        auditSearchCache.set(searchId, query);
        if (auditSearchCache.size > 200) {
          const oldestKey = auditSearchCache.keys().next().value;
          auditSearchCache.delete(oldestKey);
        }

        await interaction.editReply({ embeds: [embed], components: buildAuditSearchComponents(searchId, 0, hasMore) });
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
        const daysOpt = interaction.options.getInteger('дней');
        const weeksAgoOpt = interaction.options.getInteger('недель_назад') || 0;
        let range;
        let periodLabel;
        if (daysOpt) {
          range = { start: new Date(Date.now() - daysOpt * 24 * 60 * 60 * 1000), end: new Date() };
          periodLabel = `последние ${daysOpt} дн.`;
        } else {
          range = contracts.getWeekRange(weeksAgoOpt);
          periodLabel = contracts.formatWeekLabel(range);
        }
        const label = periodLabel.replace(/[.\s:]+/g, '-');

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

        await logAudit(guild, interaction.user, 'Экспорт статистики', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Период', value: periodLabel, inline: true },
        ]);
        await interaction.editReply({ content: `Статистика за ${periodLabel}:`, files });
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

        await logAudit(guild, interaction.user, 'Рассылка ссылок на каналы с отчётами', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: query ? `Одному: ${targets[0].name}` : 'Всем участникам', inline: true },
          { name: 'Отправлено', value: query ? '1/1' : `${sent}/${targets.length} (пропущено: ${skipped})`, inline: true },
        ]);
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

        await logAudit(guild, interaction.user, 'Экспорт ID каналов/ролей', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Каналов', value: String(allChannels.length - categories.length), inline: true },
          { name: 'Ролей', value: String(roles.length), inline: true },
        ]);
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
          content: '🎉 **РОЗЫГРЫШ** 🎉\n||@everyone||',
          embeds: [embed],
          components: buildGiveawayComponents(giveawayId),
          allowedMentions: { parse: ['everyone'] },
        });
        await giveaways.setMessageId(giveawayId, sent.id);

        await logAudit(guild, interaction.user, 'Розыгрыш запущен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Приз', value: prize, inline: true },
          { name: 'Канал', value: `<#${targetChannel.id}>`, inline: true },
          { name: 'Победителей', value: String(winnersCount), inline: true },
          { name: 'До какого времени', value: formatDateTime(endsAt), inline: true },
          { name: 'Условие', value: requiredRole ? requiredRole.name : 'нет', inline: true },
        ]);
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

        if (await giveaways.isBlacklisted(targetUser.id)) {
          await interaction.editReply('⛔ Этот человек в ЧС розыгрышей — участвовать не может.');
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

        await logAudit(guild, interaction.user, 'Участник добавлен в розыгрыш вручную', [
          { name: 'Розыгрыш', value: giveaway.message_id ? `[Ссылка на розыгрыш](https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id})` : '—', inline: true },
          { name: 'Приз', value: giveaway.prize, inline: true },
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого добавили', value: `<@${targetUser.id}> | ${targetUser.tag}`, inline: true },
        ]);
        await interaction.editReply(`✅ <@${targetUser.id}> добавлен(а) в розыгрыш «${giveaway.prize}».`);
        return;
      }

      if (cmd === 'розыгрыш_удалить_участника') {
        if (!(await checkCommandAccess('розыгрыш_удалить_участника', interaction.member))) {
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

        const already = await giveaways.hasEntry(giveawayId, targetUser.id);
        if (!already) {
          await interaction.editReply('Этот человек и так не участвует.');
          return;
        }
        await giveaways.removeEntry(giveawayId, targetUser.id);
        const count = await giveaways.countEntries(giveawayId);
        try {
          const channel = await guild.channels.fetch(giveaway.channel_id);
          const msg = await channel.messages.fetch(giveaway.message_id);
          await msg.edit({ embeds: [buildGiveawayEmbed(giveaway, count)] });
        } catch (_) {}

        await logAudit(guild, interaction.user, 'Участник удалён из розыгрыша вручную', [
          { name: 'Розыгрыш', value: giveaway.message_id ? `[Ссылка на розыгрыш](https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id})` : '—', inline: true },
          { name: 'Приз', value: giveaway.prize, inline: true },
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого удалили', value: `<@${targetUser.id}> | ${targetUser.tag}`, inline: true },
        ]);
        await interaction.editReply(`✅ <@${targetUser.id}> удалён(а) из розыгрыша «${giveaway.prize}».`);
        return;
      }

      if (cmd === 'розыгрыш_чс_добавить') {
        if (!(await checkCommandAccess('розыгрыш_чс_добавить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('человек');
        const reason = interaction.options.getString('причина') || '';
        await giveaways.addToBlacklist(targetUser.id, reason, interaction.user.id);
        await logAudit(guild, interaction.user, 'Добавлен в ЧС розыгрышей', [
          { name: 'Кто добавил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого добавил', value: `<@${targetUser.id}> | ${targetUser.tag}`, inline: true },
          { name: 'Причина', value: reason || '—', inline: false },
        ]);
        await interaction.editReply(`✅ <@${targetUser.id}> добавлен(а) в ЧС розыгрышей.`);
        return;
      }

      if (cmd === 'розыгрыш_чс_убрать') {
        if (!(await checkCommandAccess('розыгрыш_чс_убрать', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('человек');
        const removed = await giveaways.removeFromBlacklist(targetUser.id);
        if (!removed) {
          await interaction.editReply('Этого человека и так не было в ЧС розыгрышей.');
          return;
        }
        await logAudit(guild, interaction.user, 'Убран из ЧС розыгрышей', [
          { name: 'Кто убрал', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого убрал', value: `<@${targetUser.id}> | ${targetUser.tag}`, inline: true },
        ]);
        await interaction.editReply(`✅ <@${targetUser.id}> убран(а) из ЧС розыгрышей.`);
        return;
      }

      if (cmd === 'розыгрыш_чс_список') {
        if (!(await checkCommandAccess('розыгрыш_чс_список', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rows = await giveaways.getBlacklist();
        if (rows.length === 0) {
          await interaction.editReply('ЧС розыгрышей пуста.');
          return;
        }
        const lines = rows.map((r) => `<@${r.discord_id}>${r.reason ? ` — ${r.reason}` : ''} (добавил: <@${r.added_by}>, ${formatDateTime(new Date(r.added_at))})`);
        const embed = new EmbedBuilder().setColor(0xed4245).setTitle('🚫 ЧС розыгрышей').setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'discord_права_настроить') {
        if (!(await checkCommandAccess('discord_права_настроить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const envError = commandPermSync.missingEnvMessage();
        if (envError) {
          return interaction.reply({ content: `⛔ ${envError}`, flags: MessageFlags.Ephemeral });
        }

        const url = commandPermSync.buildAuthorizeUrl();
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🔗 Настройка видимости команд в Discord')
          .setDescription(
            `1. Откройте эту ссылку и авторизуйтесь: ${url}\n\n` +
            `2. После подтверждения Discord перенаправит на страницу, которая может показать ошибку "не удалось открыть" — это нормально, нужная часть уже в адресной строке браузера.\n\n` +
            `3. Скопируйте из адресной строки значение после \`code=\` (до символа \`&\`, если он есть).\n\n` +
            `4. Нажмите кнопку ниже и вставьте код.`,
          );
        return interaction.reply({
          embeds: [embed],
          components: [row(new ButtonBuilder().setCustomId('oauth_enter_code').setLabel('Ввести код').setStyle(ButtonStyle.Primary))],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (cmd === 'discord_права_синхронизировать') {
        if (!(await checkCommandAccess('discord_права_синхронизировать', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        if (!(await commandPermSync.isAuthorized())) {
          return interaction.reply({ content: '⛔ Сначала выполните `/discord_права_настроить`.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await syncAllCommandPermissions(guild);
        await db.setSetting('command_perm_last_sync', new Date().toISOString());
        await logSystem(guild, 'Видимость команд синхронизирована с Discord', `Инициатор: ${interaction.user.tag} (${interaction.user.id}). Успешно: ${result.ok}${result.failed.length > 0 ? `. Ошибок: ${result.failed.length}` : ''}`);
        let msg = `✅ Синхронизировано команд: ${result.ok}.`;
        if (result.failed.length > 0) {
          msg += `\n\n⚠️ Не удалось (${result.failed.length}):\n${result.failed.slice(0, 10).join('\n')}`;
        }
        await interaction.editReply(msg.slice(0, 2000));
        return;
      }

      if (cmd === 'discord_права_статус') {
        if (!(await checkCommandAccess('discord_права_статус', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const status = await commandPermSync.getStatus();
        const lastSync = await db.getSetting('command_perm_last_sync');

        const embed = new EmbedBuilder().setColor(status.authorized && status.tokenValid ? 0x57f287 : 0xed4245).setTitle('🔗 Статус синхронизации видимости команд');
        if (!status.authorized) {
          embed.setDescription('❌ Авторизация ещё не пройдена. Выполните `/discord_права_настроить`.');
        } else {
          embed.addFields(
            { name: 'Авторизован', value: status.tokenValid ? '✅ Да' : '⚠️ Токен истёк, нужна повторная авторизация', inline: true },
            { name: 'Кто авторизовал', value: `<@${status.authorizedBy}>`, inline: true },
            { name: 'Токен действует до', value: formatDateTime(new Date(status.expiresAt)), inline: true },
            { name: 'Последняя синхронизация', value: lastSync ? formatDateTime(new Date(lastSync)) : 'Ещё не выполнялась', inline: true },
          );
          if (!status.tokenValid) {
            embed.setDescription('⚠️ Токен истёк — синхронизация сейчас не работает. Выполните `/discord_права_настроить` заново.');
          }
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'кэш_статистика') {
        if (!(await checkCommandAccess('кэш_статистика', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let files = [];
        try {
          files = fs.readdirSync(mediaCache.CACHE_DIR);
        } catch (_) {}
        let totalSize = 0;
        for (const f of files) {
          try {
            totalSize += fs.statSync(path.join(mediaCache.CACHE_DIR, f)).size;
          } catch (_) {}
        }
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('💾 Кэш скриншотов')
          .addFields(
            { name: 'Файлов', value: String(files.length), inline: true },
            { name: 'Занято места', value: `${(totalSize / 1024 / 1024).toFixed(2)} МБ`, inline: true },
            { name: 'Срок хранения', value: '30 дней', inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'ранги_пересчитать_сейчас') {
        if (!(await checkCommandAccess('ранги_пересчитать_сейчас', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const demotedCount = await runWeeklyRankAdjustment(guild, true);
        await interaction.editReply(`✅ Пересчёт выполнен. Понижено паспортов: ${demotedCount}.`);
        return;
      }

      if (cmd === 'статус_бд') {
        if (!(await checkCommandAccess('статус_бд', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let dbSize = 0;
        try {
          dbSize = fs.statSync(db.dbPath).size;
        } catch (_) {}

        const tables = ['participants', 'extra_passports', 'applications', 'kicks', 'vacations', 'contracts', 'invitations', 'blacklist', 'audit_log', 'giveaways'];
        const counts = [];
        for (const t of tables) {
          try {
            const r = await db.get(`SELECT COUNT(*) as cnt FROM ${t}`);
            counts.push(`${t}: ${r.cnt}`);
          } catch (_) {}
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🗄️ Статус базы данных')
          .addFields(
            { name: 'Размер файла', value: `${(dbSize / 1024 / 1024).toFixed(2)} МБ`, inline: true },
            { name: 'Записей по таблицам', value: counts.join('\n').slice(0, 1024), inline: false },
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'розыгрыш_участники_экспорт') {
        if (!(await checkCommandAccess('розыгрыш_участники_экспорт', interaction.member))) {
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
        if (entries.length === 0) {
          await interaction.editReply('Участников пока нет — выгружать нечего.');
          return;
        }
        const csv = buildCsv(['discord_id'], entries.map((id) => [id]));
        const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `giveaway_${giveawayId}_participants.csv` });
        await logAudit(guild, interaction.user, 'Экспорт участников розыгрыша', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Приз', value: giveaway.prize, inline: true },
          { name: 'Участников', value: String(entries.length), inline: true },
        ]);
        await interaction.editReply({ content: `Участники розыгрыша «${giveaway.prize}» (${entries.length}):`, files: [file] });
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

        await logAudit(guild, interaction.user, 'Повторяющийся розыгрыш настроен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Приз', value: prize, inline: true },
          { name: 'День недели', value: giveaways.WEEKDAY_NAMES[weekday], inline: true },
          { name: 'Канал', value: `<#${targetChannel.id}>`, inline: true },
          { name: 'Условие', value: requiredRole ? requiredRole.name : 'нет', inline: true },
        ]);
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

      if (cmd === 'розыгрыш_история') {
        if (!(await checkCommandAccess('розыгрыш_история', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = await giveaways.getFinishedSince(since);
        if (rows.length === 0) {
          await interaction.editReply(`Завершённых розыгрышей за последние ${days} дн. нет.`);
          return;
        }
        const statusLabels = { ended: '⚪ завершён', cancelled: '❌ отменён' };
        const lines = rows.map((g) => {
          const when = formatDateOnly(new Date(g.created_at));
          const winners = g.status === 'ended'
            ? (g.winners ? g.winners.split(',').filter(Boolean).map((w) => `<@${w}>`).join(', ') : 'без победителей')
            : '—';
          return `**${g.prize}** — ${statusLabels[g.status] || g.status}, ${when}\nПобедители: ${winners}`;
        });
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🎉 История розыгрышей за ${days} дн.`)
          .setDescription(lines.join('\n\n').slice(0, 4000));

        // Топ победителей за период (по всем завершённым, без лимита 25) — проверка на честность
        const winnerRows = await giveaways.getEndedWinnersSince(since);
        const winCount = new Map();
        for (const wr of winnerRows) {
          for (const w of (wr.winners || '').split(',').filter(Boolean)) {
            winCount.set(w, (winCount.get(w) || 0) + 1);
          }
        }
        if (winCount.size > 0) {
          const top = [...winCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
          embed.addFields({ name: '🏆 Чаще всех выигрывали', value: top.map(([w, c], i) => `${i + 1}. <@${w}> — ${c}`).join('\n').slice(0, 1024) });
        }

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
        await logAudit(guild, interaction.user, 'Повторяющийся розыгрыш остановлен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Приз', value: ruleRow.prize, inline: true },
          { name: 'Правило', value: `#${ruleId}`, inline: true },
        ]);
        await interaction.editReply(`Правило #${ruleId} («${ruleRow.prize}») остановлено — новые розыгрыши по нему создаваться не будут.`);
        return;
      }

      if (cmd === 'розыгрыш_повтор_возобновить') {
        if (!(await checkCommandAccess('розыгрыш_повтор_возобновить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ruleId = interaction.options.getString('правило');
        const ruleRow = await giveaways.getRecurringRule(ruleId);
        if (!ruleRow) {
          await interaction.editReply('⛔ Такое правило не найдено.');
          return;
        }
        if (ruleRow.status === 'active') {
          await interaction.editReply('Это правило и так активно.');
          return;
        }
        await giveaways.setRecurringRuleStatus(ruleId, 'active');
        await logAudit(guild, interaction.user, 'Повторяющийся розыгрыш возобновлён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Приз', value: ruleRow.prize, inline: true },
          { name: 'Правило', value: `#${ruleId}`, inline: true },
        ]);
        await interaction.editReply(`Правило #${ruleId} («${ruleRow.prize}») возобновлено — розыгрыши снова будут создаваться каждый(ую) ${giveaways.WEEKDAY_NAMES[ruleRow.weekday]}.`);
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
            await logAudit(guild, interaction.user, 'Настройка сброшена', [
              { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
              { name: 'Ключ', value: key, inline: true },
            ]);
            await interaction.editReply(`Настройка «${key}» сброшена на значение по умолчанию: ${config[key]}`);
            return;
          }
          const oldValue = config[key];
          const newValue = await configStore.setOverride(key, rawValue, interaction.user.id);
          await logAudit(guild, interaction.user, 'Настройка изменена', [
            { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Ключ', value: key, inline: true },
            { name: 'Было', value: String(oldValue), inline: true },
            { name: 'Стало', value: String(newValue), inline: true },
          ]);

          // Если ключ похож на ID канала/роли — сразу проверяем, существует ли
          // такой ID на сервере, чтобы не узнать об опечатке только когда
          // что-то сломается.
          let existenceWarning = '';
          if (/CHANNEL/i.test(key) && /^\d{17,20}$/.test(String(newValue))) {
            const found = guild.channels.cache.get(String(newValue));
            if (!found) existenceWarning = `\n\n⚠️ Канал с ID \`${newValue}\` не найден на этом сервере — проверьте, не опечатка ли.`;
          } else if (/ROLE/i.test(key) && /^\d{17,20}$/.test(String(newValue))) {
            const found = guild.roles.cache.get(String(newValue));
            if (!found) existenceWarning = `\n\n⚠️ Роль с ID \`${newValue}\` не найдена на этом сервере — проверьте, не опечатка ли.`;
          }

          await interaction.editReply(`Готово. «${key}» теперь: ${newValue}\n\n(применилось сразу, без перезапуска)${existenceWarning}`);
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
        await logAudit(guild, interaction.user, 'Переключена функция бота', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Функция', value: featureLabels[feature], inline: true },
          { name: 'Состояние', value: state === 'on' ? 'включено' : 'выключено', inline: true },
        ]);
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
        const weeksAgo = interaction.options.getInteger('недель_назад');
        let board;
        let title;
        if (weeksAgo === null) {
          board = await invitations.getAllTimeLeaderboard();
          title = '🏆 Топ по приглашениям за всё время';
        } else {
          const range = contracts.getWeekRange(weeksAgo);
          board = await invitations.getWeekLeaderboard(range);
          title = `🏆 Топ по приглашениям — ${contracts.formatWeekLabel(range)}`;
        }
        if (board.length === 0) {
          await interaction.editReply('Подтверждённых приглашений за этот период нет.');
          return;
        }
        const lines = board.slice(0, 25).map((row, i) => `${i + 1}. <@${row.inviter_discord_id}> — ${row.cnt}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(lines.join('\n'));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'бэкап_сейчас') {
        if (!(await checkCommandAccess('бэкап_сейчас', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const filePath = backup.backupNow();
        await logAudit(guild, interaction.user, 'Резервная копия создана вручную', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Результат', value: filePath ? 'Успешно' : 'Ошибка — см. консоль/канал аудита', inline: true },
        ]);
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

      if (cmd === 'резерв_загрузить') {
        if (!(await checkCommandAccess('резерв_загрузить', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const attachment = interaction.options.getAttachment('файл');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let buffer;
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buffer = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось скачать файл: ${err.message}`);
          return;
        }

        // Простая проверка — действительно ли это файл SQLite (первые 16
        // байт любой валидной базы SQLite — "SQLite format 3\0")
        const header = buffer.subarray(0, 16).toString('utf8');
        if (!header.startsWith('SQLite format 3')) {
          await interaction.editReply('⛔ Этот файл не похож на базу данных SQLite (нет нужного заголовка). Ничего не менял.');
          return;
        }

        const tempDir = path.join(db.dataDir, 'pending_uploads');
        fs.mkdirSync(tempDir, { recursive: true });
        const tempId = Math.random().toString(36).slice(2, 10);
        const tempPath = path.join(tempDir, `${tempId}.db`);
        fs.writeFileSync(tempPath, buffer);
        pendingDbUploads.set(tempId, { path: tempPath, uploadedBy: interaction.user.id });

        const uploadEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('⚠️ Загрузка базы данных')
          .setDescription(
            `Вы собираетесь заменить **текущую** базу данных загруженным файлом:\n\`${attachment.name}\` (${(buffer.length / 1024 / 1024).toFixed(2)} МБ).\n\n` +
            `**Все текущие данные будут потеряны безвозвратно.** Перед заменой бот автоматически сделает резервную копию текущей базы — на случай, если загруженный файл окажется не тем.\n\n` +
            `После подтверждения бот нужно будет **вручную перезапустить** (Restart на Bothost), чтобы изменения точно применились.`,
          );
        await interaction.editReply({
          embeds: [uploadEmbed],
          components: [row(
            new ButtonBuilder().setCustomId(`upload_db_confirm:${tempId}`).setLabel('⚠️ Да, заменить').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`upload_db_cancel:${tempId}`).setLabel('Отмена').setStyle(ButtonStyle.Secondary),
          )],
        });
        return;
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
        await logAudit(guild, interaction.user, 'Экспорт аудита', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Период', value: `${days} дней`, inline: true },
          { name: 'Записей', value: String(rows.length), inline: true },
        ]);
        await interaction.editReply({ content: `Аудит за последние ${days} дней (${rows.length} записей):`, files: [file] });
        return;
      }

      if (cmd === 'помощь') {
        if (!(await checkCommandAccess('помощь', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const descByName = new Map(commands.map((c) => [c.name, c.description]));
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📖 Доступные вам команды');
        let totalShown = 0;
        for (const cat of COMMAND_CATEGORIES) {
          const allowedNames = [];
          for (const name of cat.commands) {
            if (await checkCommandAccess(name, interaction.member)) {
              allowedNames.push(name);
            }
          }
          if (allowedNames.length === 0) continue; // категория вся недоступна — не показываем пустой заголовок
          totalShown += allowedNames.length;
          const lines = allowedNames.map((name) => `\`/${name}\` — ${descByName.get(name) || '—'}`);
          embed.addFields({ name: cat.title, value: lines.join('\n').slice(0, 1024) });
        }
        if (totalShown === 0) {
          await interaction.editReply('Вам не доступна ни одна команда.');
          return;
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

        const grouped = { everyone: [], admin: [], owner: [], deputy: [], hr: [], owner_account_only: [], specific: [] };
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

      if (cmd === 'ник_история') {
        if (!(await checkCommandAccess('ник_история', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('человек');
        const target = await invitations.resolveInviter(query);
        if (!target) {
          await interaction.editReply('⛔ Человек не найден.');
          return;
        }
        const rows = await db.all('SELECT * FROM nickname_history WHERE discord_id = ? ORDER BY id DESC LIMIT 25', [target.discord_id]);
        if (rows.length === 0) {
          await interaction.editReply(`История смены ника для <@${target.discord_id}> пуста (ведётся с момента установки этой функции).`);
          return;
        }
        const lines = rows.map((n) => {
          const who = n.changed_by && n.changed_by !== 'unknown' ? `<@${n.changed_by}>` : 'кто-то';
          return `«${n.old_nick || '—'}» → «${n.new_nick || '—'}» — ${who}, ${formatDateTime(new Date(n.at))}`;
        });
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`История ника: <@${target.discord_id}>`)
          .setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'профиль_экспорт') {
        if (!(await checkCommandAccess('профиль_экспорт', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const target = await invitations.resolveInviter(interaction.options.getString('человек'));
        if (!target) {
          await interaction.editReply('⛔ Человек не найден.');
          return;
        }
        const did = target.discord_id;
        const L = [];
        const push = (s = '') => L.push(s);
        const section = (t) => { push(''); push(`=== ${t} ===`); };
        const fdt = (v) => (v ? formatDateTime(new Date(v)) : '—');

        push(`ЭКСПОРТ ПРОФИЛЯ`);
        push(`Discord ID: ${did}`);
        push(`Тег: ${target.discord_tag || '—'}`);
        push(`Сформировано: ${formatDateTime(new Date())} (МСК), инициатор: ${interaction.user.tag}`);

        section('УЧЁТНАЯ ЗАПИСЬ');
        push(`Имя Фамилия: ${target.name} | № Паспорта: ${target.static} | LVL: ${target.lvl ?? '—'} | Онлайн: ${target.online || '—'}`);
        push(`Ранг (role_id): ${target.role_id || '—'} | Вступил: ${fdt(target.joined_at)}`);
        push(`Отпуск до: ${fdt(target.vacation_until)} | AFK с: ${target.afk_since || '—'}`);
        push(`Навыки: ${target.skills || '—'}`);

        const passports = await passportsLib.getAllPassports(did);
        section(`ПАСПОРТА (${passports.length})`);
        for (const p of passports) push(`• ${p.name} (№ ${p.static}), позиция ${p.position}, ранг ${p.role_id || '—'}${p.vacation_until ? `, отпуск до ${fdt(p.vacation_until)}` : ''}${p.afk_since ? `, AFK с ${p.afk_since}` : ''}`);

        const dump = async (title, sql, params, fmt) => {
          const rows = await db.all(sql, params);
          section(`${title} (${rows.length})`);
          for (const r of rows) push(`• ${fmt(r)}`);
        };

        await dump('ИСТОРИЯ ВСТУПЛЕНИЙ/УВОЛЬНЕНИЙ', 'SELECT * FROM membership_events WHERE discord_id = ? ORDER BY at', [did],
          (r) => `${r.event === 'joined' ? 'вступил' : 'покинул'} — ${r.name} (№ ${r.static}) — ${fdt(r.at)}${r.note ? ` — ${r.note}` : ''}`);
        await dump('ОТПУСК/AFK (выдачи и снятия руководством)', "SELECT * FROM status_events WHERE discord_id = ? ORDER BY at", [did],
          (r) => `${r.type} ${r.action === 'granted' ? 'выдан' : 'снят'} — ${r.name} (№ ${r.static}) — ${fdt(r.at)}${r.until ? ` — до ${fdt(r.until)}` : ''}${r.reason ? ` — ${r.reason}` : ''} — actor ${r.actor_id}`);
        await dump('СМЕНА НИКА НА СЕРВЕРЕ', 'SELECT * FROM nickname_history WHERE discord_id = ? ORDER BY id', [did],
          (r) => `«${r.old_nick || '—'}» → «${r.new_nick || '—'}» — ${r.changed_by} — ${fdt(r.at)}`);
        await dump('ЗАЯВКИ НА ВСТУПЛЕНИЕ', 'SELECT * FROM applications WHERE discord_id = ? ORDER BY id', [did],
          (r) => `#${r.id} — ${r.name} (№ ${r.static}), LVL ${r.lvl} — ${statusLabel(r.status)} — ${fdt(r.created_at)}${r.reject_reason ? ` — причина: ${r.reject_reason}` : ''}${r.accepted_by ? ` — принял ${r.accepted_by}` : ''}${r.rejected_by ? ` — отклонил ${r.rejected_by}` : ''}`);
        await dump('ЗАЯВКИ НА ДОБАВЛЕНИЕ ПАСПОРТА', 'SELECT * FROM passport_requests WHERE discord_id = ? ORDER BY id', [did],
          (r) => `#${r.id} — ${r.name} (№ ${r.static}) — ${statusLabel(r.status)} — ${fdt(r.created_at)}${r.reject_reason ? ` — ${r.reject_reason}` : ''}`);
        await dump('ЗАЯВКИ НА ИЗМЕНЕНИЕ ДАННЫХ', 'SELECT * FROM data_change_requests WHERE discord_id = ? ORDER BY id', [did],
          (r) => `#${r.id} — № ${r.target_static}: «${r.old_name}» → «${r.new_name}» — ${statusLabel(r.status)} — ${fdt(r.created_at)}${r.reject_reason ? ` — ${r.reject_reason}` : ''}`);
        await dump('ЗАЯВКИ НА ОТПУСК (самостоятельные)', 'SELECT * FROM vacations WHERE discord_id = ? ORDER BY id', [did],
          (r) => `#${r.id} — до ${fdt(r.until)} — ${statusLabel(r.status)} — ${fdt(r.created_at)}${r.reason ? ` — ${r.reason}` : ''}${r.reject_reason ? ` — отказ: ${r.reject_reason}` : ''}`);

        const everStatics = new Set(passports.map((p) => p.static));
        for (const e of await db.all('SELECT DISTINCT static FROM membership_events WHERE discord_id = ?', [did])) everStatics.add(e.static);
        if (everStatics.size > 0) {
          const ph = [...everStatics].map(() => '?').join(',');
          await dump('ЗАЯВКИ НА УВОЛЬНЕНИЕ', `SELECT * FROM kicks WHERE target_static IN (${ph}) ORDER BY id`, [...everStatics],
            (r) => `#${r.id} — ${r.name} (№ ${r.target_static}) — ${statusLabel(r.status)} — ${fdt(r.created_at)}${r.reason ? ` — ${r.reason}` : ''}${r.reject_reason ? ` — отказ: ${r.reject_reason}` : ''}`);
        }

        await dump('КОНТРАКТЫ', "SELECT * FROM contracts WHERE discord_id = ? ORDER BY submitted_at", [did],
          (r) => `${statusLabel(r.status)} — ${fdt(r.submitted_at)}${r.reviewed_by ? ` — проверил ${r.reviewed_by} (${fdt(r.reviewed_at)})` : ''} — ${r.message_url || '—'}`);
        await dump('ПРИГЛАШЕНИЯ (кого пригласил)', "SELECT * FROM invitations WHERE inviter_discord_id = ? ORDER BY id", [did],
          (r) => `${r.invitee_name} (№ ${r.invitee_static}), id ${r.invitee_discord_id} — ${r.status} — вступил ${fdt(r.joined_at)}`);
        await dump('ПРИГЛАШЕНИЯ (кем приглашён)', "SELECT * FROM invitations WHERE invitee_discord_id = ? ORDER BY id", [did],
          (r) => `пригласил ${r.inviter_discord_id} — ${r.status} — вступил ${fdt(r.joined_at)}`);
        await dump('ПРИЁМ ЗАЯВОК (как заявитель)', "SELECT * FROM acceptances WHERE applicant_discord_id = ? ORDER BY id", [did],
          (r) => `принял ${r.staff_discord_id} — ${r.status} — вступил ${fdt(r.joined_at)}`);
        await dump('ПРИЁМ ЗАЯВОК (как HR — кого принял)', "SELECT * FROM acceptances WHERE staff_discord_id = ? ORDER BY id", [did],
          (r) => `${r.applicant_name} (№ ${r.applicant_static}), id ${r.applicant_discord_id} — ${r.status} — вступил ${fdt(r.joined_at)}`);
        await dump('КОДОВЫЕ СЛОВА', "SELECT * FROM codeword_submissions WHERE discord_id = ? ORDER BY id", [did],
          (r) => `#${r.id} — ${r.status}${r.reviewed_by ? ` (проверил ${r.reviewed_by})` : ''} — ${fdt(r.submitted_at)}`);
        await dump('АПЕЛЛЯЦИИ НА ЧС', "SELECT * FROM appeals WHERE discord_id = ? ORDER BY id", [did],
          (r) => `#${r.id} — ${r.status} — ${fdt(r.created_at)}${r.reject_reason ? ` — ${r.reject_reason}` : ''}`);
        await dump('ТИКЕТЫ (открыл)', "SELECT * FROM tickets WHERE opener_id = ? ORDER BY id", [did],
          (r) => `#${r.id} [${TICKET_CAT_LABEL[r.category] || '—'}] «${r.subject || '—'}» — ${r.status} — ${fdt(r.created_at)}${r.rating != null ? ` — оценка ${r.rating ? '👍' : '👎'}` : ''}`);
        await dump('ЧЁРНЫЙ СПИСОК', "SELECT * FROM blacklist WHERE discord_id = ? ORDER BY id", [did],
          (r) => `№ ${r.static || '—'} — ${r.reason || 'без причины'} — внёс ${r.added_by} — ${fdt(r.created_at)}${r.until ? ` — до ${fdt(r.until)}` : ' — навсегда'}${r.appeal_blocked ? ' — АПЕЛЛЯЦИИ ЗАПРЕЩЕНЫ' : ''}`);
        await dump('АУДИТ (действия этого человека, последние 100)', "SELECT * FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT 100", [did],
          (r) => `${fdt(r.at)} — ${r.action} — ${r.details}`);

        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const file = new AttachmentBuilder(Buffer.concat([bom, Buffer.from(L.join('\n'), 'utf8')]), { name: `profile_${did}.txt` });
        await logAudit(guild, interaction.user, 'Экспорт профиля человека', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чей профиль', value: `<@${did}> | ${target.name} (№ ${target.static})`, inline: true },
        ]);
        await interaction.editReply({ content: `Профиль ${target.name} (№ ${target.static}):`, files: [file] });
        return;
      }

      if (cmd === 'заявки_скорость') {
        if (!(await checkCommandAccess('заявки_скорость', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const rows = await db.all(
          `SELECT status, accepted_by, rejected_by, created_at, reviewed_at FROM applications
           WHERE reviewed_at IS NOT NULL AND created_at >= ? AND status IN ('accepted','rejected')`,
          [since],
        );
        if (rows.length === 0) {
          await interaction.editReply(`За последние ${days} дн. нет рассмотренных заявок с отметкой времени (эта статистика ведётся с момента установки функции).`);
          return;
        }

        const fmtDur = (ms) => {
          const totalMin = Math.round(ms / 60000);
          const d = Math.floor(totalMin / 1440);
          const h = Math.floor((totalMin % 1440) / 60);
          const m = totalMin % 60;
          return [d ? `${d}д` : '', h ? `${h}ч` : '', (m || (!d && !h)) ? `${m}м` : ''].filter(Boolean).join(' ');
        };

        const per = new Map();
        for (const r of rows) {
          const reviewer = r.accepted_by || r.rejected_by;
          if (!reviewer) continue;
          const ms = new Date(r.reviewed_at).getTime() - new Date(r.created_at).getTime();
          if (!(ms >= 0)) continue;
          const cur = per.get(reviewer) || { count: 0, totalMs: 0, accepted: 0, rejected: 0, fastest: Infinity, slowest: 0 };
          cur.count += 1;
          cur.totalMs += ms;
          cur.fastest = Math.min(cur.fastest, ms);
          cur.slowest = Math.max(cur.slowest, ms);
          if (r.status === 'accepted') cur.accepted += 1; else cur.rejected += 1;
          per.set(reviewer, cur);
        }
        if (per.size === 0) {
          await interaction.editReply(`За последние ${days} дн. нет пригодных данных.`);
          return;
        }

        const sorted = [...per.entries()].sort((a, b) => b[1].count - a[1].count);
        const lines = sorted.map(([reviewer, s], i) =>
          `${i + 1}. <@${reviewer}> — рассмотрено **${s.count}** (✅ ${s.accepted} / ❌ ${s.rejected})\n` +
          `   среднее: **${fmtDur(s.totalMs / s.count)}**, быстрее всего: ${fmtDur(s.fastest)}, дольше всего: ${fmtDur(s.slowest)}`,
        );
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`⏱️ Скорость рассмотрения заявок за ${days} дн.`)
          .setDescription(lines.join('\n\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'импорт_участники') {
        if (!(await checkCommandAccess('импорт_участники', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        const attachment = interaction.options.getAttachment('файл');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let text;
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = Buffer.from(await res.arrayBuffer()).toString('utf8');
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось скачать файл: ${err.message}`);
          return;
        }

        let records;
        try {
          records = parseCsvObjects(text);
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось разобрать CSV: ${err.message}`);
          return;
        }
        if (records.length === 0) {
          await interaction.editReply('⛔ В файле нет строк данных (или нет строки-заголовка).');
          return;
        }
        const header = Object.keys(records[0]);
        if (!header.includes('discord_id') || !header.includes('name') || !header.includes('static')) {
          await interaction.editReply('⛔ В заголовке CSV нужны минимум колонки `discord_id`, `name`, `static` (формат как у `participants.csv` из `/экспорт_бд`).');
          return;
        }

        const toAdd = [];
        const skipped = [];
        const seenIds = new Set();
        const seenStatics = new Set();
        for (const rec of records) {
          const discordId = (rec.discord_id || '').trim();
          const name = normalizeName(rec.name || '');
          const staticValue = (rec.static || '').trim();
          if (!discordId || !name || !staticValue) { skipped.push(`${name || '—'} / ${staticValue || '—'} — нет обязательных полей`); continue; }
          if (!isSnowflake(discordId)) { skipped.push(`${name} (№ ${staticValue}) — Discord ID не похож на настоящий`); continue; }
          if (!isValidStatic(staticValue)) { skipped.push(`${name} (${staticValue}) — № паспорта не число`); continue; }
          if (seenIds.has(discordId) || seenStatics.has(staticValue)) { skipped.push(`${name} (№ ${staticValue}) — дубль внутри файла`); continue; }
          if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [discordId])) { skipped.push(`${name} (№ ${staticValue}) — этот Discord ID уже в списке`); continue; }
          if (await passportsLib.isStaticTaken(staticValue)) { skipped.push(`${name} (№ ${staticValue}) — № паспорта уже занят`); continue; }

          const rawRole = (rec.role_id || '').trim();
          const roleId = config.ROLE_IDS.includes(rawRole) ? rawRole : config.ROLE_APPLY;
          let joinedAt = new Date().toISOString();
          if (rec.joined_at && !Number.isNaN(Date.parse(rec.joined_at))) joinedAt = new Date(rec.joined_at).toISOString();

          seenIds.add(discordId);
          seenStatics.add(staticValue);
          toAdd.push({
            discord_id: discordId,
            name,
            static: staticValue,
            lvl: parseInt(rec.lvl, 10) || 0,
            skills: rec.skills || '',
            online: rec.online || '',
            role_id: roleId,
            joined_at: joinedAt,
          });
        }

        if (toAdd.length === 0) {
          await interaction.editReply(`Добавлять нечего. Пропущено строк: ${skipped.length}.\n${skipped.slice(0, 20).join('\n').slice(0, 1800)}`);
          return;
        }

        const importId = Math.random().toString(36).slice(2, 10);
        pendingImports.set(importId, { rows: toAdd, skipped, by: interaction.user.id });
        if (pendingImports.size > 50) pendingImports.delete(pendingImports.keys().next().value);

        const preview = toAdd.slice(0, 15).map((r) => `• ${r.name} (№ ${r.static}) — <@${r.discord_id}>`).join('\n');
        await interaction.editReply({
          content:
            `Готово к импорту: **${toAdd.length}**. Пропущено при разборе: **${skipped.length}**.\n\n${preview}${toAdd.length > 15 ? `\n…и ещё ${toAdd.length - 15}` : ''}\n\n` +
            `Каждому: запись в БД + роль ранга + ник + приватный канал-профиль + запись в историю. Займёт ~${Math.ceil(toAdd.length * 0.8)} сек.`,
          components: [row(
            new ButtonBuilder().setCustomId(`import_confirm:${importId}`).setLabel('✅ Импортировать').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`import_cancel:${importId}`).setLabel('❌ Отмена').setStyle(ButtonStyle.Secondary),
          )],
        });
        return;
      }

      if (cmd === 'тикеты') {
        if (!(await checkCommandAccess('тикеты', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const open = await db.all("SELECT * FROM tickets WHERE status = 'open' ORDER BY id DESC");
        if (open.length === 0) {
          await interaction.editReply('Открытых тикетов нет.');
          return;
        }
        const lines = open.map((t) => `<#${t.channel_id}> — [${TICKET_CAT_LABEL[t.category] || '—'}] «${t.subject || '—'}» от <@${t.opener_id}>${t.assigned_to ? `, у <@${t.assigned_to}>` : ', никто не взял'}, открыт ${formatDateTime(new Date(t.created_at))}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🎫 Открытые тикеты (${open.length})`).setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'чс_апелляция') {
        if (!(await checkCommandAccess('чс_апелляция', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('человек');
        const state = interaction.options.getString('состояние'); // 'on' = разрешить, 'off' = запретить
        const blocked = state === 'off' ? 1 : 0;
        const res = await db.run('UPDATE blacklist SET appeal_blocked = ? WHERE discord_id = ?', [blocked, targetUser.id]);
        if (!res || res.changes === 0) {
          await interaction.editReply('У этого человека нет записей в чёрном списке.');
          return;
        }
        await logAudit(guild, interaction.user, blocked ? 'Апелляции на ЧС запрещены' : 'Апелляции на ЧС снова разрешены', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${targetUser.id}> | ${targetUser.tag}`, inline: true },
        ]);
        await interaction.editReply(blocked ? `🔒 <@${targetUser.id}> больше не сможет подавать апелляцию.` : `✅ <@${targetUser.id}> снова может подавать апелляцию.`);
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

        await logAudit(guild, interaction.user, 'Экспорт базы данных', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Таблиц с данными', value: `${files.length} из ${tables.length}`, inline: true },
        ]);

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

      if (cmd === 'причины_отказа') {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({
          content: 'Шаблоны причин отказа — выберите очередь:',
          components: [row(
            new ButtonBuilder().setCustomId('rejtpl_q:application').setLabel('Вступление').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('rejtpl_q:kick').setLabel('Увольнение').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('rejtpl_q:vacation').setLabel('Отпуск').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('rejtpl_q:blacklist').setLabel('Чёрный список').setStyle(ButtonStyle.Primary),
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (cmd === 'faq') {
        if (!(await checkCommandAccess('faq', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const query = interaction.options.getString('запрос');
        await interaction.editReply(await runFaqSearch(interaction.member, query));
        return;
      }

      if (cmd === 'faq_отзывы') {
        if (!(await checkCommandAccess('faq_отзывы', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rows = await db.all(
          `SELECT e.id, e.title, e.category,
                  COALESCE(SUM(CASE WHEN f.helpful = 1 THEN 1 ELSE 0 END), 0) AS up,
                  COALESCE(SUM(CASE WHEN f.helpful = 0 THEN 1 ELSE 0 END), 0) AS down
           FROM faq_entries e
           JOIN faq_feedback f ON f.entry_id = e.id
           GROUP BY e.id
           ORDER BY down DESC, up ASC`,
        );
        if (rows.length === 0) {
          await interaction.editReply('Отзывов по гайдам пока нет.');
          return;
        }
        const catLabel = { member: 'участники', hr: 'HR', public: 'общий' };
        const lines = rows.map((r) => `${r.down > 0 ? '⚠️ ' : ''}«${r.title}» (${catLabel[r.category] || r.category}) — 👍 ${r.up} / 👎 ${r.down}`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📊 Отзывы по гайдам FAQ').setDescription(lines.join('\n').slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'сравнить_недели') {
        if (!(await checkCommandAccess('сравнить_недели', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const na = interaction.options.getInteger('неделя_а') ?? 0;
        const nb = interaction.options.getInteger('неделя_б') ?? 1;
        const a = await weekSummaryForCompare(na);
        const b = await weekSummaryForCompare(nb);
        const rowFor = (name, av, bv) => {
          const delta = av - bv;
          const sign = delta > 0 ? `+${delta}` : String(delta);
          return { name, value: `A: **${av}**  ·  B: **${bv}**  ·  Δ ${delta === 0 ? '0' : sign}`, inline: false };
        };
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 Сравнение недель')
          .setDescription(`**A** — ${a.label}\n**B** — ${b.label}`)
          .addFields(
            rowFor('✅ Контракты выполнены', a.fulfilled, b.fulfilled),
            rowFor('❌ Контракты не выполнены', a.unfulfilled, b.unfulfilled),
            rowFor('📨 Подтверждённые приглашения', a.invites, b.invites),
            rowFor('✅ Заявки приняты', a.accepted, b.accepted),
            rowFor('❌ Заявки отклонены', a.rejected, b.rejected),
            rowFor('🚫 Увольнения', a.kicks, b.kicks),
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'выплаты_hr') {
        if (!(await checkCommandAccess('выплаты_hr', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 7;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const { rows, total } = await computeHrPayouts(guild, since);
        if (rows.length === 0) {
          await interaction.editReply(`За последние ${days} дн. никто не перешагнул порог 3 дня — выплат нет.`);
          return;
        }
        const lines = rows.map((r) => {
          const who = r.name ? `${r.name}, № ${r.static}` : `<@${r.staffId}>`;
          return `${who} | принятых: ${r.count} | ${formatMoney(r.sum)} (${r.isHr ? 'HR' : 'не HR'}, ${formatMoney(r.perHead)}/чел.)`;
        });
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(`💰 Выплаты за принятых (пробыли 3+ дня) — ${days} дн.`)
          .setDescription(lines.join('\n').slice(0, 4000))
          .setFooter({ text: `Итого к выплате: ${formatMoney(total)}` });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'воронка_найма') {
        if (!(await checkCommandAccess('воронка_найма', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const apps = await db.all('SELECT status, discord_id FROM applications WHERE created_at >= ?', [since]);
        const total = apps.length;
        const accepted = apps.filter((a) => a.status === 'accepted').length;
        const rejected = apps.filter((a) => a.status === 'rejected').length;
        const pending = apps.filter((a) => a.status === 'pending').length;
        const acc = await db.all("SELECT applicant_discord_id, status FROM acceptances WHERE joined_at >= ?", [since]);
        const stayed = acc.filter((a) => a.status === 'confirmed').length;
        const leftEarly = acc.filter((a) => a.status === 'disqualified').length;
        let stillHere = 0;
        for (const a of acc) {
          if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [a.applicant_discord_id])) stillHere += 1;
        }
        const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🧲 Воронка найма за ${days} дн.`)
          .addFields(
            { name: 'Заявок подано', value: String(total), inline: true },
            { name: 'Принято', value: `${accepted} (${pct(accepted, total)})`, inline: true },
            { name: 'Отклонено / в очереди', value: `${rejected} / ${pending}`, inline: true },
            { name: 'Досидело 3+ дня', value: `${stayed} (${pct(stayed, accepted)} от принятых)`, inline: true },
            { name: 'Ушли раньше 3 дней', value: String(leftEarly), inline: true },
            { name: 'Всё ещё в организации', value: `${stillHere} (${pct(stillHere, accepted)} от принятых)`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === 'статистика_hr') {
        if (!(await checkCommandAccess('статистика_hr', interaction.member))) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const days = interaction.options.getInteger('дней') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const staffIds = new Set();
        for (const t of [
          "SELECT DISTINCT accepted_by AS x FROM applications WHERE status = 'accepted' AND accepted_by IS NOT NULL AND created_at >= ?",
          "SELECT DISTINCT staff_discord_id AS x FROM acceptances WHERE staff_discord_id IS NOT NULL AND COALESCE(resolved_at, joined_at) >= ?",
          "SELECT DISTINCT reviewed_by AS x FROM contracts WHERE reviewed_by IS NOT NULL AND reviewed_at >= ?",
          "SELECT DISTINCT closed_by AS x FROM tickets WHERE closed_by IS NOT NULL AND closed_at >= ?",
        ]) {
          for (const r of await db.all(t, [since])) if (r.x) staffIds.add(r.x);
        }
        if (staffIds.size === 0) {
          await interaction.editReply(`За последние ${days} дн. активности HR не найдено.`);
          return;
        }

        const one = async (sql, id) => (await db.get(sql, [id, since])).c;
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`👔 Статистика HR за ${days} дн.`);
        const parts = [];
        for (const id of staffIds) {
          const acceptedCnt = await one("SELECT COUNT(*) AS c FROM applications WHERE accepted_by = ? AND status = 'accepted' AND created_at >= ?", id);
          const stayedCnt = await one("SELECT COUNT(*) AS c FROM acceptances WHERE staff_discord_id = ? AND status = 'confirmed' AND COALESCE(resolved_at, joined_at) >= ?", id);
          const droppedCnt = await one("SELECT COUNT(*) AS c FROM acceptances WHERE staff_discord_id = ? AND status = 'disqualified' AND COALESCE(resolved_at, joined_at) >= ?", id);
          const contractsCnt = await one("SELECT COUNT(*) AS c FROM contracts WHERE reviewed_by = ? AND status IN ('fulfilled','unfulfilled','rejected') AND reviewed_at >= ?", id);
          const ticketsCnt = await one("SELECT COUNT(*) AS c FROM tickets WHERE closed_by = ? AND status = 'archived' AND closed_at >= ?", id);
          const up = await one("SELECT COUNT(*) AS c FROM tickets WHERE closed_by = ? AND rating = 1 AND closed_at >= ?", id);
          const down = await one("SELECT COUNT(*) AS c FROM tickets WHERE closed_by = ? AND rating = 0 AND closed_at >= ?", id);
          parts.push({ id, acceptedCnt, stayedCnt, droppedCnt, contractsCnt, ticketsCnt, up, down });
        }
        parts.sort((a, b) => (b.acceptedCnt + b.contractsCnt + b.ticketsCnt) - (a.acceptedCnt + a.contractsCnt + a.ticketsCnt));
        for (const p of parts) {
          embed.addFields({
            name: '​',
            value:
              `<@${p.id}>\n` +
              `Принято заявок: **${p.acceptedCnt}** · удержано 3+ дн.: **${p.stayedCnt}** · отсеялось: ${p.droppedCnt}\n` +
              `Проверено контрактов: **${p.contractsCnt}** · закрыто тикетов: **${p.ticketsCnt}** (👍 ${p.up} / 👎 ${p.down})`,
          });
        }
        await interaction.editReply({ embeds: [embed] });
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

        await logAudit(guild, interaction.user, 'Рассылка правил', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: query ? `Одному: ${targets[0].name}` : 'Всем участникам', inline: true },
          { name: 'Отправлено', value: query ? '1/1' : `${sent}/${targets.length}`, inline: true },
        ]);
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

      if (id === 'magic_link_request') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return sendMagicLinkDM(interaction);
      }

      if (id.startsWith('formsub_ok:') || id.startsWith('formsub_no:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав рассматривать заявки.');
        const approve = id.startsWith('formsub_ok:');
        const sid = id.split(':')[1];
        const s = await db.get('SELECT * FROM form_submissions WHERE id = ?', [sid]);
        if (!s) return safeReply(interaction, 'Заявка не найдена.');
        if (s.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const f = await db.get('SELECT name FROM forms WHERE id = ?', [s.form_id]).catch(() => null);
        await db.run('UPDATE form_submissions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
          [approve ? 'approved' : 'rejected', interaction.user.id, new Date().toISOString(), sid]);
        try {
          await notify(s.discord_id, 'form', approve
            ? `Ваша заявка по форме «${(f && f.name) || 'форма'}» принята.`
            : `Ваша заявка по форме «${(f && f.name) || 'форма'}» отклонена.`, '/me');
        } catch (_) {}
        try { await interaction.message.edit({ components: [] }); } catch (_) {}
        await logAudit(guild, interaction.user, 'Заявка по форме рассмотрена', [
          { name: 'Заявка', value: `#${sid} «${(f && f.name) || ''}»`, inline: true },
          { name: 'Итог', value: approve ? '✅ принято' : '❌ отклонено', inline: true },
          { name: 'Автор', value: `<@${s.discord_id}>`, inline: true },
        ]);
        return safeReply(interaction, approve ? '✅ Заявка принята, автор уведомлён.' : '❌ Заявка отклонена, автор уведомлён.');
      }

      if (id.startsWith('review_claim:') || id.startsWith('review_unclaim:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав рассматривать заявки.');
        const claiming = id.startsWith('review_claim:');
        const [, type, rowId] = id.split(':');
        const table = REVIEW_TABLES[type];
        if (!table) return safeReply(interaction, 'Неизвестная очередь.');
        const rec = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [rowId]);
        if (!rec || rec.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        if (claiming && rec.assigned_to && rec.assigned_to !== interaction.user.id) {
          return safeReply(interaction, `⛔ Заявку уже взял(а) <@${rec.assigned_to}>. Пусть освободит, либо снимите через Владельца/Зам. Владельца.`);
        }
        if (!claiming && rec.assigned_to && rec.assigned_to !== interaction.user.id && !perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ Освободить может тот, кто взял, или Владелец/Зам. Владелец.');
        }

        const newAssignee = claiming ? interaction.user.id : null;
        await db.run(
          `UPDATE ${table} SET assigned_to = ?, assigned_at = ? WHERE id = ?`,
          [newAssignee, claiming ? new Date().toISOString() : null, rowId],
        );

        try {
          const srcEmbed = interaction.message.embeds[0];
          const rebuilt = EmbedBuilder.from(srcEmbed);
          const keptFields = (srcEmbed.fields || []).filter((f) => f.name !== '🙋 Рассматривает');
          if (newAssignee) keptFields.push({ name: '🙋 Рассматривает', value: `<@${newAssignee}>`, inline: true });
          rebuilt.setFields(keptFields);
          const otherEmbeds = interaction.message.embeds.slice(1).map((e) => EmbedBuilder.from(e));

          // Пробегаем по СЫРЫМ компонентам сообщения (у них есть геттер
          // .customId), а не по билдерам из ActionRowBuilder.from() — у тех
          // .customId нет, из-за чего кнопка «Беру» раньше не превращалась
          // в «Освободить».
          const rebuiltComponents = interaction.message.components.map((r) => {
            const nr = new ActionRowBuilder();
            for (const c of r.components) {
              const cid = c.customId || (c.data && c.data.custom_id);
              if (cid && (cid.startsWith('review_claim:') || cid.startsWith('review_unclaim:'))) {
                nr.addComponents(
                  newAssignee
                    ? new ButtonBuilder().setCustomId(`review_unclaim:${type}:${rowId}`).setLabel('↩️ Освободить').setStyle(ButtonStyle.Secondary)
                    : new ButtonBuilder().setCustomId(`review_claim:${type}:${rowId}`).setLabel('🙋 Беру на рассмотрение').setStyle(ButtonStyle.Primary),
                );
              } else {
                nr.addComponents(ButtonBuilder.from(c));
              }
            }
            return nr;
          });

          await interaction.update({ embeds: [rebuilt, ...otherEmbeds], components: rebuiltComponents });
        } catch (err) {
          console.error('Не удалось обновить карточку рассмотрения (claim):', err.message);
          await safeReply(interaction, claiming ? '✅ Взяли на рассмотрение.' : '↩️ Освободили.');
        }

        await logAudit(guild, interaction.user, claiming ? 'Заявка взята на рассмотрение' : 'Заявка освобождена', [
          { name: 'Кто', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Очередь', value: type, inline: true },
          { name: '№', value: `#${rowId}`, inline: true },
        ]);
        return;
      }

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
        await notify(contract.discord_id, 'contract',
          status === 'fulfilled' ? 'Ваш контракт проверен и засчитан ✅'
            : status === 'unfulfilled' ? 'Ваш контракт проверен — не выполнен ❌'
              : 'Скриншот не засчитан как контракт 🚫', '/me');

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

        let passportInfo = await db.get('SELECT name, static FROM participants WHERE profile_thread_id = ?', [contract.thread_id]);
        if (!passportInfo) {
          passportInfo = await db.get('SELECT name, static FROM extra_passports WHERE profile_thread_id = ?', [contract.thread_id]);
        }
        const cardLink = contract.thread_id && contract.review_message_id
          ? `[Карточка контракта](https://discord.com/channels/${guild.id}/${contract.thread_id}/${contract.review_message_id})`
          : (contract.message_url ? `[Скриншот](${contract.message_url})` : '—');

        await logAudit(
          guild,
          interaction.user,
          `Контракт: ${label}`,
          [
            { name: 'Кто проверил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Чей контракт', value: `<@${contract.discord_id}> | ${passportInfo ? `${passportInfo.name} (№ ${passportInfo.static})` : '—'}`, inline: true },
            { name: 'Канал', value: contract.thread_id ? `<#${contract.thread_id}>` : '—', inline: true },
            { name: 'Ссылка', value: cardLink, inline: false },
          ],
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
            new ButtonBuilder().setCustomId('faq_add_category:public').setLabel('Общий (для всех)').setStyle(ButtonStyle.Primary),
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
            new ButtonBuilder().setCustomId(`faq_${action}_category:public`).setLabel('Общий (для всех)').setStyle(ButtonStyle.Primary),
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
        await logAudit(guild, interaction.user, 'Гайд FAQ удалён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Категория', value: category, inline: true },
          { name: 'Заголовок', value: entry ? entry.title : entryId, inline: true },
        ]);
        await interaction.update({ content: '✅ Гайд удалён.', components: [] });
        return;
      }

      if (id === 'faq_delete_cancel') {
        await interaction.update({ content: '❌ Отменено.', components: [] });
        return;
      }

      if (id === 'faq_search') {
        const modal = new ModalBuilder().setCustomId('modal_faq_search').setTitle('Поиск по гайдам FAQ');
        modal.addComponents(row(txt(null, 'query', 'Что искать (ключевые слова)')));
        return interaction.showModal(modal);
      }

      if (id === 'faq_reorder') {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        return safeReply(interaction, {
          content: 'Порядок гайдов какого канала менять?',
          components: [row(
            new ButtonBuilder().setCustomId('faq_reorder_cat:member').setLabel('Участники').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('faq_reorder_cat:hr').setLabel('HR-Менеджеры').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('faq_reorder_cat:public').setLabel('Общий (для всех)').setStyle(ButtonStyle.Primary),
          )],
        });
      }

      if (id.startsWith('faq_reorder_cat:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const category = id.split(':')[1];
        return safeReply(interaction, await faqReorderPanel(category, null));
      }

      if (id.startsWith('faq_move:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const [, category, entryId, direction] = id.split(':');
        await faq.moveEntry(entryId, direction === 'up' ? 'up' : 'down');
        await faqDisplay.safeUpdateFaqChannel(guild, category);
        await logAudit(guild, interaction.user, 'Порядок гайда FAQ изменён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Категория', value: category, inline: true },
          { name: 'Направление', value: direction === 'up' ? 'выше' : 'ниже', inline: true },
        ]);
        const panel = await faqReorderPanel(category, entryId);
        try { return await interaction.update(panel); } catch (_) { return safeReply(interaction, panel); }
      }

      if (id.startsWith('faq_helpful:')) {
        const [, entryId, valStr] = id.split(':');
        const helpful = valStr === '1' ? 1 : 0;
        await db.run('DELETE FROM faq_feedback WHERE entry_id = ? AND discord_id = ?', [entryId, interaction.user.id]);
        await db.run('INSERT INTO faq_feedback (entry_id, discord_id, helpful, at) VALUES (?, ?, ?, ?)', [entryId, interaction.user.id, helpful, new Date().toISOString()]);
        return safeReply(interaction, helpful ? '🙏 Спасибо! Рады, что помогло.' : '📝 Спасибо за отзыв — передадим, что гайд стоит доработать.');
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

        await logAudit(guild, interaction.user, 'Рассылка сообщения', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: scope === 'all' ? `Всем (${sent}/${targets.length})` : `Одному: <@${pending.targetId}>`, inline: true },
          { name: 'Текст', value: pending.text.slice(0, 1024), inline: false },
        ]);
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

        // В чёрном списке — вместо отказа предлагаем подать апелляцию
        const blRows = await db.all('SELECT * FROM blacklist WHERE discord_id = ?', [interaction.user.id]);
        if (blRows.length > 0) {
          if (blRows.some((r) => r.appeal_blocked)) {
            return safeReply(interaction, '⛔ Вы находитесь в чёрном списке организации, и подача апелляции для вас закрыта.');
          }
          const openAppeal = await db.get("SELECT * FROM appeals WHERE discord_id = ? AND status = 'pending'", [interaction.user.id]);
          if (openAppeal) {
            return safeReply(interaction, '⛔ Вы в чёрном списке. Ваша апелляция уже на рассмотрении — дождитесь ответа.');
          }
          return safeReply(interaction, {
            content: '⛔ Вы находитесь в чёрном списке организации и не можете подать заявку на вступление.\n\nЕсли считаете это ошибкой — подайте апелляцию:',
            components: [row(new ButtonBuilder().setCustomId('appeal_open').setLabel('📝 Подать апелляцию').setStyle(ButtonStyle.Danger))],
          });
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
        await logAudit(guild, interaction.user, 'Отпуск отменён участником', [
          { name: 'Кто отменил', value: `<@${discordId}>`, inline: true },
        ]);
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
        await notify(v.discord_id, 'vacation', `Отпуск одобрен до ${formatDateTime(new Date(v.until))}`, '/me');
        await logAudit(guild, interaction.user, 'Отпуск одобрен', [
          { name: 'Кто одобрил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${v.discord_id}> | № ${vId}`, inline: true },
          { name: 'До какого числа', value: formatDateTime(new Date(v.until)), inline: true },
        ]);
        return safeReply(interaction, 'Отпуск одобрен.');
      }

      if (id.startsWith('vacation_reject:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const vId = id.split(':')[1];
        const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
        if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return sendRejectPicker(interaction, 'vacation', vId);
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
        await logAudit(guild, interaction.user, 'Данные изменены по заявке', [
          { name: 'Кто одобрил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому изменили', value: `<@${reqRow.discord_id}> | № ${reqRow.target_static}`, inline: true },
          { name: 'Имя Фамилия до', value: reqRow.old_name, inline: true },
          { name: 'Имя Фамилия после', value: reqRow.new_name, inline: true },
        ]);
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
        try { web.invalidateAccess(reqRow.discord_id); } catch (_) {}
        await db.run('UPDATE hr_applications SET status = ? WHERE id = ?', ['accepted', reqId]);

        await refreshReviewMessage(
          interaction.channel,
          reqRow.message_id,
          buildHrApplyEmbed({ ...reqRow, status: 'accepted' }),
          [],
          actionSummary(interaction.user.id, '✅ Принято'),
        );
        await dmUser(guild, reqRow.discord_id, '✅ Ваша заявка на роль HR-Менеджера принята!');
        await logAudit(guild, interaction.user, 'Заявка на HR принята', [
          { name: 'Кто принял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого принял', value: `<@${reqRow.discord_id}> | № ${reqId}`, inline: true },
        ]);
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
        await notify(reqRow.discord_id, 'passport', `Добавлен паспорт: ${reqRow.name} (№ ${reqRow.static})`, '/me');
        await logAudit(guild, interaction.user, 'Паспорт добавлен по заявке', [
          { name: 'Кто одобрил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому добавили', value: `<@${reqRow.discord_id}> | ${reqRow.name}, № ${reqRow.static}`, inline: true },
        ]);
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
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app) return safeReply(interaction, 'Заявка не найдена.');
        if (app.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return sendRejectPicker(interaction, 'application', appId);
      }

      if (id.startsWith('rej_preset:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const [, queue, rowId, tplId] = id.split(':');
        const fn = REJECT_APPLY[queue];
        if (!fn) return safeReply(interaction, '⛔ Неизвестная очередь.');
        const tpl = await db.get('SELECT text FROM reject_reason_templates WHERE id = ?', [tplId]);
        if (!tpl) return safeReply(interaction, '⛔ Шаблон не найден (мог быть удалён) — используйте «Своя причина».');
        try { await interaction.update({ content: '⏳ Отклоняю…', components: [] }); } catch (_) {}
        return fn(interaction, guild, rowId, tpl.text);
      }

      if (id.startsWith('rej_custom:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const [, queue, rowId] = id.split(':');
        const modalId = REJECT_MODAL_ID[queue];
        if (!modalId) return safeReply(interaction, '⛔ Неизвестная очередь.');
        return interaction.showModal(buildRejectReasonModal(`${modalId}:${rowId}`));
      }

      if (id.startsWith('rejtpl_q:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const queue = id.split(':')[1];
        if (!REJECT_QUEUE_LABEL[queue]) return safeReply(interaction, 'Неизвестная очередь.');
        const panel = await rejtplPanel(queue);
        try { return await interaction.update(panel); } catch (_) { return safeReply(interaction, panel); }
      }

      if (id.startsWith('rejtpl_add:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const queue = id.split(':')[1];
        if (!REJECT_QUEUE_LABEL[queue]) return safeReply(interaction, 'Неизвестная очередь.');
        const modal = new ModalBuilder().setCustomId(`modal_rejtpl_add:${queue}`).setTitle('Новый шаблон причины');
        modal.addComponents(row(txt(null, 'text', 'Текст причины', { paragraph: true, maxLength: 300 })));
        return interaction.showModal(modal);
      }

      if (id.startsWith('rejtpl_edit:') || id.startsWith('rejtpl_del:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const action = id.startsWith('rejtpl_edit:') ? 'edit' : 'del';
        const queue = id.split(':')[1];
        const templates = await getRejectTemplates(queue);
        if (templates.length === 0) return safeReply(interaction, 'Шаблонов нет.');
        const select = new StringSelectMenuBuilder()
          .setCustomId(`select_rejtpl_${action}:${queue}`)
          .setPlaceholder(action === 'edit' ? 'Какой шаблон изменить' : 'Какой шаблон удалить')
          .addOptions(templates.map((t) => new StringSelectMenuOptionBuilder().setLabel(t.text.slice(0, 100)).setValue(String(t.id))));
        return safeReply(interaction, { components: [row(select)] });
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
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k || k.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        return sendRejectPicker(interaction, 'kick', kickId);
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
        if (!already && (await giveaways.isBlacklisted(interaction.user.id))) {
          return safeReply(interaction, '⛔ Вы в ЧС розыгрышей — участвовать не можете.');
        }
        if (!already && giveaway.required_role_id && !interaction.member.roles.cache.has(giveaway.required_role_id)) {
          return safeReply(interaction, `⛔ Участвовать может только роль <@&${giveaway.required_role_id}>.`);
        }
        if (!already && giveaway.min_role_id && !giveaways.meetsMinRole(interaction.member, giveaway.min_role_id)) {
          return safeReply(interaction, `⛔ Участвовать могут роли не ниже <@&${giveaway.min_role_id}>.`);
        }
        if (!already && giveaway.min_contracts_week) {
          const wr = contracts.getWeekRange(0);
          const cw = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status='fulfilled' AND submitted_at BETWEEN ? AND ?", [interaction.user.id, wr.start.toISOString(), wr.end.toISOString()]).then((x) => (x ? x.c : 0)).catch(() => 0);
          if (cw < giveaway.min_contracts_week) {
            return safeReply(interaction, `⛔ Нужно ≥ ${giveaway.min_contracts_week} выполненных контрактов за эту неделю (у вас ${cw}).`);
          }
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
        const label = already ? 'Выход из розыгрыша' : 'Участие в розыгрыше';
        await logAudit(guild, interaction.user, label, [
          { name: 'Розыгрыш', value: giveaway.message_id ? `[Ссылка на розыгрыш](https://discord.com/channels/${guild.id}/${giveaway.channel_id}/${giveaway.message_id})` : '—', inline: true },
          { name: 'Приз', value: giveaway.prize, inline: true },
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
        ]);
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
            const newRow = new ActionRowBuilder();
            for (const c of r.components) {
              const cid = c.customId || (c.data && c.data.custom_id);
              const btn = ButtonBuilder.from(c);
              if (cid === id) btn.setDisabled(true).setLabel('✅ Уведомление отправлено');
              newRow.addComponents(btn);
            }
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
        await logAudit(guild, interaction.user, 'AFK снят по уведомлению о возврате', [
          { name: 'Кто снял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'У кого', value: `<@${discordId}> | ${passport.name} (№ ${staticValue})`, inline: true },
        ]);

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

      if (id.startsWith('upload_db_confirm:')) {
        if (!(await checkCommandAccess('резерв_загрузить', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const tempId = id.split(':')[1];
        const pending = pendingDbUploads.get(tempId);
        if (!pending) {
          return safeReply(interaction, '⛔ Эта загрузка устарела или уже обработана — выполните `/резерв_загрузить` заново.');
        }
        pendingDbUploads.delete(tempId);

        await interaction.update({ content: '⏳ Делаю резервную копию текущей базы и заменяю...', embeds: [], components: [] });
        try {
          const backupPath = backup.backupNow();
          if (backupPath) {
            await uploadBackupFile(backupPath, `перед загрузкой новой базы, инициатор ${interaction.user.tag}`);
          }
          fs.copyFileSync(pending.path, db.dbPath);
          fs.unlinkSync(pending.path);
          await logAudit(guild, interaction.user, '⚠️ База данных заменена загруженным файлом', [
            { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Примечание', value: backupPath ? 'Резервная копия прежней базы сделана и отправлена в канал бэкапов. Требуется перезапуск бота.' : '⚠️ Не удалось сделать резервную копию перед заменой! Требуется перезапуск бота.', inline: false },
          ]);
          await interaction.editReply('✅ База данных заменена загруженным файлом.\n\n⚠️ **Перезапустите бота вручную (Restart на Bothost) прямо сейчас**, чтобы изменения точно применились.');
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось заменить базу: ${err.message}`);
        }
        return;
      }

      if (id.startsWith('upload_db_cancel:')) {
        const tempId = id.split(':')[1];
        const pending = pendingDbUploads.get(tempId);
        if (pending) {
          try { fs.unlinkSync(pending.path); } catch (_) {}
          pendingDbUploads.delete(tempId);
        }
        return interaction.update({ content: '❌ Загрузка отменена.', embeds: [], components: [] });
      }

      if (id.startsWith('import_confirm:')) {
        if (!(await checkCommandAccess('импорт_участники', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const importId = id.split(':')[1];
        const pending = pendingImports.get(importId);
        if (!pending) return safeReply(interaction, '⛔ Импорт устарел — запустите `/импорт_участники` заново.');
        pendingImports.delete(importId);
        await interaction.update({ content: `⏳ Импортирую ${pending.rows.length}…`, components: [] });

        let added = 0;
        const failed = [];
        for (const r of pending.rows) {
          try {
            if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [r.discord_id])) { failed.push(`${r.name} — Discord ID уже появился в списке`); continue; }
            if (await passportsLib.isStaticTaken(r.static)) { failed.push(`${r.name} — № ${r.static} уже занят`); continue; }

            let discordTag = r.discord_id;
            try { const m = await guild.members.fetch(r.discord_id); discordTag = m.user.tag; } catch (_) {}

            await db.run(
              `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [r.discord_id, discordTag, r.name, r.static, r.lvl, r.skills, r.online, r.role_id, r.joined_at],
            );
            try {
              const m = await guild.members.fetch(r.discord_id);
              await m.roles.add(r.role_id).catch(() => {});
            } catch (_) {}
            await syncEffectiveIdentity(guild, r.discord_id);
            await history.logJoined(r.discord_id, r.static, r.name, 'Импорт из CSV', r.joined_at);
            await createProfileThread(guild, r.discord_id, r.name, r.static);
            added += 1;
            await sleep(700);
          } catch (err) {
            failed.push(`${r.name} (№ ${r.static}) — ${err.message}`);
          }
        }
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Импорт участников из CSV', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Добавлено', value: String(added), inline: true },
          { name: 'Пропущено при разборе', value: String(pending.skipped.length), inline: true },
          { name: 'Ошибок при вставке', value: String(failed.length), inline: true },
        ]);
        let msg = `✅ Импорт завершён. Добавлено: **${added}** из ${pending.rows.length}.`;
        if (failed.length) msg += `\n\n⚠️ Не удалось (${failed.length}):\n${failed.slice(0, 12).join('\n')}`;
        if (pending.skipped.length) msg += `\n\nПропущено при разборе файла (${pending.skipped.length}):\n${pending.skipped.slice(0, 12).join('\n')}`;
        await interaction.editReply(msg.slice(0, 2000));
        return;
      }

      if (id.startsWith('import_cancel:')) {
        pendingImports.delete(id.split(':')[1]);
        return interaction.update({ content: '❌ Импорт отменён.', components: [] });
      }

      if (id === 'ticket_open') {
        const openExisting = await db.get("SELECT * FROM tickets WHERE opener_id = ? AND status = 'open' AND (category IS NULL OR category != 'appeal')", [interaction.user.id]);
        if (openExisting) {
          return safeReply(interaction, `У вас уже есть открытый тикет: <#${openExisting.channel_id}>. Закройте его, прежде чем открывать новый.`);
        }
        return safeReply(interaction, {
          content: 'Выберите тип обращения:',
          components: [row(
            new ButtonBuilder().setCustomId('ticket_new:question').setLabel('❓ Вопрос').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ticket_new:complaint').setLabel('⚠️ Жалоба').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('ticket_new:other').setLabel('📋 Другое').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ticket_new:bug').setLabel('🐞 Баг на сайте').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ticket_new:bug_discord').setLabel('🐞 Баг Discord').setStyle(ButtonStyle.Secondary),
          )],
        });
      }

      if (id.startsWith('ticket_new:')) {
        const cat = id.split(':')[1];
        if (!TICKET_CAT_LABEL[cat] || cat === 'appeal') return safeReply(interaction, 'Неизвестный тип.');
        const openExisting = await db.get("SELECT * FROM tickets WHERE opener_id = ? AND status = 'open' AND (category IS NULL OR category != 'appeal')", [interaction.user.id]);
        if (openExisting) return safeReply(interaction, `У вас уже есть открытый тикет: <#${openExisting.channel_id}>.`);
        const modal = new ModalBuilder().setCustomId(`modal_ticket_open:${cat}`).setTitle(`Тикет — ${TICKET_CAT_LABEL[cat]}`);
        modal.addComponents(
          row(txt(null, 'subject', 'Тема (кратко)', { maxLength: 100 })),
          row(txt(null, 'description', 'Опишите подробнее', { paragraph: true, required: false, maxLength: 2000 })),
        );
        return interaction.showModal(modal);
      }

      if (id === 'appeal_open') {
        const blRows = await db.all('SELECT * FROM blacklist WHERE discord_id = ?', [interaction.user.id]);
        if (blRows.length === 0) return safeReply(interaction, 'Вы не в чёрном списке — апелляция не нужна.');
        if (blRows.some((r) => r.appeal_blocked)) return safeReply(interaction, '⛔ Вам запрещено подавать апелляцию на чёрный список.');
        const openAppeal = await db.get("SELECT * FROM appeals WHERE discord_id = ? AND status = 'pending'", [interaction.user.id]);
        if (openAppeal) return safeReply(interaction, 'Ваша апелляция уже на рассмотрении — дождитесь ответа.');
        const modal = new ModalBuilder().setCustomId('modal_appeal_open').setTitle('Апелляция на чёрный список');
        modal.addComponents(row(txt(null, 'text', 'Почему вас нужно убрать из ЧС', { paragraph: true, maxLength: 2000 })));
        return interaction.showModal(modal);
      }

      if (id.startsWith('appeal_accept:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ Решать апелляции может только Владелец/Зам. Владелец.');
        const appealId = id.split(':')[1];
        const a = await db.get('SELECT * FROM appeals WHERE id = ?', [appealId]);
        if (!a || a.status !== 'pending') return safeReply(interaction, 'Апелляция уже обработана.');
        const removed = await db.run('DELETE FROM blacklist WHERE discord_id = ?', [a.discord_id]);
        await db.run("UPDATE appeals SET status = 'accepted', resolved_by = ?, resolved_at = ? WHERE id = ?", [interaction.user.id, new Date().toISOString(), appealId]);
        await safeUpdateBlacklist(guild);
        await refreshReviewMessage(interaction.channel, a.message_id, appealReviewEmbed({ ...a, status: 'accepted' }, []), [], actionSummary(interaction.user.id, '✅ ЧС снят'));
        await dmUser(guild, a.discord_id, '✅ Ваша апелляция принята — вы убраны из чёрного списка организации.');
        await notify(a.discord_id, 'appeal', 'Апелляция принята — вы убраны из чёрного списка', '/me');
        await logAudit(guild, interaction.user, 'Апелляция ЧС принята', [
          { name: 'Кто принял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${a.discord_id}>`, inline: true },
          { name: 'Удалено записей ЧС', value: String(removed ? removed.changes : 0), inline: true },
        ]);
        return safeReply(interaction, 'Апелляция принята, человек убран из ЧС.');
      }

      if (id.startsWith('appeal_reject:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ Решать апелляции может только Владелец/Зам. Владелец.');
        const appealId = id.split(':')[1];
        const a = await db.get('SELECT * FROM appeals WHERE id = ?', [appealId]);
        if (!a || a.status !== 'pending') return safeReply(interaction, 'Апелляция уже обработана.');
        return interaction.showModal(buildRejectReasonModal(`modal_appeal_reject:${appealId}`));
      }

      if (id.startsWith('codeword_ok:') || id.startsWith('codeword_no:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ Подтверждать кодовые слова может только Владелец/Зам. Владелец.');
        const approve = id.startsWith('codeword_ok:');
        const subId = id.split(':')[1];
        const sub = await db.get('SELECT * FROM codeword_submissions WHERE id = ?', [subId]);
        if (!sub || sub.status !== 'pending') return safeReply(interaction, 'Эта заявка уже обработана.');
        await db.run(
          'UPDATE codeword_submissions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
          [approve ? 'approved' : 'rejected', interaction.user.id, new Date().toISOString(), subId],
        );
        try {
          const base = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(approve ? 0x57f287 : 0xed4245)
            .setFooter({ text: `Заявка #${subId} — ${approve ? 'подтверждена' : 'отклонена'} ${interaction.user.tag}` });
          await interaction.update({ embeds: [base], components: [] });
        } catch (_) {
          await safeReply(interaction, approve ? '✅ Подтверждено.' : '❌ Отклонено.');
        }
        await logAudit(guild, interaction.user, approve ? 'Кодовое слово подтверждено' : 'Кодовое слово отклонено', [
          { name: 'Кто проверил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Отправитель', value: `<@${sub.discord_id}>${sub.name ? ` | ${sub.name} (№ ${sub.static})` : ''}`, inline: true },
        ]);
        return;
      }

      if (id.startsWith('appeal_block:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ Управлять этим может только Владелец/Зам. Владелец.');
        const targetId = id.split(':')[1];
        const res = await db.run('UPDATE blacklist SET appeal_blocked = 1 WHERE discord_id = ?', [targetId]);
        if (!res || res.changes === 0) return safeReply(interaction, 'У этого человека нет записей в ЧС.');
        await db.run("UPDATE appeals SET status = 'rejected', reject_reason = 'Апелляции запрещены', resolved_by = ?, resolved_at = ? WHERE discord_id = ? AND status = 'pending'", [interaction.user.id, new Date().toISOString(), targetId]);
        await logAudit(guild, interaction.user, 'Апелляции на ЧС запрещены', [
          { name: 'Кто запретил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${targetId}>`, inline: true },
        ]);
        return safeReply(interaction, `🔒 <@${targetId}> больше не сможет подавать апелляцию.`);
      }

      if (id.startsWith('ticket_claim:') || id.startsWith('ticket_unclaim:')) {
        if (!perms.canReview(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const claiming = id.startsWith('ticket_claim:');
        const ticketId = id.split(':')[1];
        const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
        if (!ticket || ticket.status !== 'open') return safeReply(interaction, 'Тикет уже закрыт.');
        if (claiming && ticket.assigned_to && ticket.assigned_to !== interaction.user.id) {
          return safeReply(interaction, `⛔ Тикет уже взял(а) <@${ticket.assigned_to}>.`);
        }
        if (!claiming && ticket.assigned_to !== interaction.user.id && !perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ Освободить может тот, кто взял, или Владелец/Зам. Владелец.');
        }
        const newAssignee = claiming ? interaction.user.id : null;
        await db.run('UPDATE tickets SET assigned_to = ?, assigned_at = ? WHERE id = ?', [newAssignee, claiming ? new Date().toISOString() : null, ticketId]);
        try {
          const src = interaction.message.embeds[0];
          const rebuilt = EmbedBuilder.from(src);
          const fields = (src.fields || []).filter((f) => f.name !== '🙋 Рассматривает');
          if (newAssignee) fields.push({ name: '🙋 Рассматривает', value: `<@${newAssignee}>`, inline: true });
          rebuilt.setFields(fields);
          await interaction.update({ embeds: [rebuilt], components: [ticketButtonsRow(ticketId, newAssignee)] });
        } catch (e) {
          await safeReply(interaction, claiming ? '✅ Взяли тикет.' : '↩️ Освободили.');
        }
        await logAudit(guild, interaction.user, claiming ? 'Тикет взят на рассмотрение' : 'Тикет освобождён', [
          { name: 'Кто', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Тикет', value: `#${ticketId} — <#${ticket.channel_id}>`, inline: true },
        ]);
        return;
      }

      if (id.startsWith('ticket_close:')) {
        const ticketId = id.split(':')[1];
        const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
        if (!ticket) return safeReply(interaction, 'Тикет не найден.');
        if (ticket.status !== 'open') return safeReply(interaction, 'Тикет уже закрыт.');
        if (interaction.user.id !== ticket.opener_id && !perms.canReview(interaction.member)) {
          return safeReply(interaction, '⛔ Закрыть тикет может автор или руководство.');
        }
        return safeReply(interaction, {
          content: 'Закрыть тикет? Канал уедет в архивную категорию, у автора пропадёт доступ.',
          components: [row(
            new ButtonBuilder().setCustomId(`ticket_close_confirm:${ticketId}`).setLabel('🔒 Да, закрыть').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('ticket_close_cancel').setLabel('Отмена').setStyle(ButtonStyle.Secondary),
          )],
        });
      }

      if (id === 'ticket_close_cancel') {
        return interaction.update({ content: '❌ Отменено.', components: [] });
      }

      if (id.startsWith('ticket_close_confirm:')) {
        const ticketId = id.split(':')[1];
        const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
        if (!ticket) return safeReply(interaction, 'Тикет не найден.');
        if (ticket.status !== 'open') return safeReply(interaction, 'Тикет уже закрыт.');
        if (interaction.user.id !== ticket.opener_id && !perms.canReview(interaction.member)) {
          return safeReply(interaction, '⛔ Закрыть тикет может автор или руководство.');
        }
        try { await interaction.update({ content: '⏳ Закрываю…', components: [] }); } catch (_) {}

        try {
          const channel = await guild.channels.fetch(ticket.channel_id);
          await channel.permissionOverwrites.edit(ticket.opener_id, { ViewChannel: false, SendMessages: false }).catch(() => {});
          await channel.setParent(config.CHANNEL_TICKETS_ARCHIVE_CATEGORY, { lockPermissions: false }).catch(() => {});
          if (!channel.name.startsWith('закрыт-')) {
            await channel.setName(`закрыт-${channel.name}`.slice(0, 100)).catch(() => {});
          }
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription(`🔒 Тикет закрыт — <@${interaction.user.id}>, ${formatDateTime(new Date())}`)] }).catch(() => {});
        } catch (err) {
          console.error('Не удалось заархивировать канал тикета:', err.message);
        }

        await db.run("UPDATE tickets SET status = 'archived', closed_at = ?, closed_by = ? WHERE id = ?", [new Date().toISOString(), interaction.user.id, ticketId]);
        await logAudit(guild, interaction.user, 'Тикет закрыт', [
          { name: 'Кто закрыл', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Автор', value: `<@${ticket.opener_id}>`, inline: true },
          { name: 'Тема', value: ticket.subject || '—', inline: true },
        ]);
        // Просим автора оценить обращение
        await dmUser(guild, ticket.opener_id, {
          content: `Ваш тикет «${ticket.subject || '—'}» закрыт. Помогло ли обращение?`,
          components: [row(
            new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:1`).setLabel('👍 Помогло').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`ticket_rate:${ticketId}:0`).setLabel('👎 Не помогло').setStyle(ButtonStyle.Secondary),
          )],
        });
        return safeReply(interaction, '🔒 Тикет закрыт и перемещён в архив.');
      }

      if (id.startsWith('ticket_rate:')) {
        const [, ticketId, valStr] = id.split(':');
        const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
        if (!ticket) return safeReply(interaction, 'Тикет не найден.');
        if (interaction.user.id !== ticket.opener_id) return safeReply(interaction, '⛔ Оценить может только автор тикета.');
        const rating = valStr === '1' ? 1 : 0;
        await db.run('UPDATE tickets SET rating = ?, rated_at = ? WHERE id = ?', [rating, new Date().toISOString(), ticketId]);
        try { await interaction.update({ content: rating ? '🙏 Спасибо за оценку!' : '📝 Спасибо, передадим руководству.', components: [] }); } catch (_) {
          await safeReply(interaction, 'Спасибо за оценку!');
        }
        return;
      }

      if (id.startsWith('restore_confirm:')) {
        if (!(await checkCommandAccess('резерв_восстановить', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const filename = id.split(':')[1];
        await interaction.update({ content: '⏳ Восстанавливаю...', embeds: [], components: [] });
        try {
          backup.restoreFromBackup(filename);
          await logAudit(guild, interaction.user, '⚠️ База данных восстановлена из резервной копии', [
            { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Файл', value: filename, inline: true },
            { name: 'Примечание', value: 'Требуется перезапуск бота.', inline: false },
          ]);
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

      if (id.startsWith('audit_search_page:')) {
        if (!(await checkCommandAccess('аудит_поиск', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const [, searchId, pageStr] = id.split(':');
        const query = auditSearchCache.get(searchId);
        if (!query) {
          return safeReply(interaction, '⛔ Этот поиск устарел — выполните `/аудит_поиск` заново.');
        }
        const page = parseInt(pageStr, 10);
        await interaction.deferUpdate();
        const { embed, hasMore } = await runAuditSearch(query, page);
        await interaction.editReply({ embeds: [embed], components: buildAuditSearchComponents(searchId, page, hasMore) });
        return;
      }

      if (id === 'oauth_enter_code') {
        if (!(await checkCommandAccess('discord_права_настроить', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        const modal = new ModalBuilder().setCustomId('modal_oauth_code').setTitle('Код авторизации Discord');
        modal.addComponents(row(txt(null, 'code', 'Код из адресной строки (после code=)')));
        return interaction.showModal(modal);
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

      if (id === 'blacklist_add' || id === 'blacklist_add_nodiscord') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const variant = id === 'blacklist_add_nodiscord' ? 'nd' : 'd';
        const templates = await getRejectTemplates('blacklist');
        if (templates.length === 0) {
          return interaction.showModal(variant === 'nd' ? buildBlacklistAddNoDiscordModal() : buildBlacklistAddModal());
        }
        const buttons = templates.slice(0, 20).map((t) =>
          new ButtonBuilder().setCustomId(`bl_reason:${variant}:${t.id}`).setLabel(t.text.slice(0, 80)).setStyle(ButtonStyle.Secondary),
        );
        buttons.push(new ButtonBuilder().setCustomId(`bl_reason:${variant}:custom`).setLabel('✏️ Своя причина').setStyle(ButtonStyle.Primary));
        const rows = [];
        for (let i = 0; i < buttons.length && rows.length < 5; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
        return safeReply(interaction, { content: 'Причина внесения в ЧС — выберите шаблон или «Своя причина»:', components: rows });
      }

      if (id.startsWith('bl_reason:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const [, variant, tpl] = id.split(':');
        let reason = '';
        if (tpl !== 'custom') {
          const tplRow = await db.get('SELECT text FROM reject_reason_templates WHERE id = ?', [tpl]);
          reason = tplRow ? tplRow.text : '';
        }
        return interaction.showModal(variant === 'nd' ? buildBlacklistAddNoDiscordModal(reason) : buildBlacklistAddModal(reason));
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
        await logAudit(guild, interaction.user, 'Удаление из ЧС', [
          { name: 'Кто убрал', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Записи', value: `#${ids.join(', #')}`, inline: true },
          { name: 'Причина', value: reason || '—', inline: false },
        ]);
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

        await logAudit(guild, interaction.user, typeLabels[type], [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Паспорт удалён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${discordId}> | № ${staticValue}`, inline: true },
        ]);
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

        let removedPassportInfo = await db.get('SELECT name, static FROM participants WHERE profile_thread_id = ?', [contract.thread_id]);
        if (!removedPassportInfo) {
          removedPassportInfo = await db.get('SELECT name, static FROM extra_passports WHERE profile_thread_id = ?', [contract.thread_id]);
        }
        const removedCardLink = contract.thread_id && contract.review_message_id
          ? `[Карточка контракта](https://discord.com/channels/${guild.id}/${contract.thread_id}/${contract.review_message_id})`
          : (contract.message_url ? `[Скриншот](${contract.message_url})` : '—');

        await logAudit(guild, interaction.user, 'Контракт удалён вручную', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чей контракт', value: `<@${discordId}> | ${removedPassportInfo ? `${removedPassportInfo.name} (№ ${removedPassportInfo.static})` : '—'}`, inline: true },
          { name: 'Канал', value: contract.thread_id ? `<#${contract.thread_id}>` : '—', inline: true },
          { name: 'Было', value: contract.status, inline: true },
          { name: 'Ссылка', value: removedCardLink, inline: false },
        ]);
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
        await logAudit(guild, interaction.user, 'Приглашение удалено вручную', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Пригласитель', value: `<@${inviterId}>`, inline: true },
          { name: 'Приглашённый', value: `<@${invite.invitee_discord_id}>`, inline: true },
          { name: 'Было', value: invite.status, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Отпуск снят', [
          { name: 'Кто снял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'У кого', value: `<@${discordId}> | ${removedNames.join(', ')}`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'AFK снят', [
          { name: 'Кто снял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'У кого', value: `<@${discordId}> | ${removedNames.join(', ')}`, inline: true },
        ]);
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
        return safeReply(interaction, {
          embeds: [embed],
          components: [row(
            new ButtonBuilder().setCustomId(`faq_helpful:${entry.id}:1`).setLabel('👍 Помогло').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`faq_helpful:${entry.id}:0`).setLabel('👎 Не помогло').setStyle(ButtonStyle.Secondary),
          )],
        });
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

      if (customId.startsWith('select_faq_reorder:')) {
        if (!perms.canManageFaq(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав управлять гайдами FAQ.');
        const category = customId.split(':')[1];
        const panel = await faqReorderPanel(category, interaction.values[0]);
        try { return await interaction.update(panel); } catch (_) { return safeReply(interaction, panel); }
      }

      if (customId.startsWith('select_rejtpl_edit:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const queue = customId.split(':')[1];
        const tplId = interaction.values[0];
        const tpl = await db.get('SELECT * FROM reject_reason_templates WHERE id = ?', [tplId]);
        if (!tpl) return safeReply(interaction, 'Шаблон не найден.');
        const modal = new ModalBuilder().setCustomId(`modal_rejtpl_edit:${tplId}:${queue}`).setTitle('Изменить шаблон причины');
        modal.addComponents(row(txt(null, 'text', 'Текст причины', { value: tpl.text, paragraph: true, maxLength: 300 })));
        return interaction.showModal(modal);
      }

      if (customId.startsWith('select_rejtpl_del:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const queue = customId.split(':')[1];
        const tplId = interaction.values[0];
        await db.run('DELETE FROM reject_reason_templates WHERE id = ?', [tplId]);
        const remaining = await db.all('SELECT id FROM reject_reason_templates WHERE queue = ? ORDER BY position, id', [queue]);
        for (let i = 0; i < remaining.length; i++) {
          await db.run('UPDATE reject_reason_templates SET position = ? WHERE id = ?', [i, remaining[i].id]);
        }
        await logAudit(guild, interaction.user, 'Шаблон причины отказа удалён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Очередь', value: REJECT_QUEUE_LABEL[queue] || queue, inline: true },
        ]);
        return safeReply(interaction, await rejtplPanel(queue));
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
          await logAudit(guild, interaction.user, 'Право команды сброшено', [
            { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Команда', value: `/${commandName}`, inline: true },
            { name: 'Новый уровень', value: tierLabel(defaultTier), inline: true },
          ]);
          await syncOneCommandPermissions(guild, commandName);
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
        await logAudit(guild, interaction.user, 'Право команды изменено', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Команда', value: `/${commandName}`, inline: true },
          { name: 'Новый уровень', value: tierLabel(chosen), inline: true },
        ]);
        await syncOneCommandPermissions(guild, commandName);
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
        await logAudit(guild, interaction.user, 'Право команды изменено', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Команда', value: `/${commandName}`, inline: true },
          { name: 'Новый уровень', value: `Только <@${chosenUserId}>`, inline: true },
        ]);
        await syncOneCommandPermissions(guild, commandName);
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
        const updatedRoles = []; // {name, static, oldRoleId, newRoleId} — для структурированного аудита
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
          updatedRoles.push({ name: p.name, static: p.static, oldRoleId: p.role_id, newRoleId });
        }

        if (updated.length === 0) {
          return safeReply(interaction, `Ничего не изменено.${skipped.length ? `\n${skipped.join('\n')}` : ''}`);
        }

        await syncEffectiveIdentity(guild, discordId);
        await safeUpdateMembersList(guild);
        const actionLabel = action === 'promote' ? 'Повышение' : 'Понижение';
        const whoLabel = action === 'promote' ? 'Кто повысил' : 'Кто понизил';
        const whomLabel = action === 'promote' ? 'Кого повысил' : 'Кого понизил';
        const beforeLabel = action === 'promote' ? 'Ранг до повышения' : 'Ранг до понижения';
        const afterLabel = action === 'promote' ? 'Ранг после повышения' : 'Ранг после понижения';
        for (const r of updatedRoles) {
          await logAudit(guild, interaction.user, actionLabel, [
            { name: whoLabel, value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: whomLabel, value: `<@${discordId}> | ${r.name} (№ ${r.static})`, inline: true },
            { name: beforeLabel, value: `<@&${r.oldRoleId}>`, inline: true },
            { name: afterLabel, value: `<@&${r.newRoleId}>`, inline: true },
          ]);
        }
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

        await logAudit(guild, interaction.user, 'Заявка на изменение данных', [
          { name: 'Подал заявку', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ заявки', value: `#${reqRow.id}`, inline: true },
          { name: 'Имя Фамилия до', value: passport.name, inline: true },
          { name: 'Имя Фамилия после', value: newName, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Заявка на изменение данных отклонена', [
          { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чья заявка', value: `<@${reqRow.discord_id}> | № ${reqId}`, inline: true },
          { name: 'Причина', value: reason, inline: false },
        ]);
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

        await logAudit(guild, interaction.user, 'Новая заявка на роль HR', [
          { name: 'Подал заявку', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ заявки', value: `#${reqRow.id}`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Заявка на HR отклонена', [
          { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чья заявка', value: `<@${reqRow.discord_id}> | № ${reqId}`, inline: true },
          { name: 'Причина', value: reason, inline: false },
        ]);
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

        await logAudit(guild, interaction.user, 'Заявка на добавление паспорта', [
          { name: 'Подал заявку', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ заявки', value: `#${reqRow.id}`, inline: true },
          { name: 'Имя Фамилия', value: `${name} (№ ${staticValue})`, inline: true },
        ]);
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

        await logAudit(guild, interaction.user, 'Новая заявка на вступление', [
          { name: 'Подал заявку', value: `<@${app.discord_id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ заявки', value: `#${app.id}`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Заявка на паспорт отклонена', [
          { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чья заявка', value: `<@${reqRow.discord_id}> | № ${reqId}`, inline: true },
          { name: 'Причина', value: reason, inline: false },
        ]);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      // Отказ в заявке на вступление — своя причина (шаблонные — через кнопки apply_reject_preset)
      if (id.startsWith('modal_apply_reject:')) {
        const appId = id.split(':')[1];
        return applyApplicationRejection(interaction, guild, appId, get('reason'));
      }

      // Отказ в заявке на увольнение — с причиной
      if (id.startsWith('modal_kick_reject:')) {
        return applyKickRejection(interaction, guild, id.split(':')[1], get('reason'));
      }

      // Отказ в заявке на отпуск — с причиной
      if (id.startsWith('modal_vacation_reject:')) {
        return applyVacationRejection(interaction, guild, id.split(':')[1], get('reason'));
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
        await logAudit(guild, interaction.user, 'Заявка изменена', [
          { name: 'Кто отредактировал', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ заявки', value: `#${appId}`, inline: true },
        ]);
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
        await db.run('UPDATE applications SET status = ?, accepted_by = ?, reviewed_at = ? WHERE id = ?', ['accepted', interaction.user.id, new Date().toISOString(), appId]);
        await acceptances.recordAcceptance(interaction.user.id, app.discord_id, fields.name, fields.static, new Date().toISOString());

        try {
          const member = await guild.members.fetch(app.discord_id);
          await member.roles.add([config.ROLE_APPLY, config.ROLE_ORGANIZATION].filter(Boolean));
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
        await notify(app.discord_id, 'apply', 'Ваша заявка на вступление принята — добро пожаловать!', '/me');
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
        await logAudit(guild, interaction.user, 'Заявка принята', [
          { name: 'Кто принял', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого принял', value: `<@${app.discord_id}> | № ${appId}`, inline: true },
        ]);
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

        await logAudit(guild, interaction.user, 'Новая заявка на увольнение', [
          { name: 'Подал заявку', value: `<@${k.discord_id}> | ${interaction.user.tag}`, inline: true },
          { name: 'На кого', value: `${k.name}${k.target_static !== 'all' ? ` (паспорт № ${k.target_static})` : ' (все паспорта)'}`, inline: true },
          { name: '№ заявки', value: `#${k.id}`, inline: true },
        ]);
        try {
          const tgt = k.target_static !== 'all'
            ? await db.get('SELECT discord_id FROM participants WHERE static = ?', [k.target_static])
            : await db.get('SELECT discord_id FROM participants WHERE name = ?', [k.name]);
          if (tgt && tgt.discord_id) await notify(tgt.discord_id, 'kick', 'На вас подана заявка на увольнение — руководство её рассматривает', '/me');
        } catch (_) {}
        return safeReply(interaction, 'Заявка на увольнение отправлена на рассмотрение.');
      }

      // Редактирование заявки на увольнение
      if (id.startsWith('modal_kick_edit:')) {
        const kickId = id.split(':')[1];
        await db.run('UPDATE kicks SET name = ?, target_static = ?, reason = ? WHERE id = ?', [normalizeName(get('name')), get('target_static') || 'all', get('reason') || '', kickId]);
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        await refreshReviewMessage(interaction.channel, k.message_id, await kickReviewEmbed(k), kickReviewComponents(k), actionSummary(interaction.user.id, '✏️ Изменено'));
        await logAudit(guild, interaction.user, 'Заявка на увольнение изменена', [
          { name: 'Кто отредактировал', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ заявки', value: `#${kickId}`, inline: true },
        ]);
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
          [
            { name: 'Кто уволил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Кого уволил', value: `«${name}»${targetStatic !== 'all' ? ` (паспорт № ${targetStatic})` : ''}`, inline: true },
            { name: '№ заявки', value: `#${kickId}`, inline: true },
            { name: 'Причина', value: reason || '—', inline: false },
          ],
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
        await logAudit(guild, interaction.user, 'Участник добавлен вручную', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого добавили', value: `${fields.name} (${hasDiscord ? `<@${fields.discord_id}>` : 'без Discord'})`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Данные участника изменены', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому изменили', value: `${fields.name} (<@${fields.discord_id}>)`, inline: true },
        ]);
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
          [
            { name: 'Кто уволил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
            { name: 'Кого уволил', value: `<@${discordId}> | ${participant.name}${scope !== 'all' ? ` (паспорт № ${scope})` : ''}`, inline: true },
            { name: 'Причина', value: reason || '—', inline: false },
          ],
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
        await logAudit(guild, interaction.user, 'Паспорт добавлен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${discordId}> | ${name} (№ ${staticValue})`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Гайд FAQ добавлен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Категория', value: category, inline: true },
          { name: 'Заголовок', value: title, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Гайд FAQ изменён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Категория', value: entry.category, inline: true },
          { name: 'Заголовок', value: title, inline: true },
        ]);
        return safeReply(interaction, 'Гайд обновлён.');
      }

      if (id.startsWith('modal_rejtpl_add:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const queue = id.split(':')[1];
        const text = get('text').trim();
        if (!text) return safeReply(interaction, 'Пустой текст — ничего не добавлено.');
        const cnt = (await db.get('SELECT COUNT(*) AS c FROM reject_reason_templates WHERE queue = ?', [queue])).c;
        await db.run('INSERT INTO reject_reason_templates (queue, text, position, created_at) VALUES (?, ?, ?, ?)', [queue, text, cnt, new Date().toISOString()]);
        await logAudit(guild, interaction.user, 'Шаблон причины отказа добавлен', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Очередь', value: REJECT_QUEUE_LABEL[queue] || queue, inline: true },
          { name: 'Текст', value: text.slice(0, 1024), inline: false },
        ]);
        return safeReply(interaction, await rejtplPanel(queue));
      }

      if (id.startsWith('modal_rejtpl_edit:')) {
        if (!(await checkCommandAccess('причины_отказа', interaction.member))) return safeReply(interaction, '⛔ У вас нет прав.');
        const [, tplId, queue] = id.split(':');
        const text = get('text').trim();
        if (!text) return safeReply(interaction, 'Пустой текст — не изменено.');
        await db.run('UPDATE reject_reason_templates SET text = ? WHERE id = ?', [text, tplId]);
        await logAudit(guild, interaction.user, 'Шаблон причины отказа изменён', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Очередь', value: REJECT_QUEUE_LABEL[queue] || queue, inline: true },
          { name: 'Новый текст', value: text.slice(0, 1024), inline: false },
        ]);
        return safeReply(interaction, await rejtplPanel(queue));
      }

      if (id === 'modal_oauth_code') {
        if (!(await checkCommandAccess('discord_права_настроить', interaction.member))) {
          return safeReply(interaction, '⛔ У вас нет прав.');
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let code = get('code').trim();
        // На случай, если вставили весь URL целиком, а не только код
        const codeMatch = code.match(/[?&]code=([^&\s]+)/);
        if (codeMatch) code = codeMatch[1];

        try {
          await commandPermSync.exchangeCode(code, interaction.user.id);
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось обменять код: ${err.message}`);
          return;
        }

        await logSystem(guild, 'Настроена синхронизация видимости команд с Discord', `Инициатор: ${interaction.user.tag} (${interaction.user.id}). Авторизация пройдена, запускаю первичную синхронизацию.`);
        await interaction.editReply('✅ Авторизация прошла успешно. Применяю видимость ко всем командам, это может занять минуту...');

        const result = await syncAllCommandPermissions(guild);
        await db.setSetting('command_perm_last_sync', new Date().toISOString());
        let msg = `✅ Готово. Синхронизировано команд: ${result.ok}.`;
        if (result.failed.length > 0) {
          msg += `\n\n⚠️ Не удалось (${result.failed.length}):\n${result.failed.slice(0, 10).join('\n')}`;
        }
        msg += '\n\nТеперь при изменении прав через `/права_команд` видимость в Discord будет обновляться автоматически. Если когда-нибудь разойдётся — используйте `/discord_права_синхронизировать`.';
        await interaction.followUp({ content: msg.slice(0, 2000), flags: MessageFlags.Ephemeral });
        return;
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
        let passportName = null;
        if (staticValue) {
          const passports = await passportsLib.getAllPassports(discordId);
          const passport = passports.find((p) => p.static === staticValue);
          threadId = passport ? passport.profile_thread_id : null;
          passportName = passport ? passport.name : null;
        }

        await contracts.recordManualContract(discordId, link, submittedAt, status, interaction.user.id, threadId);
        await contractsDisplay.safeUpdateContractsStats(guild);

        const label = status === 'fulfilled' ? '✅ Выполнен' : '❌ Невыполнен';
        await logAudit(guild, interaction.user, 'Контракт добавлен вручную', [
          { name: 'Инициатор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чей контракт', value: `<@${discordId}> | ${passportName ? `${passportName} (№ ${staticValue})` : '—'}`, inline: true },
          { name: 'Канал', value: threadId ? `<#${threadId}>` : '—', inline: true },
          { name: 'Статус', value: label, inline: true },
          { name: 'Ссылка', value: `[Скриншот](${link})`, inline: false },
        ]);

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
        await logAudit(guild, interaction.user, 'Новая заявка на отпуск', [
          { name: 'Подал заявку', value: `<@${v.discord_id}> | ${interaction.user.tag}`, inline: true },
          { name: 'До какого числа', value: formatDateTime(deadline), inline: true },
          { name: '№ заявки', value: `#${v.id}`, inline: true },
        ]);
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
        await logAudit(guild, interaction.user, 'Отпуск выдан', [
          { name: 'Кто выдал', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${discordId}> | ${names}`, inline: true },
          { name: 'До какого числа', value: formatDateTime(deadline), inline: true },
          { name: 'Причина', value: reason || '—', inline: false },
        ]);
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
        await logAudit(guild, interaction.user, 'AFK выставлен', [
          { name: 'Кто выставил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кому', value: `<@${discordId}> | ${names}`, inline: true },
          { name: 'С какого числа', value: formatDateOnly(date), inline: true },
        ]);
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
        const untilRaw = (get('until') || '').trim();
        let untilIso = null;
        if (untilRaw) {
          const parsed = parseDeadline(untilRaw);
          if (!parsed) return safeReply(interaction, '⛔ Неверный формат срока. Используйте 7d или ДД.ММ.ГГГГ (дата в будущем), либо оставьте пустым для «навсегда».');
          untilIso = parsed.toISOString();
        }
        let discordTag = discordId;
        try {
          const member = await guild.members.fetch(discordId);
          discordTag = member.user.tag;
        } catch (_) {}
        await db.run(
          'INSERT INTO blacklist (discord_id, discord_tag, static, reason, added_by, created_at, until) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [discordId, discordTag, staticValue, reason, interaction.user.id, new Date().toISOString(), untilIso],
        );
        await safeUpdateBlacklist(guild);

        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (participant) {
          await removeParticipant(guild, participant, `Внесён(а) в чёрный список. Причина: ${reason || '—'}`);
        }

        await logAudit(guild, interaction.user, 'Внесение в ЧС', [
          { name: 'Кто внёс', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого', value: `<@${discordId}> | № ${staticValue || '—'}`, inline: true },
          { name: 'Причина', value: reason || '—', inline: false },
          { name: 'Срок', value: untilIso ? `до ${formatDateTime(new Date(untilIso))}` : 'навсегда', inline: true },
          ...(participant ? [{ name: 'Примечание', value: 'Участник автоматически уволен.', inline: false }] : []),
        ]);
        return safeReply(interaction, `Участник внесён в чёрный список${untilIso ? ` до ${formatDateTime(new Date(untilIso))}` : ''}.${participant ? ' Также автоматически уволен из организации.' : ''}`);
      }

      if (id === 'modal_blacklist_add_nodiscord') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const name = normalizeName(get('name')) || '';
        const staticValue = get('static');
        if (!isValidStatic(staticValue)) {
          return safeReply(interaction, '⛔ № Паспорта должен состоять только из цифр.');
        }
        const reason = get('reason') || '';
        const untilRaw = (get('until') || '').trim();
        let untilIso = null;
        if (untilRaw) {
          const parsed = parseDeadline(untilRaw);
          if (!parsed) return safeReply(interaction, '⛔ Неверный формат срока. Используйте 7d или ДД.ММ.ГГГГ (дата в будущем), либо оставьте пустым для «навсегда».');
          untilIso = parsed.toISOString();
        }
        const syntheticId = `nodiscord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tag = name || `паспорт № ${staticValue}`;

        await db.run(
          'INSERT INTO blacklist (discord_id, discord_tag, static, reason, added_by, created_at, until) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [syntheticId, tag, staticValue, reason, interaction.user.id, new Date().toISOString(), untilIso],
        );
        await safeUpdateBlacklist(guild);

        // Если человек с таким паспортом уже есть в списке людей (тоже без Discord) — увольняем его
        const participant = await db.get('SELECT * FROM participants WHERE static = ?', [staticValue]);
        if (participant) {
          await removeParticipant(guild, participant, `Внесён(а) в чёрный список. Причина: ${reason || '—'}`);
        }

        await logAudit(guild, interaction.user, 'Внесение в ЧС (без Discord)', [
          { name: 'Кто внёс', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Кого', value: `${tag} | № ${staticValue}`, inline: true },
          { name: 'Причина', value: reason || '—', inline: false },
          { name: 'Срок', value: untilIso ? `до ${formatDateTime(new Date(untilIso))}` : 'навсегда', inline: true },
          ...(participant ? [{ name: 'Примечание', value: 'Участник автоматически уволен.', inline: false }] : []),
        ]);
        return safeReply(interaction, `Внесено в чёрный список (без Discord)${untilIso ? ` до ${formatDateTime(new Date(untilIso))}` : ''}.${participant ? ' Также автоматически уволен из организации.' : ''}`);
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

      if (id === 'modal_faq_search') {
        const query = get('query').trim();
        if (!query) return safeReply(interaction, 'Пустой запрос.');
        return safeReply(interaction, await runFaqSearch(interaction.member, query));
      }

      // Создание тикета поддержки
      if (id.startsWith('modal_ticket_open:')) {
        const cat = id.split(':')[1];
        if (!TICKET_CAT_LABEL[cat] || cat === 'appeal') return safeReply(interaction, 'Неизвестный тип.');
        const subject = get('subject').trim() || 'Без темы';
        const desc = get('description').trim();
        const openExisting = await db.get("SELECT * FROM tickets WHERE opener_id = ? AND status = 'open' AND (category IS NULL OR category != 'appeal')", [interaction.user.id]);
        if (openExisting) {
          return safeReply(interaction, `У вас уже есть открытый тикет: <#${openExisting.channel_id}>.`);
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const overwrites = [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          { id: config.OWNER_USER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        for (const roleId of config.ROLES_REVIEW_ALLOWED) {
          overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        }

        let channel;
        try {
          channel = await guild.channels.create({
            name: `${TICKET_CAT_LABEL[cat].toLowerCase()}-${interaction.user.username}`.toLowerCase().replace(/[^a-zа-яё0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || `ticket-${Date.now()}`,
            type: ChannelType.GuildText,
            parent: config.CHANNEL_TICKETS_ACTIVE_CATEGORY,
            permissionOverwrites: overwrites,
            topic: `[${TICKET_CAT_LABEL[cat]}] ${subject}`.slice(0, 1000),
          });
        } catch (err) {
          await interaction.editReply(`⛔ Не удалось создать канал тикета: ${err.message}`);
          return;
        }

        const result = await db.run(
          "INSERT INTO tickets (channel_id, opener_id, subject, category, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
          [channel.id, interaction.user.id, subject, cat, new Date().toISOString()],
        );

        await channel.send({
          content: `${perms.mentionManagementRoles()} — новый тикет от <@${interaction.user.id}>`,
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🎫 ${subject}`).setDescription(desc || '_(без описания)_').addFields(
            { name: 'Автор', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Тип', value: TICKET_CAT_LABEL[cat], inline: true },
            { name: 'Открыт', value: formatDateTime(new Date()), inline: true },
          )],
          components: [ticketButtonsRow(result.lastID, null)],
          ...mentionOpts,
        });
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription('👋 Спасибо за обращение! Опишите вопрос как можно подробнее — руководство ответит в течение суток. Если 5 дней не будет активности, тикет закроется автоматически.')] }).catch(() => {});
        await db.run('UPDATE tickets SET last_activity = ? WHERE id = ?', [new Date().toISOString(), result.lastID]).catch(() => {});

        await logAudit(guild, interaction.user, 'Открыт тикет', [
          { name: 'Автор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Тип', value: TICKET_CAT_LABEL[cat], inline: true },
          { name: 'Тема', value: subject, inline: true },
          { name: 'Канал', value: `<#${channel.id}>`, inline: true },
        ]);
        await interaction.editReply(`Тикет создан: <#${channel.id}>`);
        return;
      }

      // Апелляция из ЧС — заявка уходит в канал рассмотрения апелляций
      if (id === 'modal_appeal_open') {
        const text = get('text').trim() || '(без текста)';
        const blRows = await db.all('SELECT * FROM blacklist WHERE discord_id = ?', [interaction.user.id]);
        if (blRows.length === 0) return safeReply(interaction, 'Вы не в чёрном списке — апелляция не нужна.');
        if (blRows.some((r) => r.appeal_blocked)) return safeReply(interaction, '⛔ Вам запрещено подавать апелляцию на чёрный список.');
        const openAppeal = await db.get("SELECT * FROM appeals WHERE discord_id = ? AND status = 'pending'", [interaction.user.id]);
        if (openAppeal) return safeReply(interaction, 'Ваша апелляция уже на рассмотрении — дождитесь ответа.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const insert = await db.run(
          "INSERT INTO appeals (discord_id, discord_tag, text, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
          [interaction.user.id, interaction.user.tag, text, new Date().toISOString()],
        );
        const appealRow = { id: insert.lastID, discord_id: interaction.user.id, discord_tag: interaction.user.tag, text, status: 'pending' };

        try {
          const reviewChannel = await guild.channels.fetch(config.CHANNEL_APPEAL_REVIEW);
          const sent = await reviewChannel.send({
            content: `${appealMentionRoles()} — апелляция на ЧС от <@${interaction.user.id}>`,
            embeds: [appealReviewEmbed(appealRow, blRows)],
            components: appealReviewComponents(appealRow),
            ...appealMentionOpts,
          });
          await db.run('UPDATE appeals SET message_id = ? WHERE id = ?', [sent.id, appealRow.id]);
        } catch (err) {
          console.error('Не удалось отправить апелляцию в канал рассмотрения:', err.message);
          await interaction.editReply('⛔ Не удалось отправить апелляцию (проверьте настройку канала). Обратитесь к руководству напрямую.');
          return;
        }

        await logAudit(guild, interaction.user, 'Подана апелляция на ЧС', [
          { name: 'Автор', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: '№ апелляции', value: `#${appealRow.id}`, inline: true },
        ]);
        await interaction.editReply('Апелляция отправлена на рассмотрение Владельцу/Зам. Владельцу. Ответ придёт вам в личные сообщения.');
        return;
      }

      if (id.startsWith('modal_appeal_reject:')) {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ Решать апелляции может только Владелец/Зам. Владелец.');
        const appealId = id.split(':')[1];
        const a = await db.get('SELECT * FROM appeals WHERE id = ?', [appealId]);
        if (!a || a.status !== 'pending') return safeReply(interaction, 'Апелляция уже обработана.');
        const reason = get('reason');
        await db.run("UPDATE appeals SET status = 'rejected', reject_reason = ?, resolved_by = ?, resolved_at = ? WHERE id = ?", [reason, interaction.user.id, new Date().toISOString(), appealId]);
        await refreshReviewMessage(interaction.channel, a.message_id, appealReviewEmbed({ ...a, status: 'rejected', reject_reason: reason }, null), [], actionSummary(interaction.user.id, '❌ Отклонено', reason));
        await dmUser(guild, a.discord_id, `❌ Ваша апелляция на чёрный список отклонена. Причина: ${reason}`);
        await notify(a.discord_id, 'appeal', `Апелляция отклонена. Причина: ${reason}`, '/me');
        await logAudit(guild, interaction.user, 'Апелляция ЧС отклонена', [
          { name: 'Кто отклонил', value: `<@${interaction.user.id}> | ${interaction.user.tag}`, inline: true },
          { name: 'Чья апелляция', value: `<@${a.discord_id}> | № ${appealId}`, inline: true },
          { name: 'Причина', value: reason, inline: false },
        ]);
        return safeReply(interaction, 'Апелляция отклонена.');
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

client.on('error', async (err) => {
  console.error('Ошибка клиента Discord:', err);
  try {
    if (!process.env.GUILD_ID) return;
    const errGuild = await client.guilds.fetch(process.env.GUILD_ID);
    await logSystem(errGuild, '❌ Ошибка клиента Discord', err.message);
  } catch (_) {}
});

async function notifyShutdown(reason) {
  if (!process.env.GUILD_ID) return;
  // guilds.cache вместо .fetch() — это словарь в памяти, без похода в
  // сеть, что критично именно тут: хостинг обычно даёт процессу лишь
  // несколько секунд между SIGTERM и принудительным SIGKILL, и если
  // сеть уже начала отваливаться, лишний сетевой запрос может не успеть.
  const shutdownGuild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!shutdownGuild) return;

  // Не ждём отправку сообщения бесконечно — если сеть уже недоступна,
  // лучше выйти вовремя, чем зависнуть и получить SIGKILL посреди записи в БД.
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    await Promise.race([logSystem(shutdownGuild, '🔴 Бот останавливается', reason), timeout]);
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

  // Скачиваем оба скриншота себе на диск — если исходное сообщение потом
  // удалят (случайно или специально), карточка на проверку и история
  // контракта не останутся с "битыми" картинками.
  const [takenLocalPath, completedLocalPath] = await Promise.all([
    mediaCache.downloadToCache(takenUrl, `contract-${contractId}-taken`),
    mediaCache.downloadToCache(completedUrl, `contract-${contractId}-completed`),
  ]);
  await contracts.setLocalPaths(contractId, takenLocalPath, completedLocalPath);

  // Discord позволяет только одну картинку на embed через setImage —
  // поэтому вместо ссылок показываем сами скриншоты двумя embed'ами.
  const infoEmbed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('Новый контракт на проверку')
    .addFields({ name: 'Участник', value: `<@${discordId}>` });

  const takenEmbed = new EmbedBuilder().setColor(0xfee75c).setTitle('1️⃣ Взял контракт');
  const completedEmbed = new EmbedBuilder().setColor(0xfee75c).setTitle('2️⃣ Итог');

  const files = [];
  const takenCached = mediaCache.readCached(takenLocalPath);
  if (takenCached) {
    const attachmentName = `taken${path.extname(takenLocalPath) || '.png'}`;
    files.push(new AttachmentBuilder(takenCached, { name: attachmentName }));
    takenEmbed.setImage(`attachment://${attachmentName}`);
  } else {
    takenEmbed.setImage(takenUrl); // не удалось закэшировать — используем исходную ссылку как раньше
  }
  const completedCached = mediaCache.readCached(completedLocalPath);
  if (completedCached) {
    const attachmentName = `completed${path.extname(completedLocalPath) || '.png'}`;
    files.push(new AttachmentBuilder(completedCached, { name: attachmentName }));
    completedEmbed.setImage(`attachment://${attachmentName}`);
  } else {
    completedEmbed.setImage(completedUrl);
  }

  const reviewMsg = await replyToMessage.reply({
    embeds: [infoEmbed, takenEmbed, completedEmbed],
    files,
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

    // Discord не пишет в свой аудит-лог самостоятельное удаление (когда
    // человек стирает своё же сообщение) — только когда стирает МОДЕРАТОР.
    // Поэтому: если в журнале Discord есть подходящая свежая запись —
    // инициатор это модератор из неё, иначе считаем, что автор удалил сам.
    let initiator = message.author || null;
    try {
      const auditEntries = await message.guild.fetchAuditLogs({ type: 72 /* MESSAGE_DELETE */, limit: 5 });
      const match = auditEntries.entries.find((e) =>
        e.extra && e.extra.channel && e.extra.channel.id === message.channel.id
        && e.target && e.target.id === (message.author ? message.author.id : null)
        && Date.now() - e.createdTimestamp < 10000,
      );
      if (match) initiator = match.executor;
    } catch (_) {
      // нет прав на просмотр аудит-лога Discord или иная ошибка — не критично, останется автор
    }

    const fields = [
      { name: 'Канал', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Автор', value: message.author ? `<@${message.author.id}> | ${message.author.tag}` : '—', inline: true },
      { name: 'Инициатор', value: initiator ? `<@${initiator.id}> | ${initiator.tag}` : '—', inline: true },
      { name: 'Содержимое', value: contentText.slice(0, 1024), inline: false },
    ];
    if (otherAttachments.length > 0) {
      fields.push({ name: 'Вложение', value: otherAttachments.map((a) => `[${a.name}](${a.url})`).join('\n').slice(0, 1024), inline: false });
    } else if (imageAttachments.length > 0) {
      fields.push({ name: 'Вложение', value: `Фото/Эмбед (${imageAttachments.length})`, inline: false });
    }

    // До 4 картинок скачиваем сразу (пока ссылка Discord ещё жива) и
    // прикладываем как настоящие файлы — иначе после удаления сообщения
    // ссылка на вложение может протухнуть раньше, чем аудит её покажет.
    const imagesToCache = imageAttachments.slice(0, 4);
    const downloaded = await Promise.all(imagesToCache.map((a) => mediaCache.downloadToCache(a.url, 'deleted-msg')));

    const extraEmbeds = [];
    const auditFiles = [];
    imagesToCache.forEach((a, i) => {
      const cachedBuffer = mediaCache.readCached(downloaded[i]);
      const embed = new EmbedBuilder().setColor(0x5865f2);
      if (cachedBuffer) {
        const attachmentName = `deleted-${i}${path.extname(downloaded[i]) || '.png'}`;
        auditFiles.push(new AttachmentBuilder(cachedBuffer, { name: attachmentName }));
        embed.setImage(`attachment://${attachmentName}`);
      } else {
        embed.setImage(a.url); // не удалось закэшировать — используем исходную ссылку как раньше
      }
      extraEmbeds.push(embed);
    });
    if (imageAttachments.length > 4) {
      fields.push({ name: 'Ещё картинки', value: `Показаны первые 4 из ${imageAttachments.length}`, inline: false });
    }

    await logAudit(
      message.guild,
      initiator || { tag: 'неизвестно', id: '0' },
      '🗑️ Сообщение удалено',
      fields,
      extraEmbeds,
      auditFiles,
    );
  } catch (err) {
    console.error('Ошибка логирования удаления сообщения:', err);
  }
});

// У Discord нет удобной истории смены НИКА — дублируем сюда. Пишем только
// ручные правки людей: если ник поменял сам бот (синхронизация эффективной
// личности), запись не создаём, иначе журнал зафлудило бы.
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const oldNick = oldMember && !oldMember.partial ? (oldMember.nickname || null) : undefined;
    const newNick = newMember.nickname || null;
    if (oldNick === undefined) return; // старое состояние неизвестно — сравнивать не с чем
    if (oldNick === newNick) return; // ник не менялся (событие по другой причине)

    let changedBy = 'unknown';
    let isBot = false;
    try {
      const logs = await newMember.guild.fetchAuditLogs({ type: 24 /* MEMBER_UPDATE */, limit: 5 });
      const match = logs.entries.find((e) =>
        e.target && e.target.id === newMember.id
        && Date.now() - e.createdTimestamp < 15000
        && Array.isArray(e.changes) && e.changes.some((c) => c.key === 'nick'),
      );
      if (match && match.executor) {
        changedBy = match.executor.id;
        isBot = match.executor.id === client.user.id;
      }
    } catch (_) {
      // нет права на журнал Discord — оставим 'unknown'
    }

    if (isBot) return; // авто-синхронизация ника ботом — не логируем
    if (changedBy === 'unknown' && / \| \d+$/.test(newNick || '')) return; // почти наверняка авто-ник от бота (нет прав на журнал)

    await db.run(
      'INSERT INTO nickname_history (discord_id, old_nick, new_nick, changed_by, at) VALUES (?, ?, ?, ?, ?)',
      [newMember.id, oldNick, newNick, changedBy, new Date().toISOString()],
    );
  } catch (err) {
    console.error('Ошибка логирования смены ника:', err);
  }
});

// Участник числится в организации, но покинул Discord-сервер — уведомляем
// руководство (бот НЕ увольняет сам, только флаг).
client.on('guildMemberRemove', async (member) => {
  try {
    const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [member.id]);
    if (!participant) return;
    const passports = await passportsLib.getAllPassports(member.id);
    const list = passports.map((p) => `${p.name} (№ ${p.static})`).join(', ') || '—';
    const tag = member.user ? member.user.tag : member.id;
    const guild = member.guild;
    try {
      const channel = await guild.channels.fetch(config.CHANNEL_KICK_REVIEW);
      await channel.send({
        content: perms.mentionManagementRoles(),
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('⚠️ Участник пропал с сервера').setDescription(
          `<@${member.id}> (${tag}) покинул(а) Discord-сервер, но всё ещё числится в организации.\n` +
          `Паспорта: ${list}\n\n` +
          `Бот НЕ уволил автоматически — решите вручную (заявка на увольнение / оставить).`,
        )],
        ...mentionOpts,
      });
    } catch (e) {
      console.error('Не удалось уведомить о выходе участника:', e.message);
    }
    await logAudit(guild, client.user, '⚠️ Участник покинул Discord-сервер', [
      { name: 'Кто', value: `<@${member.id}> | ${tag}`, inline: true },
      { name: 'Паспорта', value: list.slice(0, 1024), inline: false },
    ]);
  } catch (err) {
    console.error('Ошибка обработки выхода участника с сервера:', err);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) {
      return;
    }

    // ---- Ответ в тикете: уведомляем автора тикета, если пишет не он ----
    if (message.channel.parentId === config.CHANNEL_TICKETS_ACTIVE_CATEGORY) {
      try {
        const t = await db.get("SELECT id, opener_id, subject FROM tickets WHERE channel_id = ? AND status = 'open'", [message.channel.id]);
        if (t) {
          await db.run('UPDATE tickets SET last_activity = ?, autoclose_warned = 0 WHERE id = ?', [new Date().toISOString(), t.id]).catch(() => {});
          if (t.opener_id && t.opener_id !== message.author.id) {
            await notify(t.opener_id, 'ticket', `Ответ в тикете «${t.subject || 'Тикет'}»`, `/ticket/${t.id}`);
          }
        }
      } catch (_) {}
    }

    // ---- Кодовое слово «контракт» в Weazel News: скриншот на проверку ----
    if (message.channel.id === config.CHANNEL_CODEWORD) {
      const shot = [...message.attachments.values()].find((a) => (a.contentType || '').startsWith('image/'));
      if (!shot) return; // без картинки — игнорируем
      try {
        const identity = await passportsLib.computeEffectiveIdentity(message.author.id);
        const insert = await db.run(
          "INSERT INTO codeword_submissions (discord_id, discord_tag, name, static, screenshot_url, message_url, status, submitted_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
          [message.author.id, message.author.tag, identity ? identity.name : null, identity ? identity.static : null, shot.url, message.url, message.createdAt.toISOString()],
        );
        const id = insert.lastID;
        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('📰 Кодовое слово — на проверку')
          .setDescription(`Отправитель: <@${message.author.id}>${identity ? ` — ${identity.name}, № ${identity.static}` : ''}`)
          .setImage(shot.url)
          .setFooter({ text: `Заявка #${id}` });
        const sent = await message.reply({
          content: appealMentionRoles(),
          embeds: [embed],
          components: [row(
            new ButtonBuilder().setCustomId(`codeword_ok:${id}`).setLabel('✅ Подтвердить').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`codeword_no:${id}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
          )],
          ...appealMentionOpts,
        });
        await db.run('UPDATE codeword_submissions SET review_message_id = ? WHERE id = ?', [sent.id, id]);
      } catch (err) {
        console.error('Ошибка обработки скриншота кодового слова:', err.message);
      }
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
    // Ключ — канал (thread_id), НЕ discord_id: у одного человека может
    // быть несколько паспортов/каналов, и пара должна закрываться
    // независимо в каждом, иначе скриншот "взял" из канала другого
    // паспорта ошибочно засчитается как итог по этому.
    const pending = await db.get('SELECT * FROM pending_contract_shots WHERE thread_id = ?', [message.channel.id]);
    if (!pending) {
      console.log('[скриншоты] Это первый скриншот ("взял") — ставлю в ожидание пары и реагирую ⏳.');
      await db.run(
        'INSERT INTO pending_contract_shots (thread_id, discord_id, url, submitted_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET discord_id = excluded.discord_id, url = excluded.url, submitted_at = excluded.submitted_at',
        [message.channel.id, discordId, imageUrls[0], now],
      );
      await message.react('⏳').catch((err) => console.log('[скриншоты] Не удалось поставить реакцию ⏳:', err.message));
      return;
    }

    console.log('[скриншоты] Найдена ожидающая пара — создаю карточку контракта.');
    await db.run('DELETE FROM pending_contract_shots WHERE thread_id = ?', [message.channel.id]);
    await postContractReviewCard(message.guild, discordId, pending.url, pending.submitted_at, imageUrls[0], now, message);
  } catch (err) {
    console.error('Ошибка обработки скриншота контракта:', err);
  }
});

client.once('clientReady', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);

  // --- Сайт (вход через Discord) на том же домене/порту ---
  try {
    web.start(client, {
      syncEffectiveIdentity,
      syncStatusRoles,
      syncProfileChannelName,
      createProfileThread,
      removeParticipant,
      safeUpdateMembersList,
      getCurrentText,
      runWeeklyRankAdjustment,
      initMenus,
      checkContractPromotion,
      syncAllCommandPermissions,
      // Карточка контракта на проверку для сдачи через сайт (скрины — из БД contract_uploads).
      postContractReviewCardWeb: async (guild, contractId, discordId, threadId) => {
        const c = await db.get('SELECT * FROM contracts WHERE id = ?', [contractId]);
        if (!c) return;
        const ups = await db.all('SELECT slot, mime, data, file FROM contract_uploads WHERE contract_id = ?', [contractId]).catch(() => []);
        const uploadsDir = db.dataDir ? path.join(db.dataDir, 'uploads') : path.join(process.cwd(), 'data', 'uploads');
        const files = [];
        const infoE = new EmbedBuilder().setColor(0xfee75c).setTitle('Новый контракт на проверку (с сайта)').addFields({ name: 'Участник', value: `<@${discordId}>` });
        const takenE = new EmbedBuilder().setColor(0xfee75c).setTitle('1️⃣ Взял контракт');
        const doneE = new EmbedBuilder().setColor(0xfee75c).setTitle('2️⃣ Итог');
        for (const u of ups) {
          let buf = u.data ? Buffer.from(u.data) : null;
          if (!buf && u.file) { try { buf = fs.readFileSync(path.join(uploadsDir, path.basename(u.file))); } catch (_) {} }
          if (!buf) continue;
          const nm = `${u.slot}.${(u.mime || '').includes('png') ? 'png' : 'jpg'}`;
          files.push(new AttachmentBuilder(buf, { name: nm }));
          (u.slot === 'taken' ? takenE : doneE).setImage(`attachment://${nm}`);
        }
        if (!ups.some((u) => u.slot === 'taken') && c.taken_message_url) takenE.setDescription(c.taken_message_url);
        if (!ups.some((u) => u.slot === 'result') && c.message_url) doneE.setDescription(c.message_url);
        const channel = await guild.channels.fetch(threadId).catch(() => null);
        if (!channel) return;
        const msg = await channel.send({
          embeds: [infoE, takenE, doneE],
          files,
          components: [row(
            new ButtonBuilder().setCustomId(`contract_fulfilled:${contractId}`).setLabel('✅ Выполнен').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`contract_unfulfilled:${contractId}`).setLabel('❌ Невыполнен').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`contract_rejected:${contractId}`).setLabel('🚫 Не контракт').setStyle(ButtonStyle.Secondary),
          )],
        });
        await contracts.setReviewMessageId(contractId, msg.id);
      },
      notifyHrApplication: async (guild, reqId) => {
        const reqRow = await db.get('SELECT * FROM hr_applications WHERE id = ?', [reqId]);
        if (!reqRow || !guild) return;
        const reviewChannel = await guild.channels.fetch(config.CHANNEL_HR_APPLY_REVIEW).catch(() => null);
        if (!reviewChannel) return;
        const sent = await reviewChannel.send({
          content: config.ROLES_MEMBERS_LIST_ALLOWED.map((r) => `<@&${r}>`).join(' '),
          embeds: [buildHrApplyEmbed(reqRow)],
          components: buildHrApplyComponents(reqRow),
          allowedMentions: { roles: config.ROLES_MEMBERS_LIST_ALLOWED },
        });
        await db.run('UPDATE hr_applications SET message_id = ? WHERE id = ?', [sent.id, reqId]).catch(() => {});
      },
      restoreProfiles: async (guild) => {
        const parts = await db.all('SELECT discord_id FROM participants');
        let n = 0;
        for (const p of parts) {
          if (String(p.discord_id).startsWith('nodiscord-')) continue;
          const pps = await passportsLib.getAllPassports(p.discord_id);
          for (const pp of pps) {
            let ok = false;
            if (pp.profile_thread_id) { try { await guild.channels.fetch(pp.profile_thread_id); ok = true; } catch (_) {} }
            if (!ok) { try { await createProfileThread(guild, p.discord_id, pp.name, pp.static); n++; } catch (_) {} }
          }
        }
        return n;
      },
      notifyPasswordReset: async (reqId) => {
        try {
          const q = await db.get('SELECT * FROM password_reset_requests WHERE id = ?', [reqId]);
          if (!q) return;
          const ownerId = config.OWNER_USER_ID;
          if (!ownerId) return;
          const u = await client.users.fetch(ownerId).catch(() => null);
          if (!u) return;
          await u.send({
            embeds: [new EmbedBuilder().setColor(0xf2c94c).setTitle('🔑 Заявка на сброс пароля (сайт)')
              .setDescription(`Логин: **${q.login || '—'}**\nПочта: ${q.email || '—'}\n${q.note ? `Комментарий: ${q.note}\n` : ''}\nРазобрать: панель сайта → «Аккаунты».`)],
          }).catch(() => {});
        } catch (e) { console.error('[web] notifyPasswordReset:', e.message); }
      },
      // Полная синхронизация Discord-стороны при решении по заявке с сайта:
      // та же карточка «Принято/Отклонено», те же ЛС и запись в аудит Discord.
      appMirrorAccepted: async (appId, byId, profileChannelUrl) => {
        try {
          const guild = await client.guilds.fetch(process.env.GUILD_ID);
          const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
          if (!app) return;
          const actor = await client.users.fetch(byId).catch(() => null);
          const ch = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW).catch(() => null);
          if (ch && app.message_id) {
            await refreshReviewMessage(ch, app.message_id, await applicationReviewEmbed({ ...app, status: 'accepted' }, guild.id), [], actionSummary(byId, '✅ Принято')).catch(() => {});
          }
          await dmUser(guild, app.discord_id, '✅ Ваша заявка на вступление принята! Добро пожаловать в организацию.').catch(() => {});
          await notify(app.discord_id, 'apply', 'Ваша заявка на вступление принята — добро пожаловать!', '/me').catch(() => {});
          if (profileChannelUrl) {
            await dmUser(guild, app.discord_id,
              `📸 Ваш профиль для отчётов по контрактам: ${profileChannelUrl}\n\n`
              + `Туда нужно присылать скриншоты **на весь экран** по каждому контракту — 2 штуки:\n`
              + `1️⃣ когда вы **взяли** контракт\n2️⃣ когда контракт **выполнен или не выполнен**\n\n`
              + `Можно прислать оба скриншота одним сообщением, можно — двумя сообщениями подряд.`).catch(() => {});
          }
          const rulesText = await getCurrentText('rules', DEFAULT_RULES);
          await dmUser(guild, app.discord_id, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил организации').setDescription(String(rulesText).slice(0, 4000))] }).catch(() => {});
          await logAudit(guild, actor || { id: byId, tag: byId }, 'Заявка принята (через сайт)', [
            { name: 'Кто принял', value: `<@${byId}> | ${(actor && actor.tag) || byId}`, inline: true },
            { name: 'Кого принял', value: `<@${app.discord_id}> | № ${appId}`, inline: true },
          ]).catch(() => {});
        } catch (e) { console.error('[web] appMirrorAccepted:', e.message); }
      },
      appMirrorRejected: async (appId, byId) => {
        try {
          const guild = await client.guilds.fetch(process.env.GUILD_ID);
          const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
          if (!app) return;
          const actor = await client.users.fetch(byId).catch(() => null);
          const ch = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW).catch(() => null);
          if (ch && app.message_id) {
            await refreshReviewMessage(ch, app.message_id, await applicationReviewEmbed({ ...app, status: 'rejected', reject_reason: app.reject_reason }, guild.id), [], actionSummary(byId, '❌ Отклонено', app.reject_reason)).catch(() => {});
          }
          await dmUser(guild, app.discord_id, `❌ Ваша заявка на вступление была отклонена. Причина: ${app.reject_reason}`).catch(() => {});
          await notify(app.discord_id, 'apply', `Заявка на вступление отклонена. Причина: ${app.reject_reason}`, '/apply').catch(() => {});
          await logAudit(guild, actor || { id: byId, tag: byId }, 'Заявка отклонена (через сайт)', [
            { name: 'Кто отклонил', value: `<@${byId}> | ${(actor && actor.tag) || byId}`, inline: true },
            { name: 'Чья заявка', value: `<@${app.discord_id}> | № ${appId}`, inline: true },
            { name: 'Причина', value: app.reject_reason || '—', inline: false },
          ]).catch(() => {});
        } catch (e) { console.error('[web] appMirrorRejected:', e.message); }
      },
      appMirrorComment: async (appId, authorName, text) => {
        try {
          const guild = await client.guilds.fetch(process.env.GUILD_ID);
          const app = await db.get('SELECT message_id FROM applications WHERE id = ?', [appId]);
          if (!app || !app.message_id) return;
          const ch = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW).catch(() => null);
          if (!ch) return;
          const body = `💬 **${authorName}** — комментарий с сайта к заявке #${appId}:\n> ${String(text).replace(/\n/g, '\n> ').slice(0, 1500)}`;
          try { const msg = await ch.messages.fetch(app.message_id); await msg.reply({ content: body, allowedMentions: { parse: [] } }); }
          catch (_) { await ch.send({ content: body, allowedMentions: { parse: [] } }).catch(() => {}); }
        } catch (e) { console.error('[web] appMirrorComment:', e.message); }
      },
      // Прямое добавление участника с сайта (без заявки) — как ручной ввод в Discord.
      addParticipantDirect: async (discordId, name, staticNum, lvl, byId) => {
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const actor = await client.users.fetch(byId).catch(() => null);
        try {
          const member = await guild.members.fetch(discordId);
          await member.roles.add([config.ROLE_APPLY, config.ROLE_ORGANIZATION].filter(Boolean));
        } catch (_) {}
        await syncEffectiveIdentity(guild, discordId);
        await history.logJoined(discordId, staticNum, name, `Добавлен напрямую через сайт`).catch(() => {});
        let url = null;
        try { url = await createProfileThread(guild, discordId, name, staticNum); } catch (_) {}
        await dmUser(guild, discordId, '✅ Вас добавили в организацию. Добро пожаловать!').catch(() => {});
        await notify(discordId, 'apply', 'Вас добавили в организацию — добро пожаловать!', '/me').catch(() => {});
        if (url) await dmUser(guild, discordId, `📸 Ваш профиль для отчётов по контрактам: ${url}`).catch(() => {});
        const rulesText = await getCurrentText('rules', DEFAULT_RULES);
        await dmUser(guild, discordId, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил организации').setDescription(String(rulesText).slice(0, 4000))] }).catch(() => {});
        await safeUpdateMembersList(guild).catch(() => {});
        await logAudit(guild, actor || { id: byId, tag: byId }, 'Участник добавлен напрямую (сайт)', [
          { name: 'Кто добавил', value: `<@${byId}>`, inline: true },
          { name: 'Кого', value: `<@${discordId}> | ${name} № ${staticNum}`, inline: true },
        ]).catch(() => {});
        return url;
      },
      commandDefaultTiers: COMMAND_DEFAULT_TIERS,
      tierLabels: Object.fromEntries(Object.entries(TIER_INFO).map(([k, v]) => [k, v.label])),
      commandDescriptions: Object.fromEntries(commands.map((c) => {
        const j = typeof c.toJSON === 'function' ? c.toJSON() : c;
        return [j.name, j.description || ''];
      })),
    });
  } catch (e) {
    console.error('[web] Не удалось запустить сайт:', e.message);
  }

  await db.init();
  const overridesCount = await configStore.loadOverrides();
  if (overridesCount > 0) console.log(`Применено переопределений конфига из БД: ${overridesCount}`);
  await seedRejectTemplates();
  try { _backupTimeCache = await db.getSetting('backup.time'); } catch (_) {}
  await registerCommands();

  // Разовый перенос старых картинок-BLOB из БД на диск (data/uploads/) —
  // облегчает бэкап. Идёт порциями, не блокируя старт.
  (async () => {
    try {
      const upDir = db.dataDir ? path.join(db.dataDir, 'uploads') : path.join(process.cwd(), 'data', 'uploads');
      fs.mkdirSync(upDir, { recursive: true });
      for (const [tbl, pfx] of [['contract_uploads', 'c'], ['page_assets', 'a']]) {
        const rows = await db.all(`SELECT id, mime, data FROM ${tbl} WHERE data IS NOT NULL AND (file IS NULL OR file = '') LIMIT 500`).catch(() => []);
        for (const r of rows) {
          try {
            const ext = (r.mime || '').includes('png') ? 'png' : (r.mime || '').includes('webp') ? 'webp' : (r.mime || '').includes('svg') ? 'svg' : 'jpg';
            if (ext === 'svg') continue; // svg оставляем в БД (мелкие, текстовые)
            const nm = `${pfx}${r.id}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
            fs.writeFileSync(path.join(upDir, nm), Buffer.from(r.data));
            await db.run(`UPDATE ${tbl} SET file = ?, data = NULL WHERE id = ?`, [nm, r.id]);
          } catch (_) {}
        }
        if (rows.length) console.log(`[uploads] перенесено на диск из ${tbl}: ${rows.length}`);
      }
    } catch (e) { console.error('[uploads] перенос на диск:', e.message); }
  })();

  // Разово: даты бейджей по стажу (месяц/90 дней/год) у старых участников
  // проставлены «сегодня» — пересчитываем от joined_at (детерминированно).
  (async () => {
    try {
      const map = { month: 30, veteran90: 90, year1: 365 };
      const rows = await db.all(
        "SELECT ba.rowid AS rid, ba.badge_key AS k, p.joined_at AS j FROM badge_awards ba JOIN participants p ON p.discord_id = ba.discord_id WHERE ba.badge_key IN ('month','veteran90','year1') AND p.joined_at IS NOT NULL",
      ).catch(() => []);
      let n = 0;
      for (const r of rows) {
        const want = new Date(new Date(r.j).getTime() + map[r.k] * 864e5).toISOString();
        const res = await db.run('UPDATE badge_awards SET awarded_at = ? WHERE rowid = ? AND (awarded_at IS NULL OR awarded_at > ?)', [want, r.rid, want]).catch(() => ({ changes: 0 }));
        if (res && res.changes) n++;
      }
      if (n) console.log(`[badges] пересчитаны даты бейджей по стажу: ${n}`);
    } catch (e) { console.error('[badges] backfill дат:', e.message); }
  })();

  if (process.env.GUILD_ID) {
    try {
      const startupGuild = await client.guilds.fetch(process.env.GUILD_ID);
      await logSystem(startupGuild, '🔄 Бот запущен/перезапущен', `${client.user.tag} в сети.`);
    } catch (err) {
      console.error('Не удалось залогировать запуск бота в аудит:', err.message);
    }
    // Через минуту после старта — синхронизировать авто-роли за бейджи
    // (создать недостающие роли и разнести их по участникам).
    setTimeout(async () => {
      try {
        const g = await client.guilds.fetch(process.env.GUILD_ID);
        await badges.syncAllRoles(g);
      } catch (err) {
        console.error('Не удалось синхронизировать роли за бейджи при старте:', err.message);
      }
    }, 60 * 1000);
  }

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
      mediaCache.cleanupOldCache();
    },
    // время автобэкапа (МСК, "HH:MM") — правится в панели → «Настройки»; кэш обновляется в часовом цикле
    () => _backupTimeCache,
  );

  // 23:59 МСК — список подтверждённых кодовых слов + ежедневная сводка Владельцу в ЛС
  (function scheduleDailyCodewordList() {
    const msUntil = dates.nextMskTime(23, 59).getTime() - Date.now();
    setTimeout(async function run() {
      try {
        if (process.env.GUILD_ID) {
          const g = await client.guilds.fetch(process.env.GUILD_ID);
          await sendCodewordRefundList(g);
          await sendDailyDigest(g);
          await sendUnreadNudges(g).catch((e) => console.error('unread nudges:', e.message));
        }
      } catch (err) {
        console.error('Ошибка ежедневной рассылки 23:59:', err.message);
      }
      setTimeout(run, dates.nextMskTime(23, 59).getTime() - Date.now());
    }, msUntil);
    console.log(`Ежедневная сводка и список кодовых слов запланированы на 23:59 МСК (через ${Math.round(msUntil / 60000)} мин.).`);
  })();

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
          await checkReviewSla(guild);
        }
        await checkDiskSpace(guild);
        await checkStuckContracts(guild);
        await checkSilentTickets(guild);
        // авто-публикация запланированных доп. страниц
        await db.run("UPDATE site_pages SET published = 1, publish_at = NULL WHERE published = 0 AND publish_at IS NOT NULL AND publish_at <= ?", [new Date().toISOString()]).catch(() => {});
        try { _backupTimeCache = await db.getSetting('backup.time'); } catch (_) {}
        await checkExpiredVacations(guild);
        await checkExpiredBlacklist(guild);
        await checkAnniversaries(guild);
        await runWeeklyRankAdjustment(guild);
        await checkRecurringGiveaways(guild);
        await badges.syncAllRoles(guild);
        // ежедневная сводка теперь по расписанию в 23:59 МСК (см. ниже)
        await sendWeeklyDigest(guild);
        await sendPersonalWeeklyDigests(guild);
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

      await fireScheduledGiveaways(guild);
    } catch (err) {
      console.error('Ошибка проверки автовозврата недели статистики:', err);
    }
  }, 60 * 1000);
});

client.login(BOT_TOKEN);
