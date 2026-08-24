const db = require('./db');
const config = require('./config');

// Снимок исходных значений из config.js — снимается один раз при первом
// require этого модуля, ДО применения любых переопределений. Нужен, чтобы
// сброс переопределения тоже действовал мгновенно, без перезапуска.
const ORIGINAL_VALUES = { ...config };

// Какие ключи вообще можно менять через /config_set — только простые
// строковые/числовые поля (ID каналов/ролей, числовые настройки).
// Списки (ROLE_IDS, ROLES_REVIEW_ALLOWED и т.д.) и методы — исключены
// автоматически, трогать их через эту команду небезопасно.
function getSettableKeys() {
  return Object.keys(config).filter((k) => typeof config[k] === 'string' || typeof config[k] === 'number');
}

// Применяет все сохранённые переопределения поверх config в памяти.
// Вызывать один раз при старте бота, до того как что-либо начнёт
// использовать config — дальше все require('./config') в любом файле
// видят уже применённые значения, потому что это один и тот же объект.
async function loadOverrides() {
  const rows = await db.all('SELECT * FROM config_overrides');
  const settable = new Set(getSettableKeys());
  for (const row of rows) {
    if (!settable.has(row.key)) continue; // ключ убрали из config.js — пропускаем
    const original = config[row.key];
    config[row.key] = typeof original === 'number' ? Number(row.value) : row.value;
  }
  return rows.length;
}

async function setOverride(key, rawValue, actorId) {
  const settable = new Set(getSettableKeys());
  if (!settable.has(key)) {
    throw new Error(`Ключ «${key}» не найден или его нельзя менять через эту команду (доступны только простые строковые/числовые настройки).`);
  }
  const original = config[key];
  const value = typeof original === 'number' ? Number(rawValue) : rawValue;
  if (typeof original === 'number' && Number.isNaN(value)) {
    throw new Error(`Значение для «${key}» должно быть числом.`);
  }

  await db.run(
    `INSERT INTO config_overrides (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, String(value), actorId, new Date().toISOString()],
  );
  config[key] = value; // применяется мгновенно, без перезапуска
  return value;
}

async function getOverride(key) {
  return db.get('SELECT * FROM config_overrides WHERE key = ?', [key]);
}

async function clearOverride(key) {
  await db.run('DELETE FROM config_overrides WHERE key = ?', [key]);
  if (key in ORIGINAL_VALUES) {
    config[key] = ORIGINAL_VALUES[key]; // применяется мгновенно
  }
}

module.exports = { getSettableKeys, loadOverrides, setOverride, getOverride, clearOverride };
