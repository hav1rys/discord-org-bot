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
};

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

async function init() {
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
