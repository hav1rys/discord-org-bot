const fs = require('fs');
const path = require('path');
const db = require('./db');

const BACKUP_RETENTION_DAYS = 14;
const backupsDir = path.join(db.dataDir, 'backups');

if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Копирует текущий data.db в backups/data-ГГГГ-ММ-ДД.db
function backupNow(onError) {
  const dest = path.join(backupsDir, `data-${todayStamp()}.db`);
  try {
    fs.copyFileSync(db.dbPath, dest);
    console.log(`Резервная копия базы данных сохранена: ${dest}`);
    return true;
  } catch (err) {
    console.error('Не удалось создать резервную копию базы данных:', err.message);
    if (onError) onError(`Не удалось создать резервную копию БД: ${err.message}`);
    return false;
  }
}

// Удаляет файлы резервных копий старше BACKUP_RETENTION_DAYS дней
function cleanupOldBackups(onError) {
  let files;
  try {
    files = fs.readdirSync(backupsDir);
  } catch (err) {
    console.error('Не удалось прочитать папку резервных копий:', err.message);
    if (onError) onError(`Не удалось прочитать папку резервных копий: ${err.message}`);
    return;
  }

  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of files) {
    if (!file.startsWith('data-') || !file.endsWith('.db')) continue;
    const filePath = path.join(backupsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        console.log(`Удалена устаревшая резервная копия: ${file}`);
      }
    } catch (err) {
      console.error(`Не удалось проверить/удалить файл ${file}:`, err.message);
      if (onError) onError(`Не удалось удалить устаревшую копию ${file}: ${err.message}`);
    }
  }
}

// Планирует запуск в 23:59 каждый день (по времени сервера, где крутится бот).
// notifyFn(text), если передана, вызывается при сбое — используется, чтобы
// заодно отправить сообщение в канал аудита (п.8), а не только в консоль.
function scheduleDailyBackup(notifyFn) {
  function msUntilNext2359() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  function runAndReschedule() {
    const ok = backupNow(notifyFn);
    if (ok && notifyFn) {
      // Успех тоже можно было бы слать, но это шум каждый день — молчим,
      // как и раньше; в аудит идут только сбои.
    }
    cleanupOldBackups(notifyFn);
    setTimeout(runAndReschedule, 24 * 60 * 60 * 1000);
  }

  setTimeout(runAndReschedule, msUntilNext2359());
  console.log(`Резервное копирование БД запланировано на 23:59 (через ${Math.round(msUntilNext2359() / 60000)} мин.)`);
}

module.exports = { backupNow, cleanupOldBackups, scheduleDailyBackup };
