// Локальный кэш вложений (фото/файлы) — Discord CDN-ссылки на вложения
// протухают, если исходное сообщение удалено. Чтобы скриншоты контрактов
// и вложения удалённых сообщений не пропадали из карточек/аудита, бот
// скачивает их себе на диск и пересобирает embed'ы уже из локальной копии.
//
// Жизненный цикл файла:
//   1. downloadToCache() — скачали на диск;
//   2. readCached() — вложили в сообщение бота (карточка проверки / аудит);
//      Discord с этого момента хранит СВОЮ копию во вложении сообщения —
//   3. deleteCached() — сразу удаляем локальную копию, она больше не нужна.
// Если шаг 2 не удался (скачать не вышло, отправка упала) — файл остаётся,
// и его подчистит cleanupOldCache() как страховка, по сроку RETENTION_DAYS.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const CACHE_DIR = path.join(db.dataDir, 'media_cache');
const RETENTION_DAYS = 30;

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function guessExtension(contentType, url) {
  if (contentType) {
    const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    if (map[contentType]) return map[contentType];
  }
  const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1].slice(0, 5) : 'bin';
}

// Скачивает файл по URL и сохраняет на диск. Возвращает локальный путь
// или null, если скачать не удалось (например, ссылка уже протухла —
// тогда просто продолжаем работать со старой ссылкой, как раньше).
async function downloadToCache(url, prefix) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = guessExtension(res.headers.get('content-type'), url);
    const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
    const filePath = path.join(CACHE_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error(`Не удалось закэшировать вложение (${url}):`, err.message);
    return null;
  }
}

// Читает закэшированный файл, если он ещё существует на диске
function readCached(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
}

// Немедленно удаляет одну закэшированную копию — вызывается сразу после
// того, как бот вложил файл в своё сообщение (карточку/аудит). basename()
// не даёт выйти за пределы CACHE_DIR, даже если передан абсолютный путь.
function deleteCached(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(path.join(CACHE_DIR, path.basename(filePath)));
  } catch (_) {
    // уже удалён / не существует — ничего страшного
  }
}

// Раз в сутки — удаляет файлы старше RETENTION_DAYS (страховка для файлов,
// которые по какой-то причине не были удалены сразу после отправки)
function cleanupOldCache() {
  let files;
  try {
    files = fs.readdirSync(CACHE_DIR);
  } catch (_) {
    return;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (_) {}
  }
  if (removed > 0) console.log(`Кэш вложений: удалено устаревших файлов — ${removed}`);
}

module.exports = { downloadToCache, readCached, deleteCached, cleanupOldCache, CACHE_DIR };
