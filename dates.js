// Россия с 2014 года круглый год на UTC+3 (МСК), перевода часов нет —
// поэтому фиксированное смещение, без часовых поясов/библиотек.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

// Сдвигает Date на московское смещение — дальше читать значения нужно
// ТОЛЬКО через getUTC*() (не get*()), иначе локальный часовой пояс
// сервера применится ещё раз поверх этого сдвига.
function toMsk(date) {
  return new Date(date.getTime() + MSK_OFFSET_MS);
}

// "Текущий момент" уже сдвинутый на МСК — читать через getUTC*()
function mskNow() {
  return toMsk(new Date());
}

// 'ГГГГ-ММ-ДД' по московскому календарному дню — для сравнений "уже
// делали сегодня по МСК" независимо от часового пояса сервера
function mskDateStr(date) {
  const d = toMsk(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// День недели (0=вс..6=сб) по московскому времени
function mskWeekday(date) {
  return toMsk(date).getUTCDay();
}

// Строит момент времени, соответствующий Ч:М:С данной даты ИМЕННО по
// московскому времени (обратная операция к toMsk)
function fromMskComponents(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m, d, hh, mm, ss) - MSK_OFFSET_MS);
}

// Ближайшие следующие Ч:ММ по московскому времени (например, 23:59) —
// если сегодняшнее время уже прошло, берёт завтрашний день
function nextMskTime(hh, mm) {
  const now = mskNow();
  let next = fromMskComponents(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0);
  if (next.getTime() <= Date.now()) {
    next = fromMskComponents(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hh, mm, 0);
  }
  return next;
}

// Разбирает "ДД.ММ.ГГГГ" / "ДД.ММ.ГГ" / "ДД.ММ" (год — текущий по МСК),
// разделитель — точка, пробел или "/", в любом сочетании. Возвращает
// {d, m, y} (m — 0-based, как ожидает fromMskComponents) или null.
function parseDateComponents(input) {
  const trimmed = (input || '').trim();
  const match = trimmed.match(/^(\d{1,2})[.\s/](\d{1,2})(?:[.\s/](\d{2}|\d{4}))?$/);
  if (!match) return null;

  const d = Number(match[1]);
  const m = Number(match[2]);
  let y;
  if (match[3] === undefined) {
    y = mskNow().getUTCFullYear(); // год не указан — берём текущий по МСК
  } else if (match[3].length === 2) {
    y = 2000 + Number(match[3]); // короткий год — считаем как 20ХХ
  } else {
    y = Number(match[3]);
  }

  return { d, m: m - 1, y };
}

// Разбирает срок в формате "7d" (N дней от текущего момента) или дату
// (см. parseDateComponents) — конкретная дата, до конца дня по МСК.
// Возвращает Date или null.
function parseDeadline(input) {
  const trimmed = (input || '').trim();

  const daysMatch = trimmed.match(/^(\d+)\s*d$/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    if (days <= 0) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const parts = parseDateComponents(trimmed);
  if (!parts) return null;
  const { d, m, y } = parts;
  const date = fromMskComponents(y, m, d, 23, 59, 59);
  const check = toMsk(date);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m || check.getUTCDate() !== d) return null;
  if (date.getTime() < Date.now()) return null; // нельзя выдать/запросить в прошлом
  return date;
}

// Разбирает только дату (см. parseDateComponents) — для AFK, дата начала,
// без срока — как московская полночь.
function parseDateOnly(input) {
  const parts = parseDateComponents(input);
  if (!parts) return null;
  const { d, m, y } = parts;
  const date = fromMskComponents(y, m, d);
  const check = toMsk(date);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m || check.getUTCDate() !== d) return null;
  return date;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Все отображаемые даты/время — по московскому времени, независимо от
// того, в каком часовом поясе физически работает сервер бота.
function formatDateTime(date) {
  const d = toMsk(date);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatDateOnly(date) {
  const d = toMsk(date);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

module.exports = {
  parseDeadline,
  parseDateOnly,
  formatDateTime,
  formatDateOnly,
  mskNow,
  mskDateStr,
  mskWeekday,
  fromMskComponents,
  nextMskTime,
  MSK_OFFSET_MS,
};
