const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// На Bothost (и похожих панелях) персистентный диск смонтирован в /app/data —
// именно туда нужно класть файл БД, чтобы он: а) пережил перезапуск/редеплой,
// б) был виден во встроенном просмотрщике "База данных бота" на сайте.
// Локально (Windows/если DATA_DIR не задан) — используем папку рядом с кодом,
// как раньше, чтобы ничего не сломать для тех, кто не на Bothost.
const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'data.db');
console.log(`База данных: ${dbPath}`);

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ---------------------------------------------------------------------
// ЕДИНОЕ ОПИСАНИЕ СХЕМЫ БАЗЫ ДАННЫХ
//
// Чтобы добавить фичу — просто впишите новую таблицу или новый столбец
// сюда. init() сам создаст то, чего не хватает, и добавит недостающие
// столбцы в уже существующие таблицы — вручную ничего мигрировать не
// нужно, ни при добавлении, ни при удалении функций.
//
// Чтобы удалить фичу — просто не используйте её таблицу/столбцы в коде.
// Ничего отсюда убирать не нужно (и не стоит) — старые данные останутся
// на месте, ничего не сломается, если вы (или другая версия бота) снова
// включите эту функцию позже.
// ---------------------------------------------------------------------

const SCHEMA = {
  participants: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT UNIQUE',
      discord_tag: 'TEXT',
      name: 'TEXT',
      static: 'TEXT UNIQUE',
      lvl: 'INTEGER',
      skills: 'TEXT',
      online: 'TEXT',
      role_id: 'TEXT',
      joined_at: 'TEXT',
      vacation_until: 'TEXT',
      afk_since: 'TEXT',
      profile_thread_id: 'TEXT',
      about: 'TEXT', // «Обо мне» — короткий текст участника для публичного профиля
      about_private: 'INTEGER DEFAULT 0', // 1 — «Обо мне» видно только себе и HR+
      contracts_private: 'INTEGER DEFAULT 0', // 1 — контракты/история видны только себе и HR+
      badges_private: 'INTEGER DEFAULT 0', // 1 — бейджи/достижения видны только себе и HR+
      last_anniv_year: 'INTEGER', // год, за который уже поздравили с годовщиной вступления
      last_weekly_digest: 'TEXT', // метка недели (YYYY-Www), за которую уже отправлен личный отчёт
      pinned_badges: 'TEXT', // закреплённые бейджи участника (ключи через запятую)
      frozen: 'INTEGER DEFAULT 0', // 1 — доступ к сайту заморожен
      frozen_reason: 'TEXT',
    },
    indexes: [['discord_id'], ['static']],
  },

  applications: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      name: 'TEXT',
      static: 'TEXT',
      lvl: 'INTEGER',
      skills: 'TEXT',
      invited_by: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      reject_reason: 'TEXT',
      accepted_by: 'TEXT',
      rejected_by: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  kicks: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      name: 'TEXT',
      reason: 'TEXT',
      target_static: 'TEXT', // конкретный паспорт на увольнение, или 'all'
      status: "TEXT DEFAULT 'pending'",
      reject_reason: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  settings: {
    columns: {
      key: 'TEXT PRIMARY KEY',
      value: 'TEXT',
    },
  },

  extra_passports: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      name: 'TEXT',
      static: 'TEXT UNIQUE',
      position: 'INTEGER',
      role_id: 'TEXT',
      vacation_until: 'TEXT',
      afk_since: 'TEXT',
      profile_thread_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  vacations: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      target_statics: 'TEXT', // список паспортов через запятую, или 'all'
      until: 'TEXT',
      reason: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      reject_reason: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  blacklist: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      static: 'TEXT',
      reason: 'TEXT',
      added_by: 'TEXT',
      created_at: 'TEXT',
      until: 'TEXT', // если задано — ЧС временный, снимается автоматически после этой даты
      appeal_blocked: 'INTEGER DEFAULT 0', // 1 — человеку запрещено подавать апелляцию на ЧС
    },
    indexes: [['discord_id']],
  },

  contracts: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      thread_id: 'TEXT',
      message_id: 'TEXT UNIQUE',
      message_url: 'TEXT',
      submitted_at: 'TEXT',
      taken_message_url: 'TEXT',
      taken_submitted_at: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      reviewed_by: 'TEXT',
      reviewed_at: 'TEXT',
      review_message_id: 'TEXT',
      taken_local_path: 'TEXT', // локальная копия скриншота "взял" — на случай, если исходное сообщение удалят
      completed_local_path: 'TEXT', // локальная копия скриншота "итог"
      stuck_reminder_sent: "INTEGER DEFAULT 0",
    },
    indexes: [['discord_id'], ['submitted_at'], ['status']],
  },

  // Профиль-канал участника — переживает увольнение/повторное вступление
  // (в отличие от participants, которая при увольнении удаляется целиком).
  // Один канал-профиль НА КАЖДЫЙ ПАСПОРТ (не на весь Discord-аккаунт).
  // static уникален глобально, поэтому им и ключуем.
  profile_channels: {
    columns: {
      discord_id: 'TEXT',
      static: 'TEXT UNIQUE',
      channel_id: 'TEXT',
      status: "TEXT DEFAULT 'active'", // active | archived
      created_at: 'TEXT',
      updated_at: 'TEXT',
    },
    indexes: [['discord_id'], ['static']],
  },

  invitations: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      inviter_discord_id: 'TEXT',
      invitee_discord_id: 'TEXT UNIQUE',
      invitee_name: 'TEXT',
      invitee_static: 'TEXT',
      joined_at: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      resolved_at: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['inviter_discord_id'], ['status']],
  },

  // Статистика по принятым заявкам (кто из руководства принял, досидел ли
  // принятый 3+ дня) — п.3 задания про статистику по заявкам.
  acceptances: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      staff_discord_id: 'TEXT',
      applicant_discord_id: 'TEXT UNIQUE',
      applicant_name: 'TEXT',
      applicant_static: 'TEXT',
      joined_at: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      resolved_at: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['staff_discord_id'], ['status']],
  },

  // Заявки на изменение Имени Фамилии по конкретному паспорту (п.11)
  data_change_requests: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      target_static: 'TEXT',
      old_name: 'TEXT',
      new_name: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      reject_reason: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  // Заявки на роль HR-Менеджера (п.12-14)
  hr_applications: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      hours_per_week: 'TEXT',
      training_ready: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      reject_reason: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  // История версий текстов (правила/агитация/описание HR и т.д.) — п.17.
  // Финальная версия дополнительно пишется отдельным файлом на диск.
  text_versions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      key: 'TEXT',
      content: 'TEXT',
      saved_by: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['key']],
  },

  // Гайды FAQ для участников и HR-менеджеров (каждая правка версионируется
  // через text_versions по ключу faq_<category>_<id>)
  // Заявка на добавление паспорта (когда заявку подаёт уже действующий
  // участник — форма превращается в это, вместо новой заявки на вступление)
  passport_requests: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      name: 'TEXT',
      static: 'TEXT',
      status: "TEXT DEFAULT 'pending'",
      reject_reason: 'TEXT',
      accepted_by: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  // Лог событий вступления/выхода по каждому паспорту — используется в
  // профиле участника и в заявке на увольнение (дата вступления).
  // Копия каждой записи аудита в БД — чтобы можно было искать (/audit_search),
  // не листая канал вручную.
  audit_log: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      actor_id: 'TEXT',
      actor_tag: 'TEXT',
      action: 'TEXT',
      details: 'TEXT',
      at: 'TEXT',
    },
    indexes: [['actor_id'], ['at']],
  },

  // Чтобы не слать напоминание об окончании отпуска повторно на каждой
  // проверке — помечаем, что для этого конкретного отпуска уже отправили.
  vacation_reminders_sent: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      static: 'TEXT',
      until: 'TEXT',
      sent_at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  // История выдачи/снятия отпуска (когда выдал руководитель, не сам
  // человек — самостоятельные заявки уже есть в vacations) и AFK —
  // отдельной "заявки" на AFK не существует, поэтому только так.
  // "Взял контракт"-скриншот, ожидающий пары со скриншотом итога. Раньше
  // это жило в памяти процесса и терялось при перезапуске/передеплое —
  // теперь переживает рестарт.
  // Переопределения config.js через /config_set — применяются поверх
  // значений из кода при каждом запуске, без правки файлов и передеплоя.
  // Переопределения уровня доступа команд через /права_команд — так же,
  // как config_overrides, но для того, какая роль нужна для команды.
  command_permission_overrides: {
    columns: {
      command_name: 'TEXT PRIMARY KEY',
      tier: 'TEXT', // admin | owner | deputy | hr
      updated_by: 'TEXT',
      updated_at: 'TEXT',
    },
  },

  // OAuth2-токен пользователя (не токен бота!) для синхронизации видимости
  // команд в самом Discord — Discord требует именно Bearer-токен
  // авторизованного человека для правки прав команд, токен бота не подходит.
  oauth_tokens: {
    columns: {
      id: 'INTEGER PRIMARY KEY', // всегда 1 — одна запись на всё приложение
      access_token: 'TEXT',
      refresh_token: 'TEXT',
      expires_at: 'TEXT',
      authorized_by: 'TEXT',
      updated_at: 'TEXT',
    },
  },

  config_overrides: {
    columns: {
      key: 'TEXT PRIMARY KEY',
      value: 'TEXT',
      updated_by: 'TEXT',
      updated_at: 'TEXT',
    },
  },

  giveaways: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      channel_id: 'TEXT',
      message_id: 'TEXT UNIQUE',
      prize: 'TEXT',
      winners_count: 'INTEGER',
      host_id: 'TEXT',
      ends_at: 'TEXT',
      status: "TEXT DEFAULT 'active'", // active | ended | cancelled
      required_role_id: 'TEXT', // если задано — участвовать может только эта роль (и роли выше по иерархии)
      min_role_id: 'TEXT', // если задано — участвовать может эта роль ранга и ВЫШЕ по иерархии ROLE_IDS
      recurring_rule_id: 'INTEGER', // если создан из шаблона повтора — ссылка на giveaway_recurring_rules.id
      winners: 'TEXT', // discord id победителей через запятую (для /розыгрыш_история)
      prize_tiers: 'TEXT', // необяз. призовые места: строки «диапазон | приз», напр. «1 | X\n2-3 | Y»
      created_at: 'TEXT',
    },
    indexes: [['status'], ['ends_at']],
  },

  // Шаблоны повторяющихся розыгрышей ("каждую пятницу")
  giveaway_recurring_rules: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      channel_id: 'TEXT',
      prize: 'TEXT',
      winners_count: 'INTEGER',
      duration_ms: 'INTEGER', // сколько длится каждый запуск
      weekday: 'INTEGER', // 0=вс..6=сб — в какой день недели запускать
      required_role_id: 'TEXT',
      host_id: 'TEXT',
      status: "TEXT DEFAULT 'active'", // active | paused
      last_run_date: 'TEXT', // ГГГГ-ММ-ДД — чтобы не запустить дважды за один день
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  giveaway_entries: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      giveaway_id: 'INTEGER',
      discord_id: 'TEXT',
    },
    indexes: [['giveaway_id']],
  },

  // ЧС розыгрышей — эти люди не могут участвовать ни в одном розыгрыше
  // (ни сами, ни через ручное добавление), независимо от условия роли.
  giveaway_blacklist: {
    columns: {
      discord_id: 'TEXT PRIMARY KEY',
      reason: 'TEXT',
      added_by: 'TEXT',
      added_at: 'TEXT',
    },
  },

  // Защита от спама кнопкой "Вошёл(а)" — одно уведомление на один период
  // AFK (afk_since сверяется, чтобы новая выдача AFK снова разрешила отправить)
  afk_return_requests: {
    columns: {
      key: 'TEXT PRIMARY KEY', // `${discord_id}:${static}`
      discord_id: 'TEXT',
      static: 'TEXT',
      afk_since: 'TEXT',
      requested_at: 'TEXT',
    },
  },

  pending_contract_shots: {
    columns: {
      thread_id: 'TEXT UNIQUE', // канал конкретного паспорта — НЕ discord_id, у одного человека паспортов/каналов может быть несколько, у каждого своя независимая пара
      discord_id: 'TEXT',
      url: 'TEXT',
      submitted_at: 'TEXT',
    },
    indexes: [['thread_id']],
  },

  status_events: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      static: 'TEXT',
      name: 'TEXT',
      type: 'TEXT', // 'vacation' | 'afk'
      action: 'TEXT', // 'granted' | 'revoked'
      reason: 'TEXT',
      until: 'TEXT', // для отпуска — до какой даты (не используется для AFK)
      actor_id: 'TEXT',
      at: 'TEXT',
    },
    indexes: [['discord_id'], ['static']],
  },

  membership_events: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      static: 'TEXT',
      name: 'TEXT',
      event: 'TEXT', // 'joined' | 'left'
      note: 'TEXT',
      at: 'TEXT',
    },
    indexes: [['discord_id'], ['static']],
  },

  faq_entries: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      category: 'TEXT', // 'member' | 'hr'
      title: 'TEXT',
      content: 'TEXT',
      position: 'INTEGER',
      updated_by: 'TEXT',
      updated_at: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['category']],
  },

  // Кто заходил на сайт через Discord OAuth (регистрация = первый вход).
  web_users: {
    columns: {
      discord_id: 'TEXT PRIMARY KEY',
      username: 'TEXT',
      avatar: 'TEXT',
      first_login: 'TEXT',
      last_login: 'TEXT',
      login_count: 'INTEGER DEFAULT 0',
      sess_ver: 'INTEGER DEFAULT 0', // версия сессии; +1 = «выйти со всех устройств»
      ical_token: 'TEXT', // секрет для ссылки-подписки на календарь отпусков (.ics)
      // Локальные аккаунты (вход по логину/паролю, без Discord). discord_id таких
      // записей вида 'local:<rand>'. is_local=1. linked_discord_id — участник,
      // к которому havirys привязал аккаунт (тогда сайт работает от его имени).
      is_local: 'INTEGER DEFAULT 0',
      login: 'TEXT',
      email: 'TEXT',
      pass_hash: 'TEXT',
      pass_salt: 'TEXT',
      linked_discord_id: 'TEXT',
      // Discord, который локальный пользователь привязал сам (OAuth) — нужен,
      // чтобы подать заявку на вступление: аккаунт должен быть на сервере.
      oauth_discord_id: 'TEXT',
    },
  },

  // Заявки на сброс пароля локального аккаунта. Разбирает вручную havirys
  // (дублируется ему в ЛС Discord + видно на вкладке «Аккаунты» в панели).
  password_reset_requests: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      login: 'TEXT',
      email: 'TEXT',
      note: 'TEXT',
      status: "TEXT DEFAULT 'pending'", // pending | done
      created_at: 'TEXT',
      resolved_by: 'TEXT',
      resolved_at: 'TEXT',
    },
  },

  // Журнал входов на сайт (для страницы «Мои входы»).
  web_logins: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      ip: 'TEXT',
      ua: 'TEXT',
      at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  // Реферальные ссылки для сайта: /i/<code> запоминает, кто пригласил, и
  // подставляет это в заявку на вступление автоматически.
  invite_links: {
    columns: {
      code: 'TEXT PRIMARY KEY',
      creator_id: 'TEXT',
      created_at: 'TEXT',
      uses: 'INTEGER DEFAULT 0',
      signups: 'INTEGER DEFAULT 0',
    },
    indexes: [['creator_id']],
  },

  // Комментарии/обсуждение под заявкой на вступление (на сайте, до решения).
  application_comments: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      application_id: 'INTEGER',
      author_id: 'TEXT',
      author_name: 'TEXT',
      text: 'TEXT',
      at: 'TEXT',
    },
    indexes: [['application_id']],
  },

  // Отложенные розыгрыши: бот сам создаёт розыгрыш, когда наступит start_at.
  scheduled_giveaways: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      prize: 'TEXT',
      winners_count: 'INTEGER',
      channel_id: 'TEXT',
      duration_ms: 'INTEGER',
      required_role_id: 'TEXT',
      min_role_id: 'TEXT',
      prize_tiers: 'TEXT',
      start_at: 'TEXT',
      host_id: 'TEXT',
      status: "TEXT DEFAULT 'pending'", // pending | fired | cancelled
      fired_giveaway_id: 'INTEGER',
      created_at: 'TEXT',
    },
    indexes: [['status']],
  },

  // Сохранённые шаблоны рассылок (с подстановками {имя} {паспорт} {ранг}).
  broadcast_templates: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      name: 'TEXT',
      text: 'TEXT',
      created_by: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // Discord-роли, которые бот сам создаёт под бейджи достижений
  // (badge_key -> role_id). Если роль удалить на сервере — бот создаст заново.
  badge_roles: {
    columns: {
      badge_key: 'TEXT PRIMARY KEY',
      role_id: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // Сессии сайта — по одной строке на вход, чтобы разлогинивать по одной.
  web_sessions: {
    columns: {
      sid: 'TEXT PRIMARY KEY',
      discord_id: 'TEXT',
      ip: 'TEXT',
      ua: 'TEXT',
      created_at: 'TEXT',
      last_seen: 'TEXT',
      revoked_at: 'TEXT',
      label: 'TEXT', // имя устройства, заданное пользователем («рабочий ПК»)
    },
    indexes: [['discord_id']],
  },

  // Шаблоны ответов в тикетах.
  ticket_reply_templates: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      name: 'TEXT',
      text: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // Редактируемые доп. страницы сайта (/rules, /about и любые /p/<slug>).
  site_pages: {
    columns: {
      slug: 'TEXT PRIMARY KEY',
      title: 'TEXT',
      content: 'TEXT',
      nav: 'INTEGER DEFAULT 0', // 1 — показывать ссылку в шапке
      published: 'INTEGER DEFAULT 1', // 0 — черновик, виден только havirys
      updated_at: 'TEXT',
    },
  },

  // Уведомления пользователю на сайте («колокольчик»).
  notifications: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      kind: 'TEXT',
      text: 'TEXT',
      link: 'TEXT',
      created_at: 'TEXT',
      read_at: 'TEXT',
      snooze_until: 'TEXT', // отложено до этого времени — скрыто из колокольчика
    },
    indexes: [['discord_id']],
  },

  // Настройки колокольчика: какие типы уведомлений участник отключил.
  notif_prefs: {
    columns: {
      discord_id: 'TEXT PRIMARY KEY',
      muted: 'TEXT', // список kind через запятую
    },
  },

  // Готовые шаблоны для доп. страниц сайта.
  page_templates: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      name: 'TEXT',
      content: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // Приватные заметки руководства об участнике (видны HR+ на профиле).
  staff_notes: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      target_id: 'TEXT',
      author_id: 'TEXT',
      author_name: 'TEXT',
      text: 'TEXT',
      at: 'TEXT',
    },
    indexes: [['target_id']],
  },

  // Редактируемые блоки главной страницы сайта.
  landing_blocks: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      position: 'INTEGER',
      kind: 'TEXT', // text | buttons | cards | stats
      title: 'TEXT',
      content: 'TEXT',
      min_height: 'INTEGER',
      updated_at: 'TEXT',
    },
  },

  // Отмена последнего действия (повышение/понижение) в течение окна.
  undo_actions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      kind: 'TEXT', // rank
      actor_id: 'TEXT',
      target_id: 'TEXT',
      payload: 'TEXT', // JSON: { static, prevRoleId }
      created_at: 'TEXT',
      expires_at: 'TEXT',
      done_at: 'TEXT',
    },
    indexes: [['target_id']],
  },

  // История смены НИКА на сервере (не путать с data_change_requests — там
  // заявки на смену Имени Фамилии по паспорту). Пишется из guildMemberUpdate;
  // изменения, сделанные самим ботом (синхронизация эффективной личности),
  // не записываются — только ручные правки людей.
  nickname_history: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      old_nick: 'TEXT',
      new_nick: 'TEXT',
      changed_by: 'TEXT', // discord id того, кто поменял (по журналу Discord), либо 'unknown'
      at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  // Отправка кодового слова «контракт» в Weazel News — для всех. Скриншот
  // кидается в CHANNEL_CODEWORD, Владелец/Зам. подтверждают, в 23:59 МСК
  // список одобренных за день уходит Владельцу в ЛС для возврата денег.
  codeword_submissions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      name: 'TEXT',
      static: 'TEXT',
      screenshot_url: 'TEXT',
      message_url: 'TEXT',
      status: "TEXT DEFAULT 'pending'", // pending | approved | rejected
      reviewed_by: 'TEXT',
      review_message_id: 'TEXT',
      counted: 'INTEGER DEFAULT 0', // 1 — уже вошло в ежедневный список на возврат
      submitted_at: 'TEXT',
      reviewed_at: 'TEXT',
    },
    indexes: [['status'], ['discord_id']],
  },

  // Апелляции на чёрный список — заявка от человека из ЧС, уходит в
  // CHANNEL_APPEAL_REVIEW, решают Владелец/Зам. Владелец (accept = снять из ЧС).
  appeals: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      text: 'TEXT',
      status: "TEXT DEFAULT 'pending'", // pending | accepted | rejected
      reject_reason: 'TEXT',
      message_id: 'TEXT',
      resolved_by: 'TEXT',
      resolved_at: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['discord_id'], ['status']],
  },

  // Тикеты поддержки — приватный канал на вопрос, при закрытии канал
  // просто уезжает в архивную категорию (без транскрипта).
  tickets: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      channel_id: 'TEXT UNIQUE',
      opener_id: 'TEXT',
      subject: 'TEXT',
      category: 'TEXT', // question | complaint | other | appeal
      status: "TEXT DEFAULT 'open'", // open | archived
      rating: 'INTEGER', // 1 = 👍, 0 = 👎, null — не оценивали
      rated_at: 'TEXT',
      priority: 'TEXT', // low | normal | high (null = normal)
      close_reason: 'TEXT', // причина закрытия (свободный текст / шаблон)
      tags: 'TEXT', // метки через запятую
      last_activity: 'TEXT', // время последнего сообщения (для авто-закрытия по тишине)
      autoclose_warned: 'INTEGER DEFAULT 0', // 1 — предупреждение о скором авто-закрытии отправлено
      assigned_to: 'TEXT', // кто из руководства взял тикет на себя
      assigned_at: 'TEXT',
      created_at: 'TEXT',
      closed_at: 'TEXT',
      closed_by: 'TEXT',
    },
    indexes: [['opener_id'], ['status']],
  },

  // Шаблоны причин отказа по очередям (application | kick | vacation | ...).
  // Редактируются командой /причины_отказа. Индекс position задаёт порядок кнопок.
  reject_reason_templates: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      queue: 'TEXT',
      text: 'TEXT',
      position: 'INTEGER',
      created_at: 'TEXT',
    },
    indexes: [['queue']],
  },

  // Оценка «Помог ли ответ?» под гайдом FAQ. Один голос на человека на гайд
  // (перезаписывается при повторном голосовании — реализовано в коде).
  faq_feedback: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      entry_id: 'INTEGER',
      discord_id: 'TEXT',
      helpful: 'INTEGER', // 1 — помог, 0 — не помог
      at: 'TEXT',
    },
    indexes: [['entry_id']],
  },

  // Момент, когда участник впервые «заработал» бейдж (фиксируется badges.compute
  // при первом обнаружении — дата приблизительная, но стабильная).
  badge_awards: {
    columns: {
      discord_id: 'TEXT',
      badge_key: 'TEXT',
      awarded_at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  // Готовые наборы для розыгрышей (кнопка «создать из шаблона»).
  giveaway_templates: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      name: 'TEXT',
      prize: 'TEXT',
      winners_count: 'INTEGER',
      duration: 'TEXT',
      required_role_id: 'TEXT',
      min_role_id: 'TEXT',
      prize_tiers: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // Шаблоны причин закрытия тикета (HR+ выбирает при закрытии на сайте).
  ticket_close_reasons: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      text: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // История версий редактируемых страниц (/rules, /about, /p/*) — для отката.
  site_page_versions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      slug: 'TEXT',
      title: 'TEXT',
      content: 'TEXT',
      nav: 'INTEGER DEFAULT 0',
      saved_at: 'TEXT',
      saved_by: 'TEXT',
    },
    indexes: [['slug']],
  },

  // Благодарности между участниками (кнопка «поблагодарить» на профиле).
  thanks: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      from_id: 'TEXT',
      to_id: 'TEXT',
      note: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['to_id'], ['from_id']],
  },

  // Гостевая книга профиля — записи участников на «стене» другого участника.
  guestbook: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      profile_id: 'TEXT', // чей профиль
      author_id: 'TEXT',
      text: 'TEXT',
      created_at: 'TEXT',
    },
    indexes: [['profile_id']],
  },

  // Точечный доступ к разделам панели: havirys выдаёт доступ к вкладкам либо
  // конкретному участнику (subject_type='user'), либо всем с ролью ('role').
  // discord_id хранит id участника ИЛИ id роли. Одна строка = один раздел.
  panel_grants: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      discord_id: 'TEXT',
      subject_type: "TEXT DEFAULT 'user'", // user | role
      tab: 'TEXT',
      granted_by: 'TEXT',
      granted_at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  // Загруженные картинки для доп. страниц. Отдаются по /asset/<id>.
  page_assets: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      filename: 'TEXT',
      mime: 'TEXT',
      data: 'BLOB', // legacy: старые записи; новые лежат в data/uploads/ (см. file)
      file: 'TEXT', // имя файла в data/uploads/
      size: 'INTEGER',
      uploaded_by: 'TEXT',
      uploaded_at: 'TEXT',
    },
  },

  // Скриншоты контрактов, загруженные участником через сайт. Отдаются
  // по /cimg/<id> (только автору контракта и HR+).
  contract_uploads: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      contract_id: 'INTEGER',
      owner_id: 'TEXT',
      slot: 'TEXT', // taken | result | codeword
      mime: 'TEXT',
      data: 'BLOB', // legacy: старые записи; новые — в data/uploads/ (см. file)
      file: 'TEXT', // имя файла в data/uploads/
      size: 'INTEGER',
      created_at: 'TEXT',
    },
    indexes: [['contract_id']],
  },

  // Транскрипты тикетов — HTML-выгрузка переписки, создаётся по кнопке.
  // Отдаётся по /ticket/<id>/transcript (автор тикета или HR+).
  ticket_transcripts: {
    columns: {
      ticket_id: 'INTEGER PRIMARY KEY',
      html: 'BLOB',
      msg_count: 'INTEGER',
      generated_by: 'TEXT',
      created_at: 'TEXT',
    },
  },

  // Одноразовые ссылки для входа на сайт: Discord-команда /сайт и кнопка
  // в канале входа. Ссылка живёт 10 минут и сгорает после первого перехода.
  magic_links: {
    columns: {
      token: 'TEXT PRIMARY KEY',
      discord_id: 'TEXT',
      created_at: 'TEXT',
      expires_at: 'TEXT',
      used_at: 'TEXT',
    },
    indexes: [['discord_id']],
  },

  // Конструктор форм: определения произвольных форм-заявок.
  forms: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      slug: 'TEXT UNIQUE',
      name: 'TEXT',
      description: 'TEXT',
      fields: 'TEXT', // JSON-массив: [{key,label,type,required,options}]
      channel_id: 'TEXT', // куда постить поданные заявки
      active: 'INTEGER DEFAULT 1',
      created_by: 'TEXT',
      created_at: 'TEXT',
    },
  },
  // Поданные через сайт заявки по формам конструктора.
  form_submissions: {
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      form_id: 'INTEGER',
      discord_id: 'TEXT',
      discord_tag: 'TEXT',
      data: 'TEXT', // JSON {key: value}
      status: "TEXT DEFAULT 'pending'", // pending | approved | rejected
      reviewed_by: 'TEXT',
      review_note: 'TEXT',
      message_id: 'TEXT',
      created_at: 'TEXT',
      reviewed_at: 'TEXT',
    },
    indexes: [['form_id'], ['status']],
  },
};

// Общие поля для всех очередей на рассмотрение: взятие заявки в работу
// (assigned_to/assigned_at), отметка о времени фактического решения
// (reviewed_at — для статистики скорости) и флаг «SLA-напоминание уже
// отправлено». Держим одним списком, чтобы не дублировать по таблицам.
const REVIEW_FIELDS = {
  reviewed_at: 'TEXT',
  assigned_to: 'TEXT',
  assigned_at: 'TEXT',
  sla_reminder_sent: 'INTEGER DEFAULT 0',
};
for (const reviewTable of ['applications', 'kicks', 'vacations', 'hr_applications', 'data_change_requests', 'passport_requests']) {
  Object.assign(SCHEMA[reviewTable].columns, REVIEW_FIELDS);
}

// Убирает модификаторы, недопустимые в ALTER TABLE ADD COLUMN
// (PRIMARY KEY/AUTOINCREMENT/UNIQUE можно указать только при создании
// таблицы) — иначе миграция существующей таблицы упадёт с ошибкой SQLite.
function toAddColumnType(columnType) {
  const stripped = columnType
    .replace(/PRIMARY KEY(\s+AUTOINCREMENT)?/i, '')
    .replace(/UNIQUE/i, '')
    .trim();
  return stripped || 'TEXT';
}

async function ensureTable(tableName, def) {
  const columnDefs = Object.entries(def.columns)
    .map(([name, type]) => `${name} ${type}`)
    .join(',\n    ');
  await run(`CREATE TABLE IF NOT EXISTS ${tableName} (\n    ${columnDefs}\n  )`);

  const existingColumns = await all(`PRAGMA table_info(${tableName})`);
  const existingNames = new Set(existingColumns.map((c) => c.name));

  for (const [columnName, columnType] of Object.entries(def.columns)) {
    if (!existingNames.has(columnName)) {
      await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${toAddColumnType(columnType)}`);
      console.log(`Миграция: добавлен столбец "${columnName}" в таблицу "${tableName}"`);
    }
  }

  for (const indexColumns of def.indexes || []) {
    const indexName = `idx_${tableName}_${indexColumns.join('_')}`;
    await run(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${indexColumns.join(', ')})`);
  }
}

// Разовая миграция: раньше profile_channels создавалась с UNIQUE на
// discord_id (один канал на весь аккаунт). Когда профили переехали на "один
// канал на каждый паспорт", уникальным должен был стать static — но
// SQLite не умеет менять ограничения существующей колонки через ALTER
// TABLE, обычная система миграций (ensureTable) такое не чинит. Из-за
// этого у людей с несколькими паспортами сохранялся канал только первого
// паспорта, остальные тихо не записывались в базу при каждой попытке.
// Пересоздаём таблицу с правильной схемой, перенося все данные.
async function migrateProfileChannelsUniqueness() {
  const tableInfo = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profile_channels'`);
  if (!tableInfo || !tableInfo.sql) return; // таблицы ещё нет — ensureTable создаст с нуля правильно
  if (!/discord_id\s+TEXT\s+UNIQUE/i.test(tableInfo.sql)) return; // уже новая схема — ничего делать не нужно

  console.log('Миграция: пересоздаю profile_channels (снимаю устаревшее ограничение UNIQUE с discord_id)...');
  await run('ALTER TABLE profile_channels RENAME TO profile_channels_old');
  await run(`CREATE TABLE profile_channels (
    discord_id TEXT,
    static TEXT UNIQUE,
    channel_id TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT,
    updated_at TEXT
  )`);
  await run(`INSERT INTO profile_channels (discord_id, static, channel_id, status, created_at, updated_at)
             SELECT discord_id, static, channel_id, status, created_at, updated_at FROM profile_channels_old`);
  await run('DROP TABLE profile_channels_old');
  console.log('Миграция profile_channels завершена.');
}

// Та же проблема, что и с profile_channels: ключ уникальности менялся с
// discord_id на thread_id, а ALTER TABLE не умеет такое чинить. Тут данные
// — временное состояние (незакрытая пара скриншотов), поэтому проще и
// безопаснее пересоздать таблицу с нуля; тем, у кого прямо сейчас висит
// незавершённая пара, придётся один раз прислать оба скриншота заново.
async function migratePendingContractShotsSchema() {
  const tableInfo = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_contract_shots'`);
  if (!tableInfo || !tableInfo.sql) return; // таблицы ещё нет — ensureTable создаст с нуля правильно
  if (!/discord_id\s+TEXT\s+UNIQUE/i.test(tableInfo.sql)) return; // уже новая схема — ничего делать не нужно

  console.log('Миграция: пересоздаю pending_contract_shots (ключ уникальности меняется с discord_id на thread_id)...');
  await run('DROP TABLE pending_contract_shots');
  console.log('Миграция pending_contract_shots завершена.');
}

async function init() {
  await migrateProfileChannelsUniqueness();
  await migratePendingContractShotsSchema();
  for (const [tableName, def] of Object.entries(SCHEMA)) {
    await ensureTable(tableName, def);
  }
}

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

module.exports = { db, run, get, all, init, getSetting, setSetting, dbPath, dataDir };
