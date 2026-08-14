const fs = require('fs');
const path = require('path');
const db = require('./db');

const dataDir = process.env.DATA_DIR || __dirname;
const filesDir = path.join(dataDir, 'texts');
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir, { recursive: true });
}

function filePathFor(key) {
  return path.join(filesDir, `${key}.txt`);
}

// Сохраняет новую версию: добавляет запись в историю (text_versions) и
// перезаписывает файл с финальной версией на диске (отдельно от БД).
async function saveVersion(key, content, savedBy) {
  await db.run(
    'INSERT INTO text_versions (key, content, saved_by, created_at) VALUES (?, ?, ?, ?)',
    [key, content, savedBy, new Date().toISOString()],
  );
  try {
    fs.writeFileSync(filePathFor(key), content, 'utf8');
  } catch (err) {
    console.error(`Не удалось записать файл текущей версии текста "${key}":`, err.message);
  }
}

async function getLatestVersion(key) {
  return db.get('SELECT * FROM text_versions WHERE key = ? ORDER BY id DESC LIMIT 1', [key]);
}

async function getAllVersions(key) {
  return db.all('SELECT * FROM text_versions WHERE key = ? ORDER BY id DESC', [key]);
}

module.exports = { saveVersion, getLatestVersion, getAllVersions };
