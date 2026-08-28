// Синхронизация видимости слэш-команд с самим Discord (чтобы недоступные
// команды не просто отвечали "нет прав", а вообще не показывались в списке
// / у человека). Discord умеет это нативно, но правка прав команд требует
// OAuth2-токена АВТОРИЗОВАННОГО ЧЕЛОВЕКА (не токена бота) — поэтому нужен
// отдельный одноразовый флоу авторизации (см. /discord_права_настроить).

const db = require('./db');

const API_BASE = 'https://discord.com/api/v10';

function getEnv() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri };
}

function missingEnvMessage() {
  const { clientId, clientSecret, redirectUri } = getEnv();
  const missing = [];
  if (!clientId) missing.push('CLIENT_ID');
  if (!clientSecret) missing.push('CLIENT_SECRET');
  if (!redirectUri) missing.push('OAUTH_REDIRECT_URI');
  if (missing.length === 0) return null;
  return `Не заданы переменные окружения: ${missing.join(', ')}. Добавьте их в настройках хостинга (Bothost → Переменные окружения) и перезапустите бота.`;
}

// Ссылка, по которой Владелец один раз проходит авторизацию в браузере
function buildAuthorizeUrl() {
  const { clientId, redirectUri } = getEnv();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'applications.commands.permissions.update',
    prompt: 'consent',
  });
  return `${API_BASE}/oauth2/authorize?${params.toString()}`;
}

async function saveTokens(tokenData, authorizedBy) {
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000 - 60000).toISOString(); // минус минута про запас
  await db.run(
    `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, authorized_by, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, authorized_by = excluded.authorized_by, updated_at = excluded.updated_at`,
    [tokenData.access_token, tokenData.refresh_token, expiresAt, authorizedBy, new Date().toISOString()],
  );
}

// Обменивает код (полученный после ручной авторизации в браузере) на токен
async function exchangeCode(code, authorizedBy) {
  const { clientId, clientSecret, redirectUri } = getEnv();
  const envError = missingEnvMessage();
  if (envError) throw new Error(envError);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord отклонил код авторизации (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  await saveTokens(data, authorizedBy);
}

async function refreshTokens() {
  const { clientId, clientSecret } = getEnv();
  const row = await db.get('SELECT * FROM oauth_tokens WHERE id = 1');
  if (!row || !row.refresh_token) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  });

  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) return null; // придётся авторизоваться заново через /discord_права_настроить

  const data = await res.json();
  await saveTokens(data, row.authorized_by);
  return data.access_token;
}

// Действующий access_token, обновляя его при необходимости; null, если
// авторизация ещё не проходилась или истекла безвозвратно.
async function getValidAccessToken() {
  const row = await db.get('SELECT * FROM oauth_tokens WHERE id = 1');
  if (!row) return null;
  if (new Date(row.expires_at).getTime() > Date.now()) return row.access_token;
  return refreshTokens();
}

async function isAuthorized() {
  const row = await db.get('SELECT id FROM oauth_tokens WHERE id = 1');
  return !!row;
}

// Ставит права ОДНОЙ команды в самом Discord: только перечисленные
// role/user ID видят и могут её использовать (плюс те, у кого есть
// системное право Administrator — Discord всегда даёт им доступ).
async function setCommandPermissions(guildId, applicationId, commandId, allowedRoleIds, allowedUserIds) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Авторизация не пройдена или истекла — выполните /discord_права_настроить заново.');

  const permissions = [
    ...allowedRoleIds.map((id) => ({ id, type: 1, permission: true })), // 1 = ROLE
    ...allowedUserIds.map((id) => ({ id, type: 2, permission: true })), // 2 = USER
  ].slice(0, 100); // ограничение Discord — максимум 100 записей на команду

  const res = await fetch(`${API_BASE}/applications/${applicationId}/guilds/${guildId}/commands/${commandId}/permissions`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permissions }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord отклонил (${res.status}): ${text.slice(0, 300)}`);
  }
}

module.exports = {
  buildAuthorizeUrl,
  missingEnvMessage,
  exchangeCode,
  getValidAccessToken,
  isAuthorized,
  setCommandPermissions,
};
