const { getSetting, setSetting } = require('./db');

const REVERT_MS = 15 * 60 * 1000;

// Вызывать при каждом явном переключении недели (кнопкой). Если ушли с
// текущей недели — заводим таймер на 15 минут; если вернулись на текущую —
// таймер снимается.
async function touchRevertTimer(keyPrefix, weeksAgo) {
  if (weeksAgo === 0) {
    await setSetting(`${keyPrefix}_revert_at`, '');
    return null;
  }
  const revertAt = Date.now() + REVERT_MS;
  await setSetting(`${keyPrefix}_revert_at`, String(revertAt));
  return revertAt;
}

async function getRevertAt(keyPrefix) {
  const v = await getSetting(`${keyPrefix}_revert_at`);
  return v ? Number(v) : null;
}

// Строка с "живым" таймером — Discord сам обновляет отображаемое время у
// клиента, без необходимости редактировать сообщение каждую минуту.
function revertLine(revertAt) {
  if (!revertAt) return null;
  return `⏱️ Вернётся на эту неделю: <t:${Math.floor(revertAt / 1000)}:R>`;
}

async function isExpired(keyPrefix) {
  const revertAt = await getRevertAt(keyPrefix);
  if (!revertAt) return false;
  return Date.now() >= revertAt;
}

module.exports = { touchRevertTimer, getRevertAt, revertLine, isExpired, REVERT_MS };
