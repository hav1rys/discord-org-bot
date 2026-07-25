require('dotenv').config();
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
} = require('discord.js');

const db = require('./db');
const config = require('./config');
const { logAudit } = require('./audit');
const { updateMembersList, changeMembersPage } = require('./members');
const { updateBlacklist, changeBlacklistPage } = require('./blacklist');
const perms = require('./permissions');
const passportsLib = require('./passports');
const { parseDeadline, parseDateOnly, formatDateTime, formatDateOnly } = require('./dates');
const { DEFAULT_RULES, DEFAULT_AGITATION } = require('./content');

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

// ---------- Утилиты ----------

function txt(interaction, customId, label, opts = {}) {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(opts.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts.required !== false)
    .setValue(opts.value || '')
    .setMaxLength(opts.maxLength || 200);
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function getRoleIndex(roleId) {
  return config.ROLE_IDS.indexOf(roleId);
}

async function safeReply(interaction, content) {
  const payload = typeof content === 'string' ? { content, ephemeral: true } : { ephemeral: true, ...content };
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

async function resolveGuild(interaction) {
  if (interaction.guild) return interaction.guild;
  return client.guilds.fetch(process.env.GUILD_ID);
}

const mentionOpts = { allowedMentions: { roles: config.ROLES_MEMBERS_LIST_ALLOWED } };

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

async function syncNickname(guild, discordId, name, staticValue) {
  try {
    const member = await guild.members.fetch(discordId);
    await member.setNickname(`${name} | ${staticValue}`);
  } catch (err) {
    console.error(`Не удалось изменить ник для ${discordId}:`, err.message);
  }
}

// ---------- Модальные окна ----------

function buildApplicationModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Заявка на вступление');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { value: prefill.name })),
    row(txt(null, 'static', '№ Паспорта', { value: prefill.static })),
    row(txt(null, 'lvl', 'LVL персонажа', { value: prefill.lvl ? String(prefill.lvl) : '' })),
    row(txt(null, 'skills', 'Навыки (ссылка на скриншот)', { value: prefill.skills })),
    row(txt(null, 'online', 'Онлайн в неделю (часов)', { value: prefill.online })),
  );
  return modal;
}

function buildKickApplicationModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Заявка на увольнение');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия участника', { value: prefill.name })),
    row(txt(null, 'reason', 'Причина', { value: prefill.reason, required: false, paragraph: true })),
  );
  return modal;
}

function buildMemberModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Данные участника');
  modal.addComponents(
    row(txt(null, 'name', 'Имя Фамилия', { value: prefill.name })),
    row(txt(null, 'discord_id', 'Discord ID', { value: prefill.discord_id })),
    row(txt(null, 'static', '№ Паспорта', { value: prefill.static })),
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
    row(txt(null, 'query', 'Имя Фамилия или № Паспорта (необязательно)', { required: false })),
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

function buildVacationGrantModal(discordId) {
  const modal = new ModalBuilder().setCustomId(`modal_vacation_grant:${discordId}`).setTitle('Выдать отпуск');
  modal.addComponents(
    row(txt(null, 'deadline', 'Дата (ДД.ММ.ГГГГ) или срок (7d)')),
  );
  return modal;
}

function buildAfkModal(discordId) {
  const modal = new ModalBuilder().setCustomId(`modal_afk_set:${discordId}`).setTitle('Указать AFK');
  modal.addComponents(
    row(txt(null, 'date', 'Дата с которой AFK (ДД.ММ.ГГГГ)')),
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
    .setName('agitation')
    .setDescription('Отправить текущую агитацию в канал агитации'),
  new SlashCommandBuilder()
    .setName('agitation_update')
    .setDescription('Обновить текст агитации'),
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
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }
}

async function initMenus(guild) {
  const applyChannel = await guild.channels.fetch(config.CHANNEL_APPLY_MENU);
  await applyChannel.send({
    embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Вступление в организацию').setDescription('Нажмите кнопку ниже, чтобы подать заявку на вступление.')],
    components: [row(new ButtonBuilder().setCustomId('apply_submit').setLabel('📝 Подать заявку').setStyle(ButtonStyle.Success))],
  });

  const kickChannel = await guild.channels.fetch(config.CHANNEL_KICK_MENU);
  await kickChannel.send({
    embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Заявка на увольнение').setDescription('Нажмите кнопку ниже, чтобы подать заявку на увольнение участника.')],
    components: [row(new ButtonBuilder().setCustomId('kick_submit').setLabel('🚫 Подать заявку на увольнение').setStyle(ButtonStyle.Danger))],
  });

  const vacationChannel = await guild.channels.fetch(config.CHANNEL_VACATION_MENU);
  await vacationChannel.send({
    embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Отпуск').setDescription('Нажмите кнопку ниже, чтобы подать заявку на отпуск.')],
    components: [row(new ButtonBuilder().setCustomId('vacation_apply').setLabel('🏖️ Подать заявку на отпуск').setStyle(ButtonStyle.Primary))],
  });

  await safeUpdateMembersList(guild);
  await safeUpdateBlacklist(guild);
}

// ---------- Обработка заявок на вступление ----------

function applicationReviewEmbed(app) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на вступление #${app.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${app.discord_id}> (${app.discord_tag})` },
      { name: 'Имя Фамилия', value: app.name || '—', inline: true },
      { name: '№ Паспорта', value: app.static || '—', inline: true },
      { name: 'LVL', value: String(app.lvl || '—'), inline: true },
      { name: 'Онлайн/нед.', value: app.online || '—', inline: true },
      { name: 'Навыки', value: app.skills || '—' },
      { name: 'Статус', value: app.status },
    );
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

function kickReviewEmbed(k) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на увольнение #${k.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${k.discord_id}> (${k.discord_tag})` },
      { name: 'Имя Фамилия участника', value: k.name || '—' },
      { name: 'Причина', value: k.reason || '—' },
      { name: 'Статус', value: k.status },
    );
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
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`Заявка на отпуск #${v.id}`)
    .addFields(
      { name: 'Заявитель', value: `<@${v.discord_id}> (${v.discord_tag})` },
      { name: 'До какого числа', value: formatDateTime(new Date(v.until)) },
      { name: 'Причина', value: v.reason || '—' },
      { name: 'Статус', value: v.status },
    );
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

async function refreshReviewMessage(channel, messageId, embed, components) {
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ embeds: [embed], components });
  } catch (err) {
    console.error('Не удалось обновить сообщение рассмотрения:', err);
  }
}

async function dmUser(guild, discordId, content) {
  try {
    const member = await guild.members.fetch(discordId);
    await member.send(content);
  } catch (_) {
    // пользователь может иметь закрытые ЛС
  }
}

async function removeParticipant(guild, participant, reason) {
  await db.run('DELETE FROM participants WHERE discord_id = ?', [participant.discord_id]);
  await db.run('DELETE FROM extra_passports WHERE discord_id = ?', [participant.discord_id]);

  try {
    const member = await guild.members.fetch(participant.discord_id);
    await member.roles.remove([...config.ROLE_IDS, config.ROLE_VACATION, config.ROLE_AFK]);
  } catch (_) {
    // участник уже мог покинуть сервер
  }

  await dmUser(guild, participant.discord_id, `🚫 Вы были исключены из организации.${reason ? ` Причина: ${reason}` : ''}`);
  await safeUpdateMembersList(guild);
}

// ---------- interactionCreate ----------

client.on('interactionCreate', async (interaction) => {
  try {
    const guild = await resolveGuild(interaction);

    // ----- Слэш-команды -----
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'init_menus') {
        if (!perms.hasBotAccess(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        await initMenus(guild);
        await interaction.editReply('Меню успешно инициализированы.');
        return;
      }

      if (cmd === 'rules' || cmd === 'agitation') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', ephemeral: true });
        }
        if (cmd === 'rules') {
          const text = (await db.getSetting('rules_text')) || DEFAULT_RULES;
          const channel = await guild.channels.fetch(config.CHANNEL_RULES);
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил').setDescription(text)] });
          return interaction.reply({ content: 'Правила отправлены в канал.', ephemeral: true });
        }
        const text = (await db.getSetting('agitation_text')) || DEFAULT_AGITATION;
        const channel = await guild.channels.fetch(config.CHANNEL_AGITATION);
        await channel.send({ content: text, embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('```\n' + text + '\n```')] });
        return interaction.reply({ content: 'Агитация отправлена в канал.', ephemeral: true });
      }

      if (cmd === 'rules_update' || cmd === 'agitation_update') {
        if (!perms.canManageMembersList(interaction.member)) {
          return interaction.reply({ content: '⛔ У вас нет прав для использования этой команды.', ephemeral: true });
        }
        const type = cmd === 'rules_update' ? 'rules' : 'agitation';
        const defaultText = type === 'rules' ? DEFAULT_RULES : DEFAULT_AGITATION;
        const current = (await db.getSetting(`${type}_text`)) || defaultText;

        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Текущий текст (копируемая версия — следующим сообщением)').setDescription(current.slice(0, 4000))],
          ephemeral: true,
        });
        await interaction.followUp({ content: '```\n' + current.slice(0, 1900) + '\n```', ephemeral: true });
        await interaction.followUp({
          content: 'Отправьте новый текст следующим сообщением в этом канале (10 минут на ответ).',
          ephemeral: true,
        });

        const filter = (m) => m.author.id === interaction.user.id;
        let collected;
        try {
          collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 600000, errors: ['time'] });
        } catch (_) {
          await interaction.followUp({ content: 'Время ожидания истекло, изменение отменено.', ephemeral: true });
          return;
        }
        const newText = collected.first().content;
        pendingUpdates.set(`${type}:${interaction.user.id}`, newText);

        await interaction.channel.send({
          content: `Предпросмотр нового текста (${type === 'rules' ? 'правила' : 'агитация'}) от <@${interaction.user.id}>:`,
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

      if (id === 'apply_submit') {
        return interaction.showModal(buildApplicationModal('modal_apply'));
      }

      if (id === 'kick_submit') {
        return interaction.showModal(buildKickApplicationModal('modal_kick'));
      }

      if (id === 'vacation_apply') {
        return interaction.showModal(buildVacationSelfModal());
      }

      if (id.startsWith('vacation_selfcancel:')) {
        const discordId = id.split(':')[1];
        if (interaction.user.id !== discordId) {
          return safeReply(interaction, '⛔ Это не ваш отпуск.');
        }
        try {
          const member = await guild.members.fetch(discordId);
          await member.roles.remove(config.ROLE_VACATION).catch(() => {});
        } catch (_) {}
        await db.run('UPDATE participants SET vacation_until = NULL WHERE discord_id = ?', [discordId]);
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
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const vId = id.split(':')[1];
        const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
        if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [v.discord_id]);
        if (!participant) return safeReply(interaction, 'Этот пользователь не найден в списке участников.');

        try {
          const member = await guild.members.fetch(v.discord_id);
          await member.roles.add(config.ROLE_VACATION);
        } catch (_) {}

        await db.run('UPDATE participants SET vacation_until = ? WHERE discord_id = ?', [v.until, v.discord_id]);
        await db.run('UPDATE vacations SET status = ? WHERE id = ?', ['accepted', vId]);
        await refreshReviewMessage(interaction.channel, v.message_id, vacationReviewEmbed({ ...v, status: 'accepted' }), []);
        await safeUpdateMembersList(guild);
        await dmUser(guild, v.discord_id, {
          content: `🏖️ Ваш отпуск одобрен до **${formatDateTime(new Date(v.until))}**.`,
          components: [row(new ButtonBuilder().setCustomId(`vacation_selfcancel:${v.discord_id}`).setLabel('❌ Отменить отпуск').setStyle(ButtonStyle.Danger))],
        });
        await logAudit(guild, interaction.user, 'Отпуск одобрен', `Заявка #${vId}: <@${v.discord_id}> до ${formatDateTime(new Date(v.until))}`);
        return safeReply(interaction, 'Отпуск одобрен.');
      }

      if (id.startsWith('vacation_reject:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав.');
        const vId = id.split(':')[1];
        const v = await db.get('SELECT * FROM vacations WHERE id = ?', [vId]);
        if (!v || v.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');
        await db.run('UPDATE vacations SET status = ? WHERE id = ?', ['rejected', vId]);
        await refreshReviewMessage(interaction.channel, v.message_id, vacationReviewEmbed({ ...v, status: 'rejected' }), []);
        await dmUser(guild, v.discord_id, '❌ Ваша заявка на отпуск отклонена.');
        await logAudit(guild, interaction.user, 'Отпуск отклонён', `Заявка #${vId} от <@${v.discord_id}>`);
        return safeReply(interaction, 'Заявка отклонена.');
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

      if (id.startsWith('apply_reject:')) {
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app) return safeReply(interaction, 'Заявка не найдена.');
        await db.run('UPDATE applications SET status = ? WHERE id = ?', ['rejected', appId]);
        await refreshReviewMessage(interaction.channel, app.message_id, applicationReviewEmbed({ ...app, status: 'rejected' }), []);
        await dmUser(guild, app.discord_id, `❌ Ваша заявка на вступление была отклонена.`);
        await logAudit(guild, interaction.user, 'Заявка отклонена', `Заявка #${appId} от <@${app.discord_id}>`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      if (id.startsWith('kick_edit:')) {
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k) return safeReply(interaction, 'Заявка не найдена.');
        return interaction.showModal(buildKickApplicationModal(`modal_kick_edit:${kickId}`, k));
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
        await db.run('UPDATE kicks SET status = ? WHERE id = ?', ['rejected', kickId]);
        await refreshReviewMessage(interaction.channel, k.message_id, kickReviewEmbed({ ...k, status: 'rejected' }), []);
        await dmUser(guild, k.discord_id, `❌ Ваша заявка на увольнение была отклонена.`);
        await logAudit(guild, interaction.user, 'Заявка на увольнение отклонена', `Заявка #${kickId} от <@${k.discord_id}>`);
        return safeReply(interaction, 'Заявка отклонена.');
      }

      if (id.startsWith('members_pick:')) {
        const action = id.split(':')[1];
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        if (action === 'add') {
          return interaction.showModal(buildMemberModal('modal_members_add'));
        }
        return interaction.showModal(buildPickSearchModal(action));
      }

      if (id === 'members_search') {
        if (!perms.canManageMembersList(interaction.member)) {
          return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        }
        return interaction.showModal(buildSearchModal());
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

      if (id === 'blacklist_prev') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        await interaction.deferUpdate();
        return changeBlacklistPage(guild, -1);
      }

      if (id === 'blacklist_next') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        await interaction.deferUpdate();
        return changeBlacklistPage(guild, 1);
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

      if (id.startsWith('rules_save:') || id.startsWith('agitation_save:')) {
        const [prefix, userId] = id.split(':');
        const type = prefix.split('_')[0];
        if (interaction.user.id !== userId) return safeReply(interaction, '⛔ Подтвердить может только тот, кто запустил обновление.');
        const text = pendingUpdates.get(`${type}:${userId}`);
        if (!text) return safeReply(interaction, '⛔ Время ожидания истекло, начните заново через команду.');
        pendingUpdates.delete(`${type}:${userId}`);
        await db.setSetting(`${type}_text`, text);

        if (type === 'rules') {
          const channel = await guild.channels.fetch(config.CHANNEL_RULES);
          await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил').setDescription(text)] });
        } else {
          const channel = await guild.channels.fetch(config.CHANNEL_AGITATION);
          await channel.send({ content: text, embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('```\n' + text + '\n```')] });
        }

        await logAudit(guild, interaction.user, type === 'rules' ? 'Свод правил обновлён' : 'Агитация обновлена', 'Текст изменён и опубликован.');
        await interaction.update({ content: '✅ Сохранено и опубликовано.', embeds: [], components: [] });
        return;
      }

      if (id.startsWith('rules_cancel:') || id.startsWith('agitation_cancel:')) {
        const [prefix, userId] = id.split(':');
        const type = prefix.split('_')[0];
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
        await passportsLib.removeExtraPassport(discordId, staticValue);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Паспорт удалён', `<@${discordId}>: № ${staticValue}`);
        return safeReply(interaction, 'Паспорт удалён.');
      }

      // Шаг 2 повышения/понижения: конкретный ранг уже выбран — применяем его
      if (customId.startsWith('select_rank:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const [, action, discordId] = customId.split(':');
        const newRoleId = interaction.values[0];
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе (возможно, был изменён список).');
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ Этому участнику нельзя менять роль.');
        }
        if (!perms.canActOnRank(interaction.member, participant.role_id) || !perms.canActOnRank(interaction.member, newRoleId)) {
          return safeReply(interaction, '⛔ У вас недостаточно прав, чтобы назначить этот ранг.');
        }

        const oldRoleId = participant.role_id;

        try {
          const member = await guild.members.fetch(discordId);
          if (oldRoleId) await member.roles.remove(oldRoleId).catch(() => {});
          await member.roles.add(newRoleId);
        } catch (err) {
          return safeReply(interaction, 'Не удалось изменить роль участника на сервере (проверьте права бота).');
        }

        await db.run('UPDATE participants SET role_id = ? WHERE discord_id = ?', [newRoleId, discordId]);
        await safeUpdateMembersList(guild);
        await logAudit(
          guild,
          interaction.user,
          action === 'promote' ? 'Повышение' : 'Понижение',
          `<@${discordId}> (${participant.name}): <@&${oldRoleId}> → <@&${newRoleId}>`,
        );
        return safeReply(interaction, `Ранг участника ${participant.name} обновлён.`);
      }

      // Шаг после members_pick: конкретный участник выбран через поиск
      if (customId.startsWith('select_pick:')) {
        if (!perms.canManageMembersList(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для взаимодействия со списком участников.');
        const action = customId.split(':')[1];
        const discordId = interaction.values[0];
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден в базе (возможно, был изменён список).');
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ С этим участником нельзя взаимодействовать.');
        }

        if (action === 'kick') {
          return interaction.showModal(buildKickApplicationModal(`modal_members_kick:${discordId}`, { name: participant.name }));
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

        if (action === 'vacation_grant') {
          return interaction.showModal(buildVacationGrantModal(discordId));
        }

        if (action === 'vacation_revoke') {
          if (!participant.vacation_until) return safeReply(interaction, 'У участника нет активного отпуска.');
          try {
            const member = await guild.members.fetch(discordId);
            await member.roles.remove(config.ROLE_VACATION).catch(() => {});
          } catch (_) {}
          await db.run('UPDATE participants SET vacation_until = NULL WHERE discord_id = ?', [discordId]);
          await safeUpdateMembersList(guild);
          await logAudit(guild, interaction.user, 'Отпуск снят', `<@${discordId}> (${participant.name})`);
          await dmUser(guild, discordId, '📢 Ваш отпуск был досрочно завершён администрацией.');
          return safeReply(interaction, `Отпуск участника ${participant.name} снят.`);
        }

        if (action === 'afk_set') {
          return interaction.showModal(buildAfkModal(discordId));
        }

        if (action === 'afk_revoke') {
          if (!participant.afk_since) return safeReply(interaction, 'У участника не выставлен статус AFK.');
          try {
            const member = await guild.members.fetch(discordId);
            await member.roles.remove(config.ROLE_AFK).catch(() => {});
          } catch (_) {}
          await db.run('UPDATE participants SET afk_since = NULL WHERE discord_id = ?', [discordId]);
          await safeUpdateMembersList(guild);
          await logAudit(guild, interaction.user, 'AFK снят', `<@${discordId}> (${participant.name})`);
          return safeReply(interaction, `Статус AFK участника ${participant.name} снят.`);
        }

        // Шаг 1 повышения/понижения: участник выбран — показываем список
        // доступных рангов, чтобы выбрать любой, а не только соседний.
        if (action === 'promote' || action === 'demote') {
          if (!perms.canActOnRank(interaction.member, participant.role_id)) {
            return safeReply(interaction, '⛔ У вас недостаточно прав для изменения роли этого участника.');
          }

          const currentIndex = getRoleIndex(participant.role_id);
          if (currentIndex === -1) {
            return safeReply(interaction, 'У участника не определён текущий ранг в иерархии — измените роль вручную на сервере.');
          }

          const actorIndex = perms.getActorRankIndex(interaction.member);
          const eligibleIndexes = config.ROLE_IDS
            .map((_, i) => i)
            .filter((i) => (action === 'promote' ? i < currentIndex : i > currentIndex))
            .filter((i) => interaction.member.id === config.OWNER_USER_ID || interaction.member.roles.cache.has(config.ROLE_ADMIN) || i > actorIndex);

          if (eligibleIndexes.length === 0) {
            return safeReply(interaction, 'Невозможно изменить ранг дальше (достигнута граница иерархии или недостаточно прав).');
          }

          const options = [];
          for (const i of eligibleIndexes) {
            const roleId = config.ROLE_IDS[i];
            let roleName = roleId;
            try {
              const role = await guild.roles.fetch(roleId);
              if (role) roleName = role.name;
            } catch (_) {}
            options.push(new StringSelectMenuOptionBuilder().setLabel(roleName).setValue(roleId));
          }

          const rankSelect = new StringSelectMenuBuilder()
            .setCustomId(`select_rank:${action}:${discordId}`)
            .setPlaceholder('Выберите новый ранг')
            .addOptions(options);

          return safeReply(interaction, {
            content: `Выберите новый ранг для **${participant.name}**:`,
            components: [row(rankSelect)],
          });
        }

        return;
      }

      return;
    }

    // ----- Модальные окна -----
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      const get = (name) => interaction.fields.getTextInputValue(name);

      // Подача заявки на вступление
      if (id === 'modal_apply') {
        const app = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          name: get('name'),
          static: get('static'),
          lvl: parseInt(get('lvl'), 10) || 0,
          skills: get('skills'),
          online: get('online'),
          status: 'pending',
          created_at: new Date().toISOString(),
        };

        const blacklisted = await db.get('SELECT * FROM blacklist WHERE discord_id = ? OR static = ?', [app.discord_id, app.static]);
        if (blacklisted) {
          return safeReply(interaction, '⛔ Вы находитесь в чёрном списке организации и не можете подать заявку на вступление.');
        }

        const result = await db.run(
          `INSERT INTO applications (discord_id, discord_tag, name, static, lvl, skills, online, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [app.discord_id, app.discord_tag, app.name, app.static, app.lvl, app.skills, app.online, app.status, app.created_at],
        );
        app.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_APPLY_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [applicationReviewEmbed(app)],
          components: applicationReviewComponents(app),
          ...mentionOpts,
        });
        await db.run('UPDATE applications SET message_id = ? WHERE id = ?', [sent.id, app.id]);

        await logAudit(guild, interaction.user, 'Новая заявка на вступление', `Заявка #${app.id} от <@${app.discord_id}>`);
        return safeReply(interaction, 'Ваша заявка отправлена на рассмотрение.');
      }

      // Редактирование заявки на вступление
      if (id.startsWith('modal_apply_edit:')) {
        const appId = id.split(':')[1];
        const fields = { name: get('name'), static: get('static'), lvl: parseInt(get('lvl'), 10) || 0, skills: get('skills'), online: get('online') };
        await db.run('UPDATE applications SET name = ?, static = ?, lvl = ?, skills = ?, online = ? WHERE id = ?', [
          fields.name, fields.static, fields.lvl, fields.skills, fields.online, appId,
        ]);
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        await refreshReviewMessage(interaction.channel, app.message_id, applicationReviewEmbed(app), applicationReviewComponents(app));
        await logAudit(guild, interaction.user, 'Заявка изменена', `Заявка #${appId} отредактирована`);
        return safeReply(interaction, 'Заявка обновлена.');
      }

      // Принятие заявки
      if (id.startsWith('modal_apply_accept:')) {
        const appId = id.split(':')[1];
        const app = await db.get('SELECT * FROM applications WHERE id = ?', [appId]);
        if (!app || app.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        const fields = { name: get('name'), static: get('static'), lvl: parseInt(get('lvl'), 10) || 0, skills: get('skills'), online: get('online') };

        const blacklisted = await db.get('SELECT * FROM blacklist WHERE discord_id = ? OR static = ?', [app.discord_id, fields.static]);
        if (blacklisted) {
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
          [app.discord_id, app.discord_tag, fields.name, fields.static, fields.lvl, fields.skills, fields.online, config.ROLE_APPLY, new Date().toISOString()],
        );
        await db.run('UPDATE applications SET status = ? WHERE id = ?', ['accepted', appId]);

        try {
          const member = await guild.members.fetch(app.discord_id);
          await member.roles.add(config.ROLE_APPLY);
        } catch (err) {
          console.error('Не удалось выдать роль при принятии заявки:', err);
        }

        await syncNickname(guild, app.discord_id, fields.name, fields.static);
        await refreshReviewMessage(interaction.channel, app.message_id, applicationReviewEmbed({ ...app, ...fields, status: 'accepted' }), []);
        await dmUser(guild, app.discord_id, '✅ Ваша заявка на вступление принята! Добро пожаловать в организацию.');
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Заявка принята', `Заявка #${appId}: <@${app.discord_id}> принят(а) в организацию`);
        return safeReply(interaction, 'Заявка принята, участник добавлен.');
      }

      // Подача заявки на увольнение
      if (id === 'modal_kick') {
        const k = {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.tag,
          name: get('name'),
          reason: get('reason') || '',
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const result = await db.run(
          `INSERT INTO kicks (discord_id, discord_tag, name, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [k.discord_id, k.discord_tag, k.name, k.reason, k.status, k.created_at],
        );
        k.id = result.lastID;

        const reviewChannel = await guild.channels.fetch(config.CHANNEL_KICK_REVIEW);
        const sent = await reviewChannel.send({
          content: perms.mentionManagementRoles(),
          embeds: [kickReviewEmbed(k)],
          components: kickReviewComponents(k),
          ...mentionOpts,
        });
        await db.run('UPDATE kicks SET message_id = ? WHERE id = ?', [sent.id, k.id]);

        await logAudit(guild, interaction.user, 'Новая заявка на увольнение', `Заявка #${k.id} от <@${k.discord_id}> на участника «${k.name}»`);
        return safeReply(interaction, 'Заявка на увольнение отправлена на рассмотрение.');
      }

      // Редактирование заявки на увольнение
      if (id.startsWith('modal_kick_edit:')) {
        const kickId = id.split(':')[1];
        await db.run('UPDATE kicks SET name = ?, reason = ? WHERE id = ?', [get('name'), get('reason') || '', kickId]);
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        await refreshReviewMessage(interaction.channel, k.message_id, kickReviewEmbed(k), kickReviewComponents(k));
        await logAudit(guild, interaction.user, 'Заявка на увольнение изменена', `Заявка #${kickId} отредактирована`);
        return safeReply(interaction, 'Заявка обновлена.');
      }

      // Подтверждение увольнения через заявку
      if (id.startsWith('modal_kick_confirm:')) {
        const kickId = id.split(':')[1];
        const k = await db.get('SELECT * FROM kicks WHERE id = ?', [kickId]);
        if (!k || k.status !== 'pending') return safeReply(interaction, 'Заявка уже обработана.');

        const reason = get('reason') || k.reason;
        const name = get('name') || k.name;

        const participant = await db.get('SELECT * FROM participants WHERE name = ?', [name]);
        if (participant && perms.isProtectedTarget(participant.discord_id, interaction.user.id)) {
          return safeReply(interaction, '⛔ Этого участника нельзя уволить.');
        }
        await db.run('UPDATE kicks SET status = ?, reason = ?, name = ? WHERE id = ?', ['accepted', reason, name, kickId]);

        if (participant) {
          await removeParticipant(guild, participant, reason);
        }

        await refreshReviewMessage(interaction.channel, k.message_id, kickReviewEmbed({ ...k, status: 'accepted', reason, name }), []);
        await logAudit(guild, interaction.user, 'Участник уволен', `Заявка #${kickId}: «${name}» уволен(а). Причина: ${reason || '—'}`);
        return safeReply(interaction, 'Участник уволен.');
      }

      // Добавление участника вручную
      if (id === 'modal_members_add') {
        const fields = {
          name: get('name'),
          discord_id: get('discord_id').trim(),
          static: get('static'),
          lvl: parseInt(get('lvl'), 10) || 0,
          online: get('online') || '',
        };

        const dupId = await db.get('SELECT id FROM participants WHERE discord_id = ?', [fields.discord_id]);
        if (dupId) return safeReply(interaction, 'Участник с таким Discord ID уже существует.');
        if (await passportsLib.isStaticTaken(fields.static)) {
          return safeReply(interaction, 'Такой № Паспорта уже занят.');
        }

        let discordTag = fields.discord_id;
        try {
          const member = await guild.members.fetch(fields.discord_id);
          discordTag = member.user.tag;
        } catch (_) {
          // участника нет на сервере — сохраняем как есть
        }

        await db.run(
          `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [fields.discord_id, discordTag, fields.name, fields.static, fields.lvl, '', fields.online, config.ROLE_APPLY, new Date().toISOString()],
        );

        try {
          const member = await guild.members.fetch(fields.discord_id);
          await member.roles.add(config.ROLE_APPLY);
        } catch (_) {}

        await syncNickname(guild, fields.discord_id, fields.name, fields.static);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Участник добавлен вручную', `${fields.name} (<@${fields.discord_id}>)`);
        return safeReply(interaction, 'Участник добавлен.');
      }

      // Редактирование участника из списка
      if (id.startsWith('modal_members_edit:')) {
        const discordId = id.split(':')[1];
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ Данные этого участника нельзя изменять.');
        }
        const fields = {
          name: get('name'),
          discord_id: get('discord_id').trim(),
          static: get('static'),
          lvl: parseInt(get('lvl'), 10) || 0,
          online: get('online') || '',
        };

        const dupId = await db.get('SELECT id FROM participants WHERE discord_id = ? AND discord_id != ?', [fields.discord_id, discordId]);
        if (dupId) return safeReply(interaction, 'Такой Discord ID уже используется другим участником.');
        if (await passportsLib.isStaticTaken(fields.static, discordId)) {
          return safeReply(interaction, 'Такой № Паспорта уже занят другим участником.');
        }

        await db.run('UPDATE participants SET name = ?, discord_id = ?, static = ?, lvl = ?, online = ? WHERE discord_id = ?', [
          fields.name, fields.discord_id, fields.static, fields.lvl, fields.online, discordId,
        ]);

        await syncNickname(guild, fields.discord_id, fields.name, fields.static);
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Данные участника изменены', `${fields.name} (<@${fields.discord_id}>)`);
        return safeReply(interaction, 'Данные участника обновлены.');
      }

      // Увольнение через список участников
      if (id.startsWith('modal_members_kick:')) {
        const discordId = id.split(':')[1];
        if (perms.isProtectedTarget(discordId, interaction.user.id)) {
          return safeReply(interaction, '⛔ Этого участника нельзя уволить.');
        }
        const reason = get('reason') || '';
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        if (!participant) return safeReply(interaction, 'Участник не найден.');

        await removeParticipant(guild, participant, reason);
        await logAudit(guild, interaction.user, 'Участник уволен', `${participant.name} (<@${discordId}>). Причина: ${reason || '—'}`);
        return safeReply(interaction, 'Участник уволен.');
      }

      // Выбор участника через поиск (для kick/edit/promote/demote/паспорта/отпуск/AFK)
      if (id.startsWith('modal_pick_search:')) {
        const action = id.split(':')[1];
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
        const name = get('name');
        const staticValue = get('static');
        if (await passportsLib.isStaticTaken(staticValue)) {
          return safeReply(interaction, 'Такой № Паспорта уже используется.');
        }
        try {
          await passportsLib.addExtraPassport(discordId, name, staticValue);
        } catch (err) {
          return safeReply(interaction, `⛔ ${err.message}`);
        }
        await safeUpdateMembersList(guild);
        await logAudit(guild, interaction.user, 'Паспорт добавлен', `<@${discordId}>: ${name} — № ${staticValue}`);
        return safeReply(interaction, 'Паспорт добавлен.');
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
        const discordId = id.split(':')[1];
        const deadline = parseDeadline(get('deadline'));
        if (!deadline) {
          return safeReply(interaction, '⛔ Неверный формат. Используйте ДД.ММ.ГГГГ (будущая дата) или число+d, например 7d.');
        }
        try {
          const member = await guild.members.fetch(discordId);
          await member.roles.add(config.ROLE_VACATION);
        } catch (_) {}
        await db.run('UPDATE participants SET vacation_until = ? WHERE discord_id = ?', [deadline.toISOString(), discordId]);
        await safeUpdateMembersList(guild);
        await dmUser(guild, discordId, {
          content: `🏖️ Вам выдан отпуск до **${formatDateTime(deadline)}**.`,
          components: [row(new ButtonBuilder().setCustomId(`vacation_selfcancel:${discordId}`).setLabel('❌ Отменить отпуск').setStyle(ButtonStyle.Danger))],
        });
        await logAudit(guild, interaction.user, 'Отпуск выдан', `<@${discordId}> до ${formatDateTime(deadline)}`);
        return safeReply(interaction, 'Отпуск выдан.');
      }

      // Указание AFK
      if (id.startsWith('modal_afk_set:')) {
        const discordId = id.split(':')[1];
        const date = parseDateOnly(get('date'));
        if (!date) return safeReply(interaction, '⛔ Неверный формат даты. Используйте ДД.ММ.ГГГГ.');
        const participant = await db.get('SELECT * FROM participants WHERE discord_id = ?', [discordId]);
        try {
          const member = await guild.members.fetch(discordId);
          await member.roles.add(config.ROLE_AFK);
        } catch (_) {}
        await db.run('UPDATE participants SET afk_since = ? WHERE discord_id = ?', [formatDateOnly(date), discordId]);
        await safeUpdateMembersList(guild);
        if (participant) {
          await dmUser(
            guild,
            discordId,
            `💤 Вам выставлен статус AFK с ${formatDateOnly(date)}. Пожалуйста, зайдите в игру под именем **${participant.name} | ${participant.static}**, чтобы статус отобразился.`,
          );
        }
        await logAudit(guild, interaction.user, 'AFK выставлен', `<@${discordId}> с ${formatDateOnly(date)}`);
        return safeReply(interaction, 'Статус AFK выставлен.');
      }

      // Внесение в чёрный список
      if (id === 'modal_blacklist_add') {
        if (!perms.canManageBlacklist(interaction.member)) return safeReply(interaction, '⛔ У вас нет прав для управления чёрным списком.');
        const discordId = get('discord_id').trim();
        const staticValue = get('static') || '';
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
              ? rows.map((r) => `<@${r.discord_id}> | ${r.discord_tag} — № ${r.static || '—'} — ${r.reason || '—'}`).join('\n')
              : 'Ничего не найдено.',
          );
        return safeReply(interaction, { embeds: [embed] });
      }

      // Поиск
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

client.once('ready', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);
  await db.init();
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);