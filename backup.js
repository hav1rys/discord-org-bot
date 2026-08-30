const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const dates = require('./dates');

const backupsDir = path.join(db.dataDir, 'backups');

if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayStamp() {
  return dates.mskDateStr(new Date());
}

// Копирует текущий data.db в backups/data-ГГГГ-ММ-ДД.db
function backupNow(onError) {
  const dest = path.join(backupsDir, `data-${todayStamp()}.db`);
  try {
    fs.copyFileSync(db.dbPath, dest);
    console.log(`Резервная копия базы данных сохранена: ${dest}`);
    return dest;
  } catch (err) {
    console.error('Не удалось создать резервную копию базы данных:', err.message);
    if (onError) onError(`Не удалось создать резервную копию БД: ${err.message}`);
    return null;
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

  const cutoff = Date.now() - config.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
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

// Планирует запуск в 23:59 по московскому времени каждый день (не по
// времени сервера, где физически крутится бот — так предсказуемее).
// notifyFn(text), если передана, вызывается при сбое.
// onSuccess(filePath), если передана — вызывается при успехе, с путём к
// файлу — используется, чтобы отправить копию в отдельный Discord-канал
// на случай, если сам сайт/сервер бота умрёт (п. "чтобы она не потерялась").
// timeGetter() — необязательная функция, возвращающая строку "HH:MM" МСК из
// настроек (правится в панели → «Настройки»). По умолчанию 23:59.
function scheduleDailyBackup(notifyFn, onSuccess, timeGetter) {
  const nextRun = () => {
    let h = 23; let m = 59;
    try {
      const t = timeGetter && timeGetter();
      const mm = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
      if (mm) { h = Math.min(23, +mm[1]); m = Math.min(59, +mm[2]); }
    } catch (_) {}
    return dates.nextMskTime(h, m).getTime() - Date.now();
  };
  function runAndReschedule() {
    const filePath = backupNow(notifyFn);
    if (filePath && onSuccess) {
      onSuccess(filePath);
    }
    cleanupOldBackups(notifyFn);
    setTimeout(runAndReschedule, nextRun());
  }

  const msUntil = nextRun();
  setTimeout(runAndReschedule, msUntil);
  console.log(`Резервное копирование БД запланировано (через ${Math.round(msUntil / 60000)} мин.)`);
}

// Список файлов резервных копий с датой изменения и размером — для /backup_list
function listBackups() {
  let files;
  try {
    files = fs.readdirSync(backupsDir);
  } catch (err) {
    console.error('Не удалось прочитать папку резервных копий:', err.message);
    return [];
  }

  const result = [];
  for (const file of files) {
    if (!file.startsWith('data-') || !file.endsWith('.db')) continue;
    try {
      const stat = fs.statSync(path.join(backupsDir, file));
      result.push({ name: file, size: stat.size, mtime: stat.mtime });
    } catch (_) {
      // файл мог исчезнуть между readdirSync и statSync — пропускаем
    }
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

// Восстанавливает базу данных из указанного файла бэкапа (перезаписывает
// текущий data.db). Имя файла строго проверяется — берём только то, что
// сами же туда клали, никаких произвольных путей.
function restoreFromBackup(filename) {
  if (!/^data-\d{4}-\d{2}-\d{2}\.db$/.test(filename)) {
    throw new Error('Недопустимое имя файла резервной копии.');
  }
  const src = path.join(backupsDir, filename);
  if (!fs.existsSync(src)) {
    throw new Error('Файл резервной копии не найден.');
  }
  fs.copyFileSync(src, db.dbPath);
  console.log(`База данных восстановлена из резервной копии: ${filename}`);
}

module.exports = { backupNow, cleanupOldBackups, scheduleDailyBackup, listBackups, restoreFromBackup };
