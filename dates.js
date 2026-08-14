// Разбирает срок в формате "7d" (N дней от текущего момента) или
// "ДД.ММ.ГГГГ" (конкретная дата, до конца дня). Возвращает Date или null.
function parseDeadline(input) {
  const trimmed = (input || '').trim();

  const daysMatch = trimmed.match(/^(\d+)\s*d$/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    if (days <= 0) return null;
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  const dateMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dateMatch) {
    const [, d, m, y] = dateMatch.map(Number);
    const date = new Date(y, m - 1, d, 23, 59, 59);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    if (date.getTime() < Date.now()) return null;
    return date;
  }

  return null;
}

// Разбирает только дату в формате "ДД.ММ.ГГГГ" (для AFK — дата начала, без срока).
function parseDateOnly(input) {
  const trimmed = (input || '').trim();
  const dateMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!dateMatch) return null;
  const [, d, m, y] = dateMatch.map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDateTime(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateOnly(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

module.exports = { parseDeadline, parseDateOnly, formatDateTime, formatDateOnly };
