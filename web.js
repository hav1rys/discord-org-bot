// Сайт «Freelance Company» — вход через Discord OAuth2.
// Лендинг + личный кабинет + панель управления (по уровню доступа) + просмотр
// данных на русском. Работает на process.env.PORT (веб-домен Bothost).
// Без сторонних зависимостей — встроенный http, чтобы не трогать package-lock.

const http = require('http');
const crypto = require('crypto');
const dj = require('discord.js');
const db = require('./db');
const config = require('./config');
const perms = require('./permissions');
const contracts = require('./contracts');
const invitations = require('./invitations');
const giveaways = require('./giveaways');
const passportsLib = require('./passports');
const contentVersions = require('./content_versions');
const content = require('./content');
const dates = require('./dates');
const audit = require('./audit');
const history = require('./history');
const acceptances = require('./acceptances');
const contractsDisplay = require('./contracts_display');
const badges = require('./badges');
const backup = require('./backup');
const faq = require('./faq');
const faqDisplay = require('./faq_display');
const configStore = require('./config_store');
const csvLib = require('./csv');
const { notify: pushNotify, unreadCount, invalidateUnread } = require('./notify');

const OWNER_ID = config.OWNER_USER_ID; // havirys — полный доступ, включая редактор БД

// Функции-хуки из index.js (онбординг/синхронизация ролей), передаются в start().
// Позволяют сайту выполнять те же действия, что и кнопки бота, через уже
// протестированный код, не дублируя его.
let HOOKS = {};
function hook(name) {
  return HOOKS[name] || (async () => { console.error('[web] хук не передан:', name); });
}

const DISCORD_API = 'https://discord.com/api';
const SESSION_DAYS = 7;
const PAGE_SIZE = 30;

// ---------- URL ----------
function baseUrl() {
  const d = process.env.DOMAIN;
  return d ? `https://${d}` : `http://localhost:${process.env.PORT || 3000}`;
}
function redirectUri() {
  return `${baseUrl()}/auth/callback`;
}

// ---------- Сессия: подписанная кука без хранилища ----------
let _sessCache = null;
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (_sessCache) return _sessCache;
  // 6-ю переменную на Bothost не добавить (лимит 5) — выводим стабильный
  // секрет из токена + CLIENT_ID через SHA-256 (сам токен не раскрывается).
  const seed = (process.env.API_TOKEN || process.env.DISCORD_TOKEN || process.env.CLIENT_SECRET || 'insecure-dev-secret')
    + '|' + (process.env.CLIENT_ID || '');
  _sessCache = crypto.createHash('sha256').update(seed).digest('base64url');
  return _sessCache;
}
function sign(b64) {
  return crypto.createHmac('sha256', sessionSecret()).update(b64).digest('base64url');
}
function makeSession(obj) {
  const payload = { ...obj, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}
function readSession(cookieHeader) {
  const m = /(?:^|;\s*)fc_sess=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = sign(b64);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const obj = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function getCookie(cookieHeader, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(cookieHeader || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------- Утилиты ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : dates.formatDateTime(d);
}
const RU_STATUS = {
  pending: 'на рассмотрении', accepted: 'принято', rejected: 'отклонено',
  confirmed: 'подтверждено', disqualified: 'дисквалифицировано',
  fulfilled: 'выполнен', unfulfilled: 'не выполнен',
  active: 'идёт', ended: 'завершён', cancelled: 'отменён',
  open: 'открыт', archived: 'в архиве', approved: 'подтверждено', paused: 'на паузе',
};
function ruStatus(s) {
  return RU_STATUS[s] || s || '—';
}

// ---------- Доступ (уровень по ролям на сервере) ----------
const LEVELS = { guest: 0, member: 1, hr: 2, deputy: 3, owner: 4 };
const accessCache = new Map(); // discordId -> { at, data }

async function accessFor(client, discordId) {
  const cached = accessCache.get(discordId);
  if (cached && Date.now() - cached.at < 30000) return cached.data;

  let level = 'guest';
  let roleNames = [];
  const guild = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
  if (guild) {
    try {
      // из кэша (discord.js держит его свежим по событиям); fetch — только промах
      const member = guild.members.cache.get(discordId) || await guild.members.fetch(discordId);
      roleNames = member.roles.cache.filter((r) => r.name !== '@everyone').map((r) => r.name);
      if (perms.hasBotAccess(member) || member.id === config.OWNER_USER_ID || member.roles.cache.has(config.ROLE_OWNER)) level = 'owner';
      else if (member.roles.cache.has(config.ROLE_DEPUTY)) level = 'deputy';
      else if (member.roles.cache.has(config.ROLE_HR)) level = 'hr';
      else if (config.ROLE_IDS.some((r) => member.roles.cache.has(r)) || (config.ROLE_ORGANIZATION && member.roles.cache.has(config.ROLE_ORGANIZATION))) level = 'member';
    } catch (_) {
      // не на сервере
    }
  }
  if (level === 'guest') {
    const p = await db.get('SELECT id FROM participants WHERE discord_id = ?', [discordId]);
    if (p) level = 'member';
  }
  const data = { level, rank: LEVELS[level], roleNames };
  accessCache.set(discordId, { at: Date.now(), data });
  return data;
}

function roleName(client, id) {
  if (!id) return '—';
  const g = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
  const r = g ? g.roles.cache.get(id) : null;
  return r ? r.name : String(id);
}

// Отображаемое имя участника по Discord ID (из кэша сервера), без обращения к API.
function nickOf(client, id) {
  if (!id) return null;
  const g = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
  const m = g ? g.members.cache.get(String(id)) : null;
  return m ? m.displayName : null;
}
// Кликабельное имя/ссылка на профиль вместо сырого <@id> — в стиле Discord-тега.
function personLink(client, id) {
  if (!id) return '—';
  const nm = nickOf(client, id) || ('ID ' + String(id).slice(-6));
  return `<a class="mention" href="/u/${esc(id)}">@${esc(nm)}</a>`;
}
// Роль в стиле Discord (цветной чип) вместо сырого <@&id>.
function roleTag(client, id) {
  if (!id) return '';
  const g = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
  const r = g ? g.roles.cache.get(String(id)) : null;
  if (!r) return `<span class="mention role">@${esc(String(id))}</span>`;
  let hex = '#' + (r.color || 0).toString(16).padStart(6, '0');
  if (hex === '#000000') hex = '';
  return `<span class="mention role"${hex ? ` style="color:${hex};border-color:${hex}44;background:${hex}1a"` : ''}>@${esc(r.name)}</span>`;
}
// Заменяет <@id> и <@&id> на красивые чипы. Работает и с сырой строкой,
// и с уже экранированной (&lt;@&amp;123&gt;) — детали аудита экранируются до вызова.
function renderMentions(client, s) {
  if (s == null) return s;
  return String(s)
    .replace(/(?:<|&lt;)@&(?:amp;)?(\d+)(?:>|&gt;)/g, (m, rid) => roleTag(client, rid))
    .replace(/(?:<|&lt;)@!?(\d+)(?:>|&gt;)/g, (m, uid) => personLink(client, uid));
}
// Дата регистрации Discord-аккаунта из snowflake-ID (эпоха Discord — 2015-01-01).
function discordAccountCreated(id) {
  try {
    const ms = Number((BigInt(String(id)) >> 22n) + 1420070400000n);
    return Number.isFinite(ms) && ms > 1420070400000 ? new Date(ms) : null;
  } catch (_) { return null; }
}
function accountAgeBadge(id) {
  const d = discordAccountCreated(id);
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  const warn = days < 7;
  return `<span class="badge ${warn ? 'bad' : ''}" title="Аккаунт Discord создан ${fmt(d.toISOString())}">аккаунту ${days} дн.${warn ? ' ⚠' : ''}</span>`;
}
// Онлайн-статус из Discord presence (требует config.ENABLE_PRESENCE + портал-интент).
const PRESENCE_TITLE = { online: 'в сети', idle: 'неактивен', dnd: 'не беспокоить', offline: 'не в сети' };
function onlineStatus(client, id) {
  if (!config.ENABLE_PRESENCE || !id) return null;
  const g = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
  const m = g ? g.members.cache.get(String(id)) : null;
  return m && m.presence ? m.presence.status : 'offline';
}
function onlineDot(client, id) {
  const s = onlineStatus(client, id);
  if (!s) return '';
  return `<span class="pdot ${esc(s)}" title="${esc(PRESENCE_TITLE[s] || s)}"></span>`;
}
// Мини-график (inline SVG) по массиву чисел.
function sparkline(vals, w = 120, h = 26) {
  const a = (vals || []).map((n) => Number(n) || 0);
  if (a.length < 2) return '<span class="mini">—</span>';
  const max = Math.max(1, ...a);
  const step = w / (a.length - 1);
  const pts = a.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="var(--accent2)" stroke-width="1.6"/>
    <circle cx="${(w).toFixed(1)}" cy="${(h - 2 - (a[a.length - 1] / max) * (h - 4)).toFixed(1)}" r="2" fill="var(--accent)"/>
  </svg>`;
}

// Крупный линейный график по точкам [{label, value}] со значением 0..100 (%).
function lineChart(points) {
  const P = (points || []).filter((p) => p && p.value != null);
  if (P.length < 2) return '<p class="mini">Недостаточно данных.</p>';
  const W = 640; const H = 180; const pad = 28;
  const iw = W - pad * 2; const ih = H - pad * 2;
  const step = iw / (points.length - 1);
  const xy = (i, v) => [pad + i * step, pad + ih - (Math.max(0, Math.min(100, v)) / 100) * ih];
  const idxOf = (p) => points.indexOf(p);
  const line = P.map((p) => xy(idxOf(p), p.value).map((n) => n.toFixed(1)).join(',')).join(' ');
  const dots = P.map((p) => { const [x, y] = xy(idxOf(p), p.value); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--accent)"><title>${esc(p.label)}: ${p.value}%</title></circle>`; }).join('');
  const grid = [0, 25, 50, 75, 100].map((g) => { const y = pad + ih - (g / 100) * ih; return `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${W - pad}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="2" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--muted)">${g}%</text>`; }).join('');
  const labels = points.map((p, i) => (i % Math.ceil(points.length / 6) === 0 || i === points.length - 1) ? `<text x="${(pad + i * step).toFixed(1)}" y="${H - 6}" font-size="9" fill="var(--muted)" text-anchor="middle">${esc(String(p.label).slice(5))}</text>` : '').join('');
  return `<div style="overflow-x:auto"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="min-width:520px;max-width:100%">
    ${grid}
    <polyline points="${line}" fill="none" stroke="var(--accent2)" stroke-width="2"/>
    ${dots}${labels}
  </svg></div>`;
}

// ---------- Вёрстка ----------
const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1013;--panel:#17181c;--panel2:#1e2025;--line:#2a2c33;--text:#e9e9ee;
  --muted:#9b9ba6;--accent:#5b6cff;--accent2:#8ea1ff;--ok:#3ecf8e;--bad:#ff6b6b;--warn:#f2c94c;
}
html[data-theme="light"]{
  --bg:#f5f6f8;--panel:#ffffff;--panel2:#eef0f3;--line:#dcdfe4;--text:#1b1c21;
  --muted:#63656e;--accent:#4353d6;--accent2:#3f51c9;--ok:#1f9d63;--bad:#d64545;--warn:#b8891f;
}
@media(prefers-color-scheme:light){
  html:not([data-theme]){
    --bg:#f5f6f8;--panel:#ffffff;--panel2:#eef0f3;--line:#dcdfe4;--text:#1b1c21;
    --muted:#63656e;--accent:#4353d6;--accent2:#3f51c9;--ok:#1f9d63;--bad:#d64545;--warn:#b8891f;
  }
}
html,body{background:var(--bg);color:var(--text)}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent2);text-decoration:none}
a:hover{text-decoration:underline}
.top{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
  gap:14px;padding:12px 20px;background:var(--panel);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top .left,.top .right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{font-weight:800;letter-spacing:.3px;font-size:16px}
.brand b{color:var(--accent2)}
.nav a{color:var(--muted);font-weight:600;font-size:14px;padding:6px 10px;border-radius:8px}
.nav a:hover{color:var(--text);background:var(--panel2);text-decoration:none}
.nav a.on{color:var(--text);background:var(--panel2)}
.btn{display:inline-block;background:var(--accent);color:#fff!important;padding:9px 16px;border-radius:9px;font-weight:700;font-size:14px;border:0;cursor:pointer}
.btn:hover{filter:brightness(1.08);text-decoration:none}
.btn.ghost{background:var(--panel2);color:var(--text)!important;border:1px solid var(--line)}
.btn.sm{padding:6px 12px;font-size:13px}
.wrap{max-width:760px;margin:0 auto;padding:28px 18px 60px}
.wrap.wide{max-width:1040px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
/* Личный кабинет: карточки в 2 колонки на широких экранах, чтобы меньше скроллить */
@media(min-width:900px){ .mecols{column-count:2;column-gap:16px} .mecols>*{break-inside:avoid;-webkit-column-break-inside:avoid} .mecols>.card{margin-top:0} }
h1{font-size:26px;line-height:1.25;margin-bottom:6px;color:var(--text)}
h2{font-size:16px;margin-bottom:12px;color:var(--text)}
h3{color:var(--text)}
.hero{background:linear-gradient(160deg,var(--panel2),var(--panel) 70%);border:1px solid var(--line);border-radius:18px;padding:34px 26px;margin:16px 0}
.hero h1{color:var(--text)}
.hero p{color:var(--muted);max-width:52ch;margin:8px 0 18px}
.muted{color:var(--muted);font-size:13.5px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.tile{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px}
.tile .n{font-size:22px;font-weight:800}
.tile .l{color:var(--muted);font-size:12.5px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:700;font-size:12.5px;text-transform:uppercase;letter-spacing:.4px}
tr:last-child td{border-bottom:0}
.tablewrap{overflow:auto;max-height:75vh;border:1px solid var(--line);border-radius:12px}
.tablewrap table tr:first-child th{position:sticky;top:0;z-index:3;background:var(--panel);box-shadow:inset 0 -1px 0 var(--line)}
.badge{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12.5px}
.badge.ok{color:var(--ok)}
.badge.bad{color:var(--bad)}
.badge.warn{color:var(--warn)}
.pill{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:2px 8px;font-size:12.5px;margin:2px 4px 2px 0}
mark{background:var(--warn);color:#000;border-radius:3px;padding:0 2px}
.feat{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.feat .c{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:16px}
.feat .c h3{font-size:15px;margin-bottom:6px}
.feat .c p{color:var(--muted);font-size:13.5px}
.foot{margin-top:34px;color:var(--muted);font-size:12.5px;text-align:center}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 4px}
.tabs a{padding:7px 12px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);font-weight:600;font-size:13px}
.tabs a.on{color:#fff;background:var(--accent);border-color:var(--accent)}
.pager{display:flex;gap:8px;align-items:center;margin-top:12px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:13px;color:var(--muted);max-height:280px;overflow:auto}
.md blockquote{border-left:3px solid var(--line);padding-left:10px;color:var(--muted);margin:6px 0}
.md ul,.md ol{margin:6px 0 6px 22px}
.md code{background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:.92em}
.md h2,.md h3,.md h4{margin:8px 0 4px}
.md pre{margin:6px 0}
.form label{display:block;margin:10px 0;font-size:13.5px;color:var(--text)}
.form input,.form select,.form textarea{display:block;width:100%;margin-top:5px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:9px 11px;color:var(--text);font:inherit}
.form input:focus,.form select:focus,.form textarea:focus{outline:1px solid var(--accent);border-color:var(--accent)}
.form input[readonly]{opacity:.5}
.form input[type=color]{width:48px;height:34px;padding:2px;border-radius:8px;cursor:pointer;flex:0 0 auto}
.form input[type=checkbox]{width:auto;display:inline-block;margin:0;flex:0 0 auto}
.form label.chk{display:flex;gap:8px;align-items:center;margin:6px 0}
.form button{margin-top:14px}
/* Одиночные поля вне .form (панель, .bar, поиск) — тот же вид, что и в формах */
:where(input[type=text],input[type=search],input[type=number],input[type=date],input[type=time],input[type=datetime-local],input[type=email],input[type=password],input[type=url],input[type=tel],input:not([type]),select,textarea){background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:9px 11px;color:var(--text);font:inherit;max-width:100%}
:where(input,select,textarea):focus-visible{outline:1px solid var(--accent);border-color:var(--accent)}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:16px;height:16px;cursor:pointer}
input[type=search]{-webkit-appearance:none;appearance:none}
/* Панель массовых действий (напр. отпуск выбранным) */
.bulkbar{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:14px}
.bulkbar>.cap{display:block;font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:9px}
.bulkbar .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bulkbar select,.bulkbar input{min-width:0}
.bulkbar input[name=deadline]{width:140px}
.bulkbar input[name=text]{flex:1;min-width:180px}
.bulkbar .hint{margin:8px 0 0;font-size:11.5px;color:var(--muted)}
.bulkbar .cnt{font-weight:700;color:var(--text)}
/* Колонка выбора в таблицах */
th.selcol,td.selcol{width:36px;text-align:center;padding-left:6px;padding-right:6px}
/* Поиск по гайдам */
#faqf{display:block;width:100%;max-width:460px}
.avatar{border-radius:50%;object-fit:cover;border:1px solid var(--line);background:var(--panel2);flex:0 0 auto}
.phead{display:flex;gap:16px;align-items:center;margin-bottom:6px}
.phead h1{margin:0}
.actions{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.actions .form{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px}
.actions h3{font-size:14px;margin-bottom:2px}
.tglbtn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:14px}
.themebox{position:relative;display:inline-block}
.themepop{position:absolute;right:0;top:calc(100% + 8px);z-index:100;width:264px;max-height:78vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 12px 34px rgba(0,0,0,.4)}
.themepop[hidden]{display:none}
.themepop .seg{display:flex;gap:4px;margin-bottom:10px}
.themepop .seg button{flex:1;padding:6px 4px;font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);cursor:pointer}
.themepop .seg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.themepop .crow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0;font-size:12px;color:var(--text)}
.themepop .crow input[type=color]{width:42px;height:26px;padding:1px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);cursor:pointer;flex:0 0 auto}
.themepop .acts{display:flex;gap:6px;margin-top:12px}
.themepop .acts button{flex:1;padding:7px;font-size:12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer}
.themepop .acts button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.themepop .tphead{font-size:12px;color:var(--muted);margin:12px 0 5px}
.themepop .tpresets{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.themepop .tp{display:flex;align-items:center;gap:6px;padding:5px 7px;font-size:11.5px;line-height:1.3;border:1px solid var(--line);border-radius:7px;background:var(--tpb,var(--panel2));color:var(--tpt,var(--text));cursor:pointer;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.themepop .tp::before{content:"";width:9px;height:9px;border-radius:2px;background:var(--tpa,#888);flex:0 0 auto;box-shadow:0 0 0 1px rgba(128,128,128,.45)}
.themepop .tp:hover{border-color:var(--accent)}
.themepop .tp.on{border-color:var(--accent2);box-shadow:inset 0 0 0 1px var(--accent2)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
/* Доски (Miro-подобный редактор схем) */
.beditbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:8px 0}
.beditbar b{font-size:14px}
.beditsp{flex:0 0 8px}
.beditwrap{display:flex;gap:12px;align-items:flex-start}
.bcanvas{position:relative;flex:1;min-width:0;height:74vh;border:1px solid var(--line);border-radius:12px;background:var(--bg);overflow:hidden;touch-action:none;cursor:grab;background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:22px 22px}
.bcanvas:active{cursor:grabbing}
.beditsvg{width:100%;height:100%;display:block}
.benode{cursor:move}
.benode.sel rect{stroke-width:2}
.bhandle{fill:#fff;stroke:var(--accent);stroke-width:1.5;cursor:nwse-resize}
.bctx{position:absolute;z-index:20;display:flex;gap:4px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:5px 7px;box-shadow:0 10px 28px rgba(0,0,0,.45)}
.bctx[hidden]{display:none}
.bctx button{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:6px;min-width:26px;height:26px;font-size:12.5px;cursor:pointer;padding:0 4px;display:inline-flex;align-items:center;justify-content:center}
.bctx button:hover{border-color:var(--accent)}
.bctx .sw{min-width:20px;width:20px;height:20px;border-radius:5px;border:1px solid rgba(0,0,0,.3);padding:0}
.bctx .sw.on{outline:2px solid var(--accent2);outline-offset:1px}
.bctx .sep{width:1px;height:20px;background:var(--line);margin:0 2px}
.bedit{position:absolute;z-index:25;box-sizing:border-box;border:2px solid var(--accent);border-radius:12px;padding:10px 13px;outline:none;overflow:auto;white-space:pre-wrap;word-break:break-word;background:var(--panel2);color:var(--text);line-height:1.34}
.bedit[hidden]{display:none}
.binspect{width:240px;flex:0 0 240px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.binspect textarea,.binspect input,.binspect select{width:100%}
.bview{width:100%;height:70vh;touch-action:none;cursor:grab;background:var(--bg);background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:22px 22px}
.bview svg,.bview .bsvg{width:100%;height:100%;display:block}
@media(max-width:800px){.beditwrap{flex-direction:column}.binspect{width:100%;flex:1 1 auto}}
.chart{display:flex;align-items:flex-end;gap:14px;padding:8px 2px 0;overflow-x:auto}
.chart .col{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:46px;flex:0 0 auto}
.chart .track{height:140px;width:36px;display:flex;align-items:flex-end;background:var(--panel2);border:1px solid var(--line);border-radius:7px;overflow:hidden}
.chart .bar2{display:block;width:100%;background:linear-gradient(180deg,var(--accent2),var(--accent));border-radius:6px 6px 0 0;min-height:3px}
.chart .cap{font-size:11px;color:var(--muted);text-align:center;white-space:nowrap;max-width:70px;overflow:hidden;text-overflow:ellipsis}
.chart .val{font-size:12px;font-weight:700}
.mini{font-size:12px;color:var(--muted)}
.mention{display:inline-block;background:var(--panel2);color:var(--accent2);border:1px solid var(--line);border-radius:6px;padding:0 5px;font-weight:600;font-size:.94em;line-height:1.5;text-decoration:none}
.mention:hover{background:var(--line);text-decoration:none}
@supports (background:color-mix(in srgb,red,blue)){
  .mention{background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
  .mention:hover{background:color-mix(in srgb,var(--accent) 28%,transparent)}
  .mention.role{background:color-mix(in srgb,var(--accent) 12%,transparent)}
}
.sitebanner{position:relative;background:var(--accent);color:#fff;padding:10px 40px 10px 20px;text-align:center;font-size:14px;font-weight:600}
.sitebanner .md{display:inline}
.sitebanner .md a{color:#fff;text-decoration:underline}
.sitebanner .md br{display:none}
.sitebanner .x{position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;opacity:.8;font-weight:400}
.sitebanner .x:hover{opacity:1}
.heat{display:grid;grid-template-columns:auto repeat(24,1fr);gap:2px;font-size:10px}
.heat .hc{width:100%;aspect-ratio:1;border-radius:2px;background:var(--accent)}
.heat .hl{color:var(--muted);padding-right:4px;white-space:nowrap;align-self:center}
.progress{height:8px;background:var(--panel2);border:1px solid var(--line);border-radius:999px;overflow:hidden;margin:4px 0}
.progress>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.mdprev{border:1px dashed var(--line);border-radius:8px;padding:10px 12px;margin-top:6px;background:var(--panel2);font-size:13.5px}
.mdprev::before{content:"предпросмотр";display:block;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:6px}
.mdprev img{max-width:100%;border-radius:6px}
.md img{max-width:100%;border-radius:6px}
.pdot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#747f8d;vertical-align:middle;margin-right:5px;flex:0 0 auto}
.pdot.online{background:#3ba55d}.pdot.idle{background:#faa61a}.pdot.dnd{background:#ed4245}.pdot.offline{background:#747f8d}
.spark{display:inline-block;vertical-align:middle}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:var(--text)}
th.sortable .ar{opacity:.5;font-size:10px}
@media print{
  .top,.sitebanner,.tabs,.foot,.form,.btn{display:none!important}
  .card{break-inside:avoid;border-color:#ccc}
  body{background:#fff;color:#000}
}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(8px);z-index:200;max-width:92vw;
  padding:12px 18px;border-radius:12px;font-weight:600;font-size:14px;box-shadow:0 10px 34px rgba(0,0,0,.4);
  background:var(--panel);border:1px solid var(--line);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.ok{border-color:#1f7d55;color:var(--ok)}
.toast.bad{border-color:#a33;color:var(--bad)}
#totop{position:fixed;right:16px;bottom:16px;z-index:150;width:40px;height:40px;border-radius:50%;border:1px solid var(--line);
  background:var(--panel);color:var(--text);font-size:18px;cursor:pointer;display:none;box-shadow:0 6px 20px rgba(0,0,0,.35)}
#totop.show{display:block}
#navtoggle{display:none;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;font-size:16px;cursor:pointer}
@media(max-width:760px){
  #navtoggle{display:inline-block}
  #navtoggle + .left.nav{display:none;position:absolute;left:0;right:0;top:100%;flex-direction:column;align-items:stretch;
    gap:2px;background:var(--panel);border-bottom:1px solid var(--line);padding:8px 12px;z-index:80}
  #navtoggle + .left.nav.open{display:flex}
  .top{position:relative;flex-wrap:wrap}
}
@media(max-width:640px){
  .wrap{padding:18px 12px 48px}
  .top{padding:10px 12px}
  .actions{grid-template-columns:1fr}
  .phead{flex-wrap:wrap;gap:12px}
  h1{font-size:22px}
  .grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
}
`;

// Кнопка «Оформление» в шапке: режим темы + свои цвета (только этот браузер).
function themeToggle() {
  const rows = Object.keys(THEME_DEFAULTS)
    .map((k) => `<div class="crow"><span>${esc(THEME_LABELS[k])}</span><input type="color" data-k="${k}" value="${THEME_DEFAULTS[k]}"></div>`)
    .join('');
  const presets = Object.keys(THEME_PRESETS).map((pn) => {
    const pr = { ...THEME_DEFAULTS, ...THEME_PRESETS[pn] };
    const c = JSON.stringify(pr).replace(/"/g, '&quot;');
    return `<button type="button" class="tp" data-p="${pn}" data-c="${c}" style="--tpb:${pr.panel};--tpt:${pr.text};--tpa:${pr.accent}" onclick="fcPreset(this)">${esc(PRESET_LABELS[pn] || pn)}</button>`;
  }).join('');
  return `<div class="themebox">
    <button class="tglbtn" type="button" onclick="fcThemeMenu(event)" title="Оформление сайта">🎨</button>
    <div class="themepop" id="themepop" hidden>
      <div class="seg" id="fcModeSeg">
        <button type="button" data-m="auto" onclick="fcSetMode('auto')">Авто</button>
        <button type="button" data-m="light" onclick="fcSetMode('light')">Светлая</button>
        <button type="button" data-m="dark" onclick="fcSetMode('dark')">Тёмная</button>
      </div>
      <div class="tphead">Готовые темы — в один клик</div>
      <div class="tpresets">${presets}</div>
      <div class="mini" style="margin:12px 0 4px">Или свои цвета — только в этом браузере</div>
      ${rows}
      <div class="acts">
        <button type="button" class="primary" onclick="fcColorsApply()">Применить</button>
        <button type="button" onclick="fcColorsReset()">Сброс</button>
      </div>
    </div>
  </div>`;
}
const CLIENT_SCRIPT = `
(function(){
  var d=document.documentElement;
  function apply(m){ if(m==='light')d.setAttribute('data-theme','light'); else if(m==='dark')d.setAttribute('data-theme','dark'); else d.removeAttribute('data-theme'); }
  var mode='auto'; try{mode=localStorage.getItem('fc_theme')||'auto';}catch(e){}
  apply(mode);
  function readColors(){ try{ var pc=JSON.parse(localStorage.getItem('fc_colors')||'null'); return (pc&&typeof pc==='object')?pc:{}; }catch(e){ return {}; } }
  function applyColors(pc){ for(var k in pc){ if(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(pc[k])) d.style.setProperty('--'+k,pc[k]); } }
  applyColors(readColors());
  function pop(){ return document.getElementById('themepop'); }
  function syncSeg(){ var seg=document.getElementById('fcModeSeg'); if(!seg)return; var b=seg.querySelectorAll('button');
    for(var i=0;i<b.length;i++) b[i].className=(b[i].getAttribute('data-m')===mode)?'on':''; }
  function fillInputs(){ var pc=readColors(), cs=getComputedStyle(d), ins=document.querySelectorAll('#themepop input[data-k]');
    for(var i=0;i<ins.length;i++){ var k=ins[i].getAttribute('data-k');
      var v=pc[k]||(cs.getPropertyValue('--'+k)||'').trim()||ins[i].value;
      var mm=v.match(/^#([0-9a-fA-F]{3})$/); if(mm)v='#'+mm[1][0]+mm[1][0]+mm[1][1]+mm[1][1]+mm[1][2]+mm[1][2];
      if(/^#[0-9a-fA-F]{6}$/.test(v)) ins[i].value=v; } }
  function syncPresets(){ var pc=readColors(), btns=document.querySelectorAll('#themepop .tp');
    for(var i=0;i<btns.length;i++){ var c={}; try{c=JSON.parse(btns[i].getAttribute('data-c'));}catch(e){}
      var match=Object.keys(c).length>0;
      for(var k in c){ if((String(pc[k]||'')).toLowerCase()!==(String(c[k]||'')).toLowerCase()){ match=false; break; } }
      if(btns[i].getAttribute('data-p')==='default') match=Object.keys(pc).length===0;
      btns[i].className=match?'tp on':'tp'; } }
  window.fcThemeMenu=function(ev){ if(ev)ev.stopPropagation(); var p=pop(); if(!p)return;
    if(p.hasAttribute('hidden')){ p.removeAttribute('hidden'); syncSeg(); fillInputs(); syncPresets();
      p.style.right=''; p.style.left='';
      var r=p.getBoundingClientRect();
      if(r.left<6){ p.style.right='auto'; p.style.left='0'; }
    } else { p.setAttribute('hidden',''); } };
  window.fcSetMode=function(m){ mode=m; apply(m); try{localStorage.setItem('fc_theme',m);}catch(e){} syncSeg(); };
  window.fcPreset=function(btn){ var c; try{c=JSON.parse(btn.getAttribute('data-c'));}catch(e){ return; }
    var o={}; for(var k in c){ if(/^#([0-9a-fA-F]{6})$/.test(c[k])){ o[k]=c[k]; d.style.setProperty('--'+k,c[k]); } }
    try{localStorage.setItem('fc_colors',JSON.stringify(o));}catch(e){}
    fillInputs(); syncPresets(); };
  window.fcColorsApply=function(){ var o={}, ins=document.querySelectorAll('#themepop input[data-k]');
    for(var i=0;i<ins.length;i++) o[ins[i].getAttribute('data-k')]=ins[i].value;
    try{localStorage.setItem('fc_colors',JSON.stringify(o));}catch(e){} applyColors(o); syncPresets(); };
  window.fcColorsReset=function(){ try{localStorage.removeItem('fc_colors');}catch(e){} location.reload(); };
  // Фильтр FAQ: прячет карточки и пустые заголовки категорий, показывает «ничего не найдено».
  window.fcFaqFilter=function(q){ q=(q||'').toLowerCase().trim();
    var items=document.querySelectorAll('.faq-item'), shown=0;
    for(var i=0;i<items.length;i++){ var m=!q||items[i].dataset.faq.indexOf(q)>=0; items[i].style.display=m?'':'none'; if(m)shown++; }
    var cats=document.querySelectorAll('.faq-cat');
    for(var j=0;j<cats.length;j++){ var el=cats[j].nextElementSibling, any=false;
      while(el&&!el.classList.contains('faq-cat')){ if(el.classList.contains('faq-item')&&el.style.display!=='none')any=true; el=el.nextElementSibling; }
      cats[j].style.display=(q&&!any)?'none':''; }
    var none=document.getElementById('faqnone'); if(none)none.style.display=(q&&shown===0)?'':'none'; };
  // Загрузка картинки одной формой: читает файл из input[name=fileName],
  // сжимает до maxPx, кладёт data-URI в input[name=hidName] и отправляет форму.
  window.fcImgUpload=function(form, fileName, hidName, maxPx, mime){
    var inp=form[fileName], file=inp&&inp.files&&inp.files[0];
    if(!file){ alert('Выберите файл-картинку.'); return false; }
    var img=new Image(), url=URL.createObjectURL(file);
    img.onload=function(){
      var s=Math.min(1,(maxPx||512)/Math.max(img.width,img.height));
      var c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(img.width*s)); c.height=Math.max(1,Math.round(img.height*s));
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      try{ form[hidName].value=c.toDataURL(mime||'image/png', 0.85); }catch(e){ alert('Не удалось обработать файл.'); URL.revokeObjectURL(url); return; }
      if(form.filename && file.name) form.filename.value=file.name;
      URL.revokeObjectURL(url); form.submit();
    };
    img.onerror=function(){ URL.revokeObjectURL(url); alert('Это не картинка.'); };
    img.src=url;
    return false;
  };
  document.addEventListener('click',function(e){ var p=pop(); if(!p||p.hasAttribute('hidden'))return;
    if(!p.contains(e.target)&&!(e.target.closest&&e.target.closest('.themebox'))) p.setAttribute('hidden',''); });
  try{
    var b=document.getElementById('sitebanner');
    if(b){ var key='fc_ban_'+(b.dataset.h||'');
      if(localStorage.getItem(key))b.style.display='none';
      var x=b.querySelector('.x'); if(x)x.onclick=function(){b.style.display='none';try{localStorage.setItem(key,'1');}catch(e){}};
    }
  }catch(e){}
  document.addEventListener('DOMContentLoaded',function(){
    // Тост из ?ok/?err + чистим URL
    try{
      var t=document.querySelector('[data-toast]');
      if(t){ requestAnimationFrame(function(){t.classList.add('show');});
        setTimeout(function(){t.classList.remove('show');setTimeout(function(){t.remove();},300);},4200);
        if(history.replaceState){ var u=new URL(location.href); u.searchParams.delete('ok'); u.searchParams.delete('err'); history.replaceState(null,'',u.pathname+u.search+u.hash); }
      }
    }catch(e){}
    // Кнопка «наверх»
    try{
      var tt=document.getElementById('totop');
      if(tt){ tt.onclick=function(){window.scrollTo({top:0,behavior:'smooth'});};
        var onScroll=function(){ tt.classList.toggle('show', window.scrollY>500); };
        window.addEventListener('scroll',onScroll,{passive:true}); onScroll();
      }
    }catch(e){}
    // Число непрочитанных в заголовок вкладки
    try{
      var bl=document.querySelector('.top .right .tglbtn b');
      var n=bl?parseInt(bl.textContent,10):0;
      if(n>0) document.title='('+n+') '+document.title;
    }catch(e){}
    // PWA: регистрируем service worker и показываем кнопку «Установить приложение»
    try{
      if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function(){});
      var deferredPrompt=null;
      window.addEventListener('beforeinstallprompt',function(e){
        e.preventDefault(); deferredPrompt=e;
        var b=document.createElement('button');
        b.textContent='📲 Установить приложение'; b.className='btn ghost sm';
        b.style.cssText='position:fixed;left:16px;bottom:16px;z-index:150';
        b.onclick=function(){ b.remove(); if(deferredPrompt){deferredPrompt.prompt();deferredPrompt=null;} };
        document.body.appendChild(b);
        window.addEventListener('appinstalled',function(){ try{b.remove();}catch(_){} });
      });
    }catch(e){}
    // Клавиатурная навигация по вкладкам (.tabs): ← → между ссылками, Home/End
    try{
      document.querySelectorAll('.tabs').forEach(function(tb){
        var links=[].slice.call(tb.querySelectorAll('a'));
        if(!links.length)return;
        tb.setAttribute('role','navigation');
        links.forEach(function(a){
          a.addEventListener('keydown',function(e){
            var i=links.indexOf(a),n=null;
            if(e.key==='ArrowRight'||e.key==='ArrowDown')n=links[(i+1)%links.length];
            else if(e.key==='ArrowLeft'||e.key==='ArrowUp')n=links[(i-1+links.length)%links.length];
            else if(e.key==='Home')n=links[0];
            else if(e.key==='End')n=links[links.length-1];
            if(n){e.preventDefault();n.focus();}
          });
        });
      });
    }catch(e){}
    // Командная палитра: Ctrl+K / Cmd+K
    try{
      var PAL=[
        ['Мой профиль','/me'],['Участники','/people'],['Розыгрыши','/giveaways'],['FAQ / Гайды','/faq'],
        ['Команды','/commands'],['Уведомления','/notifications'],['Сравнение','/compare'],['Правила','/text/rules'],
        ['Дашборд','/dashboard'],['Тикеты','/tickets'],['Календарь','/calendar'],['Поиск везде','/search'],
        ['Аудит','/audit'],['Лидерборды','/leaderboards'],['Здоровье системы','/health'],['Инструменты','/tools'],
        ['Панель','/panel'],['Панель — Заявки','/panel?tab=apps'],['Панель — Очереди','/panel?tab=queues'],
        ['Панель — Контракты (проверка)','/panel?tab=contracts_check'],['Панель — Формы','/panel?tab=forms'],
        ['Панель — Доступы','/panel?tab=grants'],['Панель — Аккаунты','/panel?tab=accounts'],
        ['Сообщить о баге','/bug'],['Скачать мои данные','/me/export.json']
      ];
      var ov=null,inp=null,lst=null,sel=0,items=[];
      function close(){ if(ov){ov.remove();ov=null;} }
      function build(){
        ov=document.createElement('div');
        ov.style.cssText='position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh';
        ov.innerHTML='<div style="width:min(560px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)">'
          +'<input id="palInp" placeholder="Куда перейти…" style="width:100%;border:0;padding:14px 16px;font-size:15px;background:var(--panel);color:var(--text);outline:none">'
          +'<div id="palList" style="max-height:52vh;overflow:auto"></div></div>';
        document.body.appendChild(ov);
        inp=ov.querySelector('#palInp'); lst=ov.querySelector('#palList');
        ov.addEventListener('click',function(e){ if(e.target===ov)close(); });
        inp.addEventListener('input',render); inp.addEventListener('keydown',keys);
        inp.focus(); render();
      }
      function render(){
        var q=(inp.value||'').toLowerCase().trim();
        items=PAL.filter(function(p){return !q||p[0].toLowerCase().indexOf(q)>=0||p[1].indexOf(q)>=0;}).slice(0,40);
        if(q&&/^\\d{5,}$/.test(q)) items.unshift(['Профиль ID '+q,'/u/'+q]);
        sel=0;
        lst.innerHTML=items.map(function(p,i){return '<div class="palrow" data-i="'+i+'" style="padding:9px 16px;cursor:pointer;'+(i===0?'background:var(--panel2)':'')+'">'+p[0].replace(/</g,'&lt;')+' <span class="mini" style="opacity:.6">'+p[1]+'</span></div>';}).join('')||'<div style="padding:12px 16px" class="mini">ничего не найдено</div>';
        Array.prototype.forEach.call(lst.querySelectorAll('.palrow'),function(r){ r.onclick=function(){ go(+r.dataset.i); }; });
      }
      function mark(){ Array.prototype.forEach.call(lst.querySelectorAll('.palrow'),function(r,i){ r.style.background=i===sel?'var(--panel2)':''; }); var a=lst.querySelector('.palrow[data-i="'+sel+'"]'); if(a)a.scrollIntoView({block:'nearest'}); }
      function go(i){ var p=items[i]; if(p){ location.href=p[1]; } }
      function keys(e){
        if(e.key==='Escape'){close();return;}
        if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,items.length-1);mark();}
        else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);mark();}
        else if(e.key==='Enter'){e.preventDefault();go(sel);}
      }
      document.addEventListener('keydown',function(e){
        if((e.ctrlKey||e.metaKey)&&(e.key==='k'||e.key==='K')){ e.preventDefault(); if(ov)close(); else build(); }
      });
    }catch(e){}
    // Недавно просмотренные профили (только в этом браузере)
    try{
      var mProf=location.pathname.match(/^\\/u\\/([0-9]+)$/);
      var recent=JSON.parse(localStorage.getItem('fc_recent')||'[]'); if(!Array.isArray(recent))recent=[];
      if(mProf){
        var nm=(document.querySelector('.phead h1')||document.querySelector('h1'));
        nm=nm?nm.textContent.replace(/\\s+/g,' ').trim().slice(0,40):mProf[1];
        recent=recent.filter(function(x){return x&&x.id!==mProf[1];});
        recent.unshift({id:mProf[1],name:nm}); recent=recent.slice(0,8);
        localStorage.setItem('fc_recent',JSON.stringify(recent));
      }
      var box=document.getElementById('fc-recent');
      if(box&&recent.length){
        box.innerHTML='<span class="mini">Недавно смотрели:</span> '+recent.map(function(x){
          return '<a class="pill" href="/u/'+encodeURIComponent(x.id)+'">'+(x.name||x.id).replace(/</g,'&lt;')+'</a>';
        }).join(' ');
      }
    }catch(e){}
    // Защита от двойной отправки: форма без onsubmit блокируется на 6 сек
    try{
      document.querySelectorAll('form').forEach(function(f){
        if(f.getAttribute('onsubmit')||f.method.toLowerCase()!=='post')return;
        f.addEventListener('submit',function(){
          if(f.dataset.sent){ return; }
          f.dataset.sent='1';
          var b=f.querySelector('button[type=submit],button:not([type])');
          if(b){ b.disabled=true; var o=b.textContent; b.textContent='…'; setTimeout(function(){b.disabled=false;b.textContent=o;f.dataset.sent='';},6000); }
        });
      });
    }catch(e){}
    var tas=document.querySelectorAll('textarea[data-md]');
    for(var i=0;i<tas.length;i++)(function(ta){
      var pv=document.createElement('div'); pv.className='mdprev';
      pv.innerHTML='<div class="mini">предпросмотр…</div>';
      ta.parentNode.insertBefore(pv, ta.nextSibling);
      var tmr;
      function upd(){ clearTimeout(tmr); tmr=setTimeout(function(){
        fetch('/md/preview',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'text='+encodeURIComponent(ta.value)})
          .then(function(r){return r.text();}).then(function(h){pv.innerHTML=h||'<div class="mini">—</div>';}).catch(function(){});
      },250); }
      ta.addEventListener('input',upd); upd();
    })(tas[i]);
    // Клиентская сортировка таблиц: клик по заголовку. Пропускаем table[data-nosort].
    var tbls=document.querySelectorAll('.tablewrap table');
    for(var t=0;t<tbls.length;t++)(function(tb){
      if(tb.hasAttribute('data-nosort'))return;
      var head=tb.rows[0]; if(!head||head.cells.length<2)return;
      var body=tb.tBodies[0]||tb;
      if(head.querySelector('a'))return; // серверная сортировка (редактор БД) — не трогаем
      for(var ci=0;ci<head.cells.length;ci++)(function(idx){
        var th=head.cells[idx]; if(th.tagName!=='TH')return;
        th.className=(th.className?th.className+' ':'')+'sortable';
        th.insertAdjacentHTML('beforeend',' <span class="ar"></span>');
        th.addEventListener('click',function(){
          var rows=[]; for(var r=0;r<body.rows.length;r++){ if(body.rows[r]===head)continue; rows.push(body.rows[r]); }
          var dir=th.getAttribute('data-dir')==='asc'?'desc':'asc';
          for(var c2=0;c2<head.cells.length;c2++){head.cells[c2].removeAttribute('data-dir');var s=head.cells[c2].querySelector('.ar');if(s)s.textContent='';}
          th.setAttribute('data-dir',dir);
          var ar=th.querySelector('.ar'); if(ar)ar.textContent=dir==='asc'?'▲':'▼';
          rows.sort(function(a,b){
            var x=(a.cells[idx]?a.cells[idx].textContent:'').trim(), y=(b.cells[idx]?b.cells[idx].textContent:'').trim();
            var nx=parseFloat(x.replace(/[^0-9.,-]/g,'').replace(',','.')), ny=parseFloat(y.replace(/[^0-9.,-]/g,'').replace(',','.'));
            var cmp;
            if(!isNaN(nx)&&!isNaN(ny)&&x!==''&&y!=='') cmp=nx-ny; else cmp=x.localeCompare(y,'ru');
            return dir==='asc'?cmp:-cmp;
          });
          for(var k=0;k<rows.length;k++) body.appendChild(rows[k]);
        });
      })(ci);
    })(tbls[t]);
  });
  try{
    var p=location.pathname, s=location.search;
    if(p==='/panel'&&s.indexOf('tab=')<0){ var lt=localStorage.getItem('fc_panel_tab'); if(lt)location.replace('/panel?tab='+encodeURIComponent(lt)); }
    if(p==='/panel'){ var m=s.match(/tab=([^&]+)/); if(m)localStorage.setItem('fc_panel_tab',decodeURIComponent(m[1])); }
  }catch(e){}
})();`;

// ---------- Discord-подобное форматирование текста ----------
// Часто используемые в Discord :shortcode: → эмодзи.
const EMOJI_SHORTCODES = {
  pencil2: '✏️', pencil: '✏️', memo: '📝', writing_hand: '✍️',
  white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', negative_squared_cross_mark: '❎', no_entry: '⛔', no_entry_sign: '🚫',
  warning: '⚠️', bell: '🔔', no_bell: '🔕', lock: '🔒', unlock: '🔓', key: '🔑',
  tada: '🎉', confetti_ball: '🎊', sparkles: '✨', fire: '🔥', star: '⭐', star2: '🌟',
  trophy: '🏆', medal: '🏅', crown: '👑', shield: '🛡️', gem: '💎',
  mag: '🔍', mag_right: '🔎', bulb: '💡', bookmark: '🔖', clipboard: '📋',
  calendar: '📅', date: '📅', spiral_calendar_pad: '🗓️', alarm_clock: '⏰', hourglass: '⏳',
  ticket: '🎫', tickets: '🎟️', package: '📦', gift: '🎁', moneybag: '💰', dollar: '💵',
  gear: '⚙️', wrench: '🔧', hammer: '🔨', hammer_and_wrench: '🛠️', rocket: '🚀',
  bust_in_silhouette: '👤', busts_in_silhouette: '👥', wave: '👋', eyes: '👀',
  point_right: '👉', point_left: '👈', point_up: '👆', point_down: '👇',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️',
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', ok_hand: '👌', pray: '🙏', handshake: '🤝',
  information_source: 'ℹ️', question: '❓', grey_question: '❔', exclamation: '❗', bangbang: '‼️',
  bar_chart: '📊', chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉',
  loudspeaker: '📢', mega: '📣', speech_balloon: '💬', envelope: '✉️', inbox_tray: '📥', outbox_tray: '📤',
  beach_umbrella: '🏖️', palm_tree: '🌴', zzz: '💤', hourglass_flowing_sand: '⏳',
  clock: '🕐', stopwatch: '⏱️', chains: '⛓️', link: '🔗', paperclip: '📎',
  robot: '🤖', desktop: '🖥️', computer: '💻', iphone: '📱', printer: '🖨️',
  zero: '0️⃣', one: '1️⃣', two: '2️⃣', three: '3️⃣', four: '4️⃣', five: '5️⃣',
  six: '6️⃣', seven: '7️⃣', eight: '8️⃣', nine: '9️⃣', ten: '🔟', keycap_ten: '🔟',
  hash: '#️⃣', asterisk: '*️⃣', '100': '💯',
  first_place: '🥇', second_place: '🥈', third_place: '🥉',
  heavy_plus_sign: '➕', heavy_minus_sign: '➖', heavy_multiplication_x: '✖️', heavy_division_sign: '➗',
  red_circle: '🔴', green_circle: '🟢', large_yellow_circle: '🟡', large_blue_circle: '🔵',
  white_circle: '⚪', black_circle: '⚫', small_orange_diamond: '🔸', small_blue_diamond: '🔹',
  round_pushpin: '📍', pushpin: '📌', checkered_flag: '🏁', triangular_flag_on_post: '🚩',
  page_facing_up: '📄', page_with_curl: '📃', bookmark_tabs: '📑', scroll: '📜', ledger: '📒',
  arrow_forward: '▶️', arrow_backward: '◀️', repeat: '🔁', recycle: '♻️',
};
function replaceShortcodes(str) {
  return str.replace(/:([a-z0-9_+-]{1,32}):/g, (m, name) => (EMOJI_SHORTCODES[name] || m));
}
function mdInline(s) {
  return replaceShortcodes(s)
    .replace(/!\[([^\]\n]*)\]\(((?:https?:)?\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]\n]+)\]\(((?:https?:)?\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // «текст(https://…)» без квадратных скобок — делаем сам «текст» ссылкой,
    // а URL прячем. «текст» обязан начинаться и заканчиваться буквой/цифрой,
    // чтобы не хватать голую пунктуацию вроде «см. (https://…)».
    .replace(/([\p{L}\p{N}][\p{L}\p{N}._-]{0,58})\(((?:https?:\/\/|www\.)[^\s)]+)\)/gu,
      (m, txt, u) => `<a href="${u.startsWith('www.') ? 'https://' + u : u}" target="_blank" rel="noopener">${txt}</a>`)
    // голые ссылки в тексте
    .replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<)]+[^\s<).,;:!?"'])/g, (m, pre, u) => `${pre}<a href="${u.startsWith('www.') ? 'https://' + u : u}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<i>$2</i>');
}
function mdToHtml(src) {
  const text = esc(String(src || ''));
  const blocks = [];
  const t = text.replace(/```([\s\S]*?)```/g, (m, code) => { blocks.push(`<pre>${code.replace(/^\n/, '')}</pre>`); return `%%CODEBLK${blocks.length - 1}%%`; });
  const out = [];
  let inUl = false; let inOl = false;
  const closeLists = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^\s*-#\s+(.*)$/))) { closeLists(); out.push(`<div class="mini" style="margin:2px 0">${mdInline(m[1])}</div>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    closeLists();
    if ((m = line.match(/^\s*(#{1,3})\s+(.*)$/))) { const lv = m[1].length + 1; out.push(`<h${lv}>${mdInline(m[2])}</h${lv}>`); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { out.push(`<blockquote>${mdInline(m[1])}</blockquote>`); continue; }
    if (line === '') { out.push('<br>'); continue; }
    out.push(mdInline(line) + '<br>');
  }
  closeLists();
  let html = `<div class="md">${out.join('\n').replace(/%%CODEBLK(\d+)%%/g, (mm, i) => blocks[+i] || '')}</div>`;
  // <@&id> / <@id> в пользовательских текстах → красивые чипы (а не сырой тег).
  if (_mdClient) { try { html = renderMentions(_mdClient, html); } catch (_) {} }
  return html;
}
let _mdClient = null;

// Простой построчный diff (LCS) → HTML. Для истории версий страниц.
function lineDiffHtml(oldText, newText) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const n = a.length; const m = b.length;
  // Защита от OOM на огромном тексте — LCS-таблица O(n*m).
  if (n > 1500 || m > 1500) {
    const mx = Math.max(n, m);
    const out2 = [];
    for (let k = 0; k < mx; k++) {
      const oldL = a[k]; const newL = b[k];
      if (oldL === newL) out2.push(`<div style="white-space:pre-wrap;font-family:monospace;font-size:12.5px">  ${esc(oldL || '') || '&nbsp;'}</div>`);
      else {
        if (oldL !== undefined) out2.push(`<div style="background:color-mix(in srgb,var(--bad) 22%,transparent);white-space:pre-wrap;font-family:monospace;font-size:12.5px">− ${esc(oldL) || '&nbsp;'}</div>`);
        if (newL !== undefined) out2.push(`<div style="background:color-mix(in srgb,var(--ok) 22%,transparent);white-space:pre-wrap;font-family:monospace;font-size:12.5px">+ ${esc(newL) || '&nbsp;'}</div>`);
      }
    }
    return out2.join('') || '<span class="muted">Различий нет.</span>';
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0;
  const line = (cls, pre, s) => `<div style="${cls}white-space:pre-wrap;font-family:monospace;font-size:12.5px">${pre}${esc(s) || '&nbsp;'}</div>`;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(line('', '  ', a[i])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(line('background:color-mix(in srgb,var(--bad) 22%,transparent);', '− ', a[i])); i++; }
    else { out.push(line('background:color-mix(in srgb,var(--ok) 22%,transparent);', '+ ', b[j])); j++; }
  }
  while (i < n) { out.push(line('background:color-mix(in srgb,var(--bad) 22%,transparent);', '− ', a[i++])); }
  while (j < m) { out.push(line('background:color-mix(in srgb,var(--ok) 22%,transparent);', '+ ', b[j++])); }
  return out.join('') || '<span class="muted">Различий нет.</span>';
}

// ---------- Настройки сайта (правит havirys, лежат в settings) ----------
const THEME_KEYS = ['bg', 'panel', 'panel2', 'line', 'text', 'muted', 'accent', 'accent2', 'ok', 'bad', 'warn'];
let SITE = { color: {} };
let _siteAt = 0;
async function loadSite(force) {
  if (!force && Date.now() - _siteAt < 30000) return SITE;
  const next = { color: {}, _navPages: [] };
  try {
    const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'site.%'");
    for (const r of rows) {
      if (r.key.startsWith('site.color.')) {
        const k = r.key.slice(11);
        if (r.value && /^#[0-9a-fA-F]{6}$/.test(r.value)) next.color[k] = r.value;
      } else {
        const k = r.key.slice(5);
        if (r.value != null && r.value !== '') next[k] = r.value;
      }
    }
    next._navPages = await db.all("SELECT slug, title FROM site_pages WHERE nav = 1 AND COALESCE(published, 1) = 1").catch(() => []);
  } catch (_) {}
  SITE = next;
  _siteAt = Date.now();
  return SITE;
}
function siteBrand() { return SITE.brand || config.SITE_BRAND; }
function siteInvite() { return SITE.invite || config.SITE_DISCORD_INVITE; }
function themeOverrideCss() {
  const c = SITE.color || {};
  const d = Object.keys(c).filter((k) => THEME_KEYS.includes(k)).map((k) => `--${k}:${c[k]}`).join(';');
  return d ? `:root{${d}}` : '';
}
function brandHtml() {
  const logo = SITE.logo && /^(https?:|data:image\/)/.test(SITE.logo)
    ? `<img src="${esc(SITE.logo)}" alt="" style="height:22px;vertical-align:middle;border-radius:4px;margin-right:6px">` : '';
  const parts = siteBrand().trim().split(/\s+/);
  const txt = parts.length > 1
    ? `<b>${esc(parts[0])}</b> ${esc(parts.slice(1).join(' '))}`
    : `<b>${esc(siteBrand())}</b>`;
  return logo + txt;
}
// Стандартное меню в текстовом виде — для предзаполнения редактора в панели.
const DEFAULT_NAV_TEXT = [
  'Мой профиль | /me | all',
  'Участники | /people | member',
  'Розыгрыши | /giveaways | all',
  'FAQ | /faq | all',
  'Команды | /commands | member',
  'Дашборд | /dashboard | hr',
  'Тикеты | /tickets | hr',
  'Заявки | /panel?tab=apps | hr',
  'Контракты | /panel?tab=contracts_check | hr',
  'Панель | /panel | hr',
].join('\n');
function navItems(level, panelGrant) {
  if (SITE.nav && SITE.nav.trim()) {
    const items = SITE.nav.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0] && a[1])
      .filter(([, , tier]) => {
        const t = (tier || 'all').toLowerCase();
        if (t === 'hr') return LEVELS[level] >= LEVELS.hr;
        if (t === 'member') return LEVELS[level] >= LEVELS.member;
        return true;
      }).map(([txt, url]) => `<a href="${esc(url)}">${esc(txt)}</a>`);
    for (const pg of (SITE._navPages || [])) {
      const slug = (pg.slug || '').trim();
      if (slug) items.push(`<a href="/p/${esc(slug)}">${esc((pg.title || slug).trim() || slug)}</a>`);
    }
    if (panelGrant && LEVELS[level] < LEVELS.hr && !items.some((h) => h.includes('href="/panel"'))) {
      items.push('<a href="/panel">Панель</a>');
    }
    if (LEVELS[level] >= LEVELS.member && !items.some((h) => h.includes('href="/boards"'))) {
      items.push('<a href="/boards">Доски</a>');
    }
    return items;
  }
  const nav = ['<a href="/me">Мой профиль</a>'];
  if (LEVELS[level] < LEVELS.member) nav.push('<a href="/apply">Подать заявку</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/people">Участники</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/giveaways">Розыгрыши</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/text/rules">Правила</a>');
  nav.push('<a href="/faq">FAQ</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/commands">Команды</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/dashboard">Дашборд</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/tickets">Тикеты</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel?tab=apps">Заявки</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel?tab=contracts_check">Контракты</a>');
  if (LEVELS[level] >= LEVELS.hr || panelGrant) nav.push('<a href="/panel">Панель</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/boards">Доски</a>');
  for (const pg of (SITE._navPages || [])) {
    const slug = (pg.slug || '').trim();
    if (!slug) continue;
    nav.push(`<a href="/p/${esc(slug)}">${esc((pg.title || slug).trim() || slug)}</a>`);
  }
  return nav.filter(Boolean);
}

function topbar(user, level, notif, panelGrant) {
  const brand = `<a class="brand" href="/">${brandHtml()}</a>`;
  if (!user) {
    const gnav = (SITE._navPages || []).map((pg) => `<a href="/p/${esc(pg.slug)}">${esc(pg.title || pg.slug)}</a>`).join('');
    const gtoggle = gnav ? `<button id="navtoggle" type="button" aria-label="Меню" aria-expanded="false" onclick="var n=this.nextElementSibling;if(n){var o=n.classList.toggle('open');this.setAttribute('aria-expanded',o?'true':'false');}">☰</button>` : '';
    return `<div class="top">${gtoggle}<div class="left nav">${themeToggle()}${gnav}</div><div class="right"><a class="btn sm" href="/login">Войти</a>${brand}</div></div>`;
  }
  const bell = `<a href="/notifications" class="tglbtn" style="text-decoration:none" title="Уведомления">🔔${notif ? `<b style="color:var(--bad)"> ${notif}</b>` : ''}</a>`;
  const bug = `<a href="/bug" class="tglbtn" style="text-decoration:none" title="Сообщить о баге">🐞</a>`;
  return `<div class="top">
    <button id="navtoggle" type="button" aria-label="Меню" aria-expanded="false" onclick="var n=document.querySelector('.top .left.nav');if(n){var o=n.classList.toggle('open');this.setAttribute('aria-expanded',o?'true':'false');}">☰</button>
    <div class="left nav">${navItems(level, panelGrant).join('')}</div>
    <div class="right">${bug}${bell}${themeToggle()}${brand}</div>
  </div>`;
}
function bannerHtml() {
  if (SITE.banner_on !== '1' || !SITE.banner_text) return '';
  const now = Date.now();
  const from = SITE.banner_from ? Date.parse(SITE.banner_from) : NaN;
  const to = SITE.banner_to ? Date.parse(SITE.banner_to) : NaN;
  if (!Number.isNaN(from) && now < from) return '';
  if (!Number.isNaN(to) && now > to) return '';
  const h = crypto.createHash('md5').update(SITE.banner_text).digest('hex').slice(0, 8);
  return `<div id="sitebanner" class="sitebanner" data-h="${h}">${mdToHtml(SITE.banner_text)}<span class="x" title="скрыть">✕</span></div>`;
}

function layout(opts) {
  const override = themeOverrideCss();
  const foot = SITE.footer ? esc(SITE.footer) : `${esc(siteBrand())} · сайт работает на том же сервере, что и Discord-бот`;
  const favicon = SITE.logo && /^(https?:|data:image\/)/.test(SITE.logo) ? esc(SITE.logo) : '';
  const customCss = SITE.css ? `<style>${String(SITE.css)
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*javascript:/gi, 'url($1')
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/<\//g, '<\\/').slice(0, 20000)}</style>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
${favicon ? `<link rel="icon" href="${favicon}">` : ''}
<meta name="theme-color" content="${(SITE.color && SITE.color.bg) || '#0f1013'}">
<style>${STYLE}${override}</style>${customCss}<script>${CLIENT_SCRIPT}</script></head><body>
${topbar(opts.user, opts.level || 'guest', opts.notif || 0, opts.panelGrant)}
${bannerHtml()}
<div class="wrap${opts.wide ? ' wide' : ''}">${opts.body}
<div class="foot">${foot}</div>
</div>
<button id="totop" type="button" title="Наверх" aria-label="Наверх">↑</button>
</body></html>`;
}

// ---------- Данные ----------
async function orgStats() {
  const c = (sql, p = []) => db.get(sql, p).then((r) => (r ? r.c : 0));
  const range = contracts.getWeekRange(0);
  const s = range.start.toISOString();
  const e = range.end.toISOString();
  const accounts = await c('SELECT COUNT(*) c FROM participants');
  const extras = await c('SELECT COUNT(*) c FROM extra_passports');
  return {
    accounts,
    passports: accounts + extras,
    fulfilled: await c("SELECT COUNT(*) c FROM contracts WHERE status='fulfilled' AND submitted_at BETWEEN ? AND ?", [s, e]),
    unfulfilled: await c("SELECT COUNT(*) c FROM contracts WHERE status='unfulfilled' AND submitted_at BETWEEN ? AND ?", [s, e]),
    endedGiveaways: await c("SELECT COUNT(*) c FROM giveaways WHERE status='ended'"),
    activeGiveaways: await db.all("SELECT id, prize FROM giveaways WHERE status='active' ORDER BY ends_at ASC LIMIT 5").catch(() => []),
    webUsers: await c('SELECT COUNT(*) c FROM web_users'),
    weekLabel: contracts.formatWeekLabel(range),
  };
}

async function landingBody(st) {
  const inv = esc(siteInvite());
  const heroTitle = SITE.hero_title || `Организация «${config.SITE_BRAND}»`;
  const heroText = SITE.hero_text || 'Выполнение контрактов на GTA5RP. Контракты от 50 векселей, возможность брать их самостоятельно, офис в Rockford HilIs ВС и помощь в прокачке навыков.';
  let ag = '';
  try {
    const row = await contentVersions.getLatestVersion('agitation');
    ag = (row ? row.content : content.DEFAULT_AGITATION) || '';
  } catch (_) { ag = content.DEFAULT_AGITATION; }
  const heroBtns = SITE.hero_buttons
    ? SITE.hero_buttons.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0] && a[1])
      .map(([lb, url]) => `<a class="btn${/подать/i.test(lb) ? '' : ' ghost'}" href="${esc(url)}"${/^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : ''}>${esc(lb)}</a>`).join('')
    : `<a class="btn" href="/apply">Подать заявку на вступление</a>
       <a class="btn ghost" href="/login">Войти через Discord</a>
       <a class="btn ghost" href="${inv}" target="_blank" rel="noopener">Discord-сервер</a>`;
  return `
  <div class="hero"${SITE.hero_minh ? ` style="min-height:${parseInt(SITE.hero_minh, 10) || 0}px"` : ''}>
    <h1>${esc(heroTitle)}</h1>
    <p>${esc(heroText)}</p>
    ${heroBtns}
  </div>

  ${statsCard(st)}

  ${SITE.hide_giveaways === '1' ? '' : ((st.activeGiveaways && st.activeGiveaways.length) ? `<div class="card"><h2>🎉 Идут розыгрыши</h2>
    ${st.activeGiveaways.map((gw) => `<a class="pill" href="/g/${gw.id}" style="font-size:14px">${esc(gw.prize)}</a>`).join(' ')}
    <div style="margin-top:10px"><a class="btn sm" href="/giveaways">Все розыгрыши · участвовать</a></div>
  </div>` : '')}

  ${await renderLandingBlocks(inv, st)}

  ${SITE.hide_agitation === '1' ? '' : `<div class="card">
    <h2>${esc(SITE.agitation_title || 'Текущая агитация')}</h2>
    ${mdToHtml(ag.slice(0, 5000))}
  </div>`}
  ${(SITE.discord_widget === '1' && process.env.GUILD_ID) ? `<div class="card"><h2>Discord-сервер</h2>
    <iframe src="https://discord.com/widget?id=${esc(process.env.GUILD_ID)}&theme=dark" width="100%" height="400" allowtransparency="true" frameborder="0" sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin" style="border-radius:10px;max-width:400px"></iframe>
    <p class="mini">Виджет должен быть включён в настройках сервера Discord (Настройки сервера → Виджет).</p>
  </div>` : ''}`;
}

function statPlaceholders(st) {
  return {
    '{участников}': st.accounts, '{accounts}': st.accounts,
    '{паспортов}': st.passports, '{passports}': st.passports,
    '{контракты}': `${st.fulfilled} / ${st.unfulfilled}`, '{contracts}': `${st.fulfilled} / ${st.unfulfilled}`,
    '{выполнено}': st.fulfilled, '{невыполнено}': st.unfulfilled,
    '{розыгрышей}': st.endedGiveaways, '{giveaways}': st.endedGiveaways,
    '{вебпользователи}': st.webUsers, '{webusers}': st.webUsers,
  };
}
function substStats(str, st) {
  const ph = statPlaceholders(st || {});
  return String(str).replace(/\{[а-яa-z]+\}/gi, (m) => (ph[m] != null ? ph[m] : m));
}
const DEFAULT_STATS = '{участников} | участников\n{паспортов} | паспортов\n{контракты} | контракты ✅/❌ за неделю\n{розыгрышей} | завершённых розыгрышей';
function statsCard(st) {
  if (SITE.hide_stats === '1') return '';
  const src = SITE.stats && SITE.stats.trim() ? SITE.stats : DEFAULT_STATS;
  const tiles = src.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
    .map(([val, lbl]) => `<div class="tile"><div class="n">${esc(substStats(val, st))}</div><div class="l">${esc(lbl || '')}</div></div>`).join('');
  return `<div class="card"><h2>${esc(SITE.stats_title || 'Организация в цифрах')}</h2><div class="grid">${tiles}</div></div>`;
}
async function renderLandingBlocks(inv, st = {}) {
  const rows = await db.all('SELECT * FROM landing_blocks ORDER BY position, id').catch(() => []);
  if (!rows.length) {
    const DEF_FEAT = 'Контракты от 50 векселей | Без x2. Берёшь сам, когда удобно.\nОфис в Rockford Hills BC | Вексели сдаются там же.\nПомощь в прокачке | Поддержка по навыкам и профессиям.\nНаборы при активности | Можно брать наборы при минимальном онлайне.';
    const DEF_HOWTO = `Зайти на Discord-сервер по [приглашению](${siteInvite()}).\nНажать «Подать заявку» и заполнить форму.\nДождаться решения HR — ответ придёт в ЛС от бота.`;
    const featSrc = (SITE.features && SITE.features.trim()) ? SITE.features : DEF_FEAT;
    const howtoSrc = (SITE.howto && SITE.howto.trim()) ? SITE.howto : DEF_HOWTO;
    const featCards = featSrc.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
      .map(([t, d]) => `<div class="c"><h3>${esc(t)}</h3><p>${mdInline(esc(d || ''))}</p></div>`).join('');
    const steps = howtoSrc.split('\n').map((s) => s.trim()).filter(Boolean)
      .map((s) => `<li>${mdInline(esc(s))}</li>`).join('');
    return `
  ${featCards ? `<div class="card"><h2>${esc(SITE.features_title || 'Преимущества')}</h2><div class="feat">${featCards}</div></div>` : ''}
  ${steps ? `<div class="card"><h2>${esc(SITE.howto_title || 'Как вступить')}</h2>
    <ol style="margin-left:18px;color:var(--muted)">${steps}</ol></div>` : ''}`;
  }
  const subst = (s) => substStats(s, st);
  return rows.map((b) => {
    const h = b.title ? `<h2>${esc(b.title)}</h2>` : '';
    const style = b.min_height ? ` style="min-height:${parseInt(b.min_height, 10) || 0}px"` : '';
    if (b.kind === 'buttons') {
      const btns = (b.content || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0] && a[1])
        .map(([label, url]) => `<a class="btn sm" href="${esc(url)}"${/^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : ''}>${esc(label)}</a>`).join(' ');
      return `<div class="card"${style}>${h}<div class="bar">${btns}</div></div>`;
    }
    if (b.kind === 'cards') {
      const cs = (b.content || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
        .map(([t2, d]) => `<div class="c"><h3>${esc(t2)}</h3><p>${esc(d || '')}</p></div>`).join('');
      return `<div class="card"${style}>${h}<div class="feat">${cs}</div></div>`;
    }
    if (b.kind === 'stats') {
      const ts = (b.content || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
        .map(([val, lbl]) => `<div class="tile"><div class="n">${esc(subst(val))}</div><div class="l">${esc(lbl || '')}</div></div>`).join('');
      return `<div class="card"${style}>${h}<div class="grid">${ts}</div></div>`;
    }
    return `<div class="card"${style}>${h}${mdToHtml(b.content || '')}</div>`;
  }).join('');
}

async function panelLanding(user) {
  await loadSite(true);
  const rows = await db.all('SELECT * FROM landing_blocks ORDER BY position, id').catch(() => []);
  const KINDS = [
    ['text', 'Текст (форматирование как в Discord)'],
    ['buttons', 'Кнопки — строка: Текст | URL'],
    ['cards', 'Карточки — строка: Заголовок | Описание'],
    ['stats', 'Цифры — строка: Значение | Подпись (можно {участников} {паспортов} {контракты} {розыгрышей})'],
  ];
  const kindSel = (cur) => `<select name="kind">${KINDS.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const list = rows.map((b, i) => `<div class="card">
    <form method="POST" action="/admin/landing/save" class="form">${csrfField(user)}<input type="hidden" name="id" value="${b.id}">
      <label>Тип${kindSel(b.kind)}</label>
      <label>Заголовок (можно пусто)<input name="title" value="${esc(b.title || '')}" maxlength="120"></label>
      <label>Содержимое<textarea name="content" rows="5" maxlength="4000">${esc(b.content || '')}</textarea></label>
      <label>Мин. высота блока, px (0 = авто)<input name="min_height" type="number" min="0" max="900" value="${b.min_height || 0}"></label>
      <div class="bar">
        <button class="btn sm" type="submit">Сохранить</button>
        <button class="btn ghost sm" formaction="/admin/landing/move" name="dir" value="up" type="submit" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn ghost sm" formaction="/admin/landing/move" name="dir" value="down" type="submit" ${i === rows.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn ghost sm" formaction="/admin/landing/del" style="background:var(--bad)" type="submit" onclick="return confirm('Удалить блок?')">Удалить</button>
      </div>
    </form>
  </div>`).join('');
  const cb = (k, lbl) => `<label class="chk"><input type="checkbox" name="${k}" value="1" ${SITE[k] === '1' ? 'checked' : ''}><span>${esc(lbl)}</span></label>`;
  return `
  <div class="card"><h2>Публичная главная — что показывать</h2>
    <p class="mini">Эту страницу видят и не-участники. Спрячьте лишнее и соберите блоки под визитёров.</p>
    <form method="POST" action="/admin/landing/settings" class="form">${csrfField(user)}
      ${cb('banner_on', 'Показывать баннер-объявление вверху всех страниц')}
      <label>Текст баннера (можно ссылки/жирный как в Discord)<textarea name="banner_text" rows="2" maxlength="400">${esc(SITE.banner_text || '')}</textarea></label>
      <label>Показывать с (необязательно)<input type="datetime-local" name="banner_from" value="${esc(SITE.banner_from || '')}"></label>
      <label>Показывать до (необязательно)<input type="datetime-local" name="banner_to" value="${esc(SITE.banner_to || '')}"></label>
      ${cb('hide_stats', 'Спрятать «Организация в цифрах»')}
      ${cb('hide_giveaways', 'Спрятать «Идут розыгрыши»')}
      ${cb('hide_agitation', 'Спрятать «Текущую агитацию»')}
      ${cb('discord_widget', 'Показывать виджет Discord-сервера на главной')}
      <label>Заголовок блока «Организация в цифрах»<input name="stats_title" value="${esc(SITE.stats_title || 'Организация в цифрах')}" maxlength="80"></label>
      <label>Плитки «в цифрах» — строка «Значение | Подпись». Значение: число или {участников} {паспортов} {контракты} {розыгрышей} {выполнено} {невыполнено} {вебпользователи}
        <textarea name="stats" rows="5" maxlength="1200">${esc(SITE.stats && SITE.stats.trim() ? SITE.stats : DEFAULT_STATS)}</textarea></label>
      <label>Заголовок блока агитации<input name="agitation_title" value="${esc(SITE.agitation_title || 'Текущая агитация')}" maxlength="80"></label>
      <label>Мин. высота героя, px (0 = авто)<input name="hero_minh" type="number" min="0" max="900" value="${esc(SITE.hero_minh || '0')}"></label>
      <label>Кнопки в герое — строка «Текст | URL»<textarea name="hero_buttons" rows="3" maxlength="600">${esc(SITE.hero_buttons && SITE.hero_buttons.trim() ? SITE.hero_buttons : 'Подать заявку на вступление | /apply\nВойти через Discord | /login\nDiscord-сервер | ' + siteInvite())}</textarea></label>
      <label>Заголовок блока «Преимущества»<input name="features_title" value="${esc(SITE.features_title || 'Преимущества')}" maxlength="80"></label>
      <label>Карточки «Преимущества» — строка «Заголовок | Описание» (показываются, если нет блоков ниже)
        <textarea name="features" rows="4" maxlength="1500">${esc(SITE.features || 'Контракты от 50 векселей | Без x2. Берёшь сам, когда удобно.\nОфис в Rockford Hills BC | Вексели сдаются там же.\nПомощь в прокачке | Поддержка по навыкам и профессиям.\nНаборы при активности | Можно брать наборы при минимальном онлайне.')}</textarea></label>
      <label>Заголовок блока «Как вступить»<input name="howto_title" value="${esc(SITE.howto_title || 'Как вступить')}" maxlength="80"></label>
      <label>Шаги «Как вступить» — по одному в строке (можно [ссылки](url) и **жирный**)
        <textarea name="howto" rows="3" maxlength="1200">${esc(SITE.howto || 'Зайти на Discord-сервер по [приглашению](' + siteInvite() + ').\nНажать «Подать заявку» и заполнить форму.\nДождаться решения HR — ответ придёт в ЛС от бота.')}</textarea></label>
      <button class="btn" type="submit">Сохранить</button>
    </form>
  </div>
  <div class="card"><h2>Блоки главной страницы</h2>
    <p class="mini">Блоки идут между цифрами и агитацией. Нет ни одного блока — показываются стандартные «Преимущества» и «Как вступить» (тексты выше). Название сайта / текст героя / подвал — на вкладке «Админ».</p>
    <form method="POST" action="/admin/landing/add" class="form">${csrfField(user)}
      <label>Тип нового блока${kindSel('text')}</label>
      <label>Заголовок<input name="title" maxlength="120"></label>
      <label>Содержимое<textarea name="content" rows="4" maxlength="4000"></textarea></label>
      <button class="btn sm" type="submit">Добавить блок</button>
    </form>
  </div>${list}`;
}

async function panelGrants(client, user, sp) {
  const rows = await db.all("SELECT discord_id, COALESCE(subject_type,'user') st, tab, granted_by, granted_at, expires_at FROM panel_grants ORDER BY st, discord_id").catch(() => []);
  const bySubject = new Map(); // key: st|id
  for (const r of rows) {
    const k = r.st + '|' + r.discord_id;
    if (!bySubject.has(k)) bySubject.set(k, { st: r.st, id: r.discord_id, tabs: [], by: r.granted_by, at: r.granted_at, exp: r.expires_at });
    bySubject.get(k).tabs.push(r.tab);
  }
  // ?edit=role:<id> / ?edit=user:<id> — сервер сам подставляет субъект и галочки,
  // не полагаясь на JS (раньше редактор не показывал уже выданные разделы).
  const editRaw = (sp && sp.get && sp.get('edit')) || '';
  const em = /^(role|user):([0-9]{5,25})$/.exec(editRaw);
  const editSt = em ? em[1] : 'user';
  const editId = em ? em[2] : '';
  const editTabs = new Set((em && bySubject.get(editSt + '|' + editId) || { tabs: [] }).tabs);
  const label = (t) => (PANEL_TABS.find(([i]) => i === t) || [t, t])[1];
  const tabsList = PANEL_TABS.filter(([id]) => GRANTABLE_TABS.has(id));
  const g = guildOf(client);
  const roleMemberCount = (r) => {
    const n = r.members ? r.members.size : 0;
    return n > 0 ? `${n} чел.` : 'кол-во ?';
  };
  const roleOpts = g
    ? g.roles.cache.filter((r) => r.name !== '@everyone').sort((a, b) => b.position - a.position)
      .map((r) => `<option value="${esc(r.id)}"${editSt === 'role' && editId === r.id ? ' selected' : ''}>${esc(r.name)} — ${roleMemberCount(r)}</option>`).join('')
    : '';
  const subjName = (st, id) => {
    if (st !== 'role') return `${personLink(client, id)} <span class="mini">${esc(id)}</span>`;
    const rl = g && g.roles.cache.get(id);
    return `<span class="mention role">@${esc(rl ? rl.name : ('роль ' + id))}</span>${rl ? ` <span class="mini">${rl.members.size} чел.</span>` : ''}`;
  };
  const cur = [...bySubject.values()].map((info) => `<tr>
    <td>${subjName(info.st, info.id)}</td>
    <td>${info.tabs.map((t) => `<span class="pill">${esc(label(t))}</span>`).join(' ')}</td>
    <td class="mini">${info.by ? personLink(client, info.by) : '—'} · ${fmt(info.at)}${info.exp ? `<br><span class="badge warn">до ${fmt(info.exp)}</span>` : ''}</td>
    <td style="white-space:nowrap">
      <a class="btn ghost sm" href="/panel?tab=grants&edit=${esc(info.st)}:${esc(info.id)}">изменить</a>
      <form method="POST" action="/admin/grants/save" style="display:inline">${csrfField(user)}<input type="hidden" name="subject_type" value="${esc(info.st)}"><input type="hidden" name="subject_id" value="${esc(info.id)}"><button class="btn ghost sm" style="background:var(--bad)" type="submit" onclick="return confirm('Убрать все доступы у этого субъекта?')">убрать все</button></form>
    </td>
  </tr>`).join('');
  return `
  <div class="card"><h2>Выдать доступ к разделам панели</h2>
    <p class="mini">Доступ можно выдать <b>участнику</b> (по Discord ID) или <b>всем с ролью</b>. Инфраструктурные разделы (База данных, Админ, Права команд, Главная, Страницы) выдать нельзя.</p>
    <form method="POST" action="/admin/grants/save" class="form" id="grantForm">${csrfField(user)}
      <label>Кому<select name="subject_type" id="grantType" onchange="fcGrantType();fcGrantAuto()">
        <option value="user"${editSt === 'user' ? ' selected' : ''}>Конкретному участнику</option>
        <option value="role"${editSt === 'role' ? ' selected' : ''}>Всем с ролью</option>
      </select></label>
      <label id="grantUserRow"${editSt === 'role' ? ' style="display:none"' : ''}>Discord ID участника<input name="subject_user" id="grantUser" pattern="[0-9]{5,25}" maxlength="25" oninput="fcGrantAuto()" value="${editSt === 'user' ? esc(editId) : ''}"></label>
      <label id="grantRoleRow"${editSt === 'role' ? '' : ' style="display:none"'}>Роль<select name="subject_role" id="grantRole" onchange="fcGrantAuto()">${roleOpts || '<option value="">(бот офлайн — ролей нет)</option>'}</select></label>
      <div class="mini" id="grantHint" style="margin:2px 0 6px">${editId ? (editTabs.size ? `Сейчас выдано: ${editTabs.size} разд. — отмечены ниже, меняйте и сохраняйте.` : 'Этому субъекту доступы ещё не выдавались.') : ''}</div>
      <div class="bar" style="flex-wrap:wrap;gap:4px;margin:4px 0">
        <span class="mini">Пресет:</span>
        ${[['HR-помощник', ['apps', 'queues', 'contracts_check']], ['Модератор ЧС', ['blacklist', 'queues']], ['Аналитик', ['overview', 'sla', 'members', 'contracts', 'invites']]]
          .map(([nm, ts]) => `<button type="button" class="btn ghost sm" onclick='var s=${JSON.stringify(ts)};document.querySelectorAll("#grantForm input[name=tab]").forEach(function(c){c.checked=s.indexOf(c.value)>=0})'>${esc(nm)}</button>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px;margin:8px 0">
        ${tabsList.map(([id, lbl]) => `<label class="chk"><input type="checkbox" name="tab" value="${id}"${editTabs.has(id) ? ' checked' : ''}><span>${esc(lbl)}</span></label>`).join('')}
      </div>
      <label>Действует до (необязательно — иначе бессрочно)<input type="date" name="expires_at"></label>
      <div class="bar">
        <button class="btn sm" type="submit">Сохранить доступы</button>
        <button class="btn ghost sm" type="button" onclick="document.querySelectorAll('#grantForm input[name=tab]').forEach(function(c){c.checked=true})">отметить все</button>
        <button class="btn ghost sm" type="button" onclick="document.querySelectorAll('#grantForm input[name=tab]').forEach(function(c){c.checked=false})">снять все</button>
      </div>
    </form>
    <script>
    var GRANT_MAP=${JSON.stringify(Object.fromEntries([...bySubject.values()].map((i) => [i.st + '|' + i.id, i.tabs])))};
    // Только переключение видимости полей — галочки НЕ трогаем (их ставит сервер).
    function fcGrantType(){var t=document.getElementById('grantType').value;
      document.getElementById('grantUserRow').style.display=t==='user'?'':'none';
      document.getElementById('grantRoleRow').style.display=t==='role'?'':'none';}
    // Подставляет уже выданные галочки при смене субъекта пользователем.
    function fcGrantAuto(){
      var f=document.getElementById('grantForm'), st=document.getElementById('grantType').value;
      var id=st==='role'?f.subject_role.value:(f.subject_user.value||'').trim();
      var have=GRANT_MAP[st+'|'+id];
      if(id){
        var s=new Set(have||[]);
        f.querySelectorAll('input[name=tab]').forEach(function(c){c.checked=s.has(c.value)});
      }
      document.getElementById('grantHint').textContent=have?('Сейчас выдано: '+have.length+' разд. — отмечено ниже, меняйте и сохраняйте.'):(id?'Этому субъекту доступы ещё не выдавались.':'');
    }
    fcGrantType();
    </script>
  </div>
  <div class="card"><h2>Кому сейчас выдан доступ (${bySubject.size})</h2>
    <div class="tablewrap"><table><tr><th>Субъект</th><th>Разделы</th><th>Кем выдано</th><th></th></tr>
      ${cur || '<tr><td colspan="4">пока никому</td></tr>'}
    </table></div>
  </div>
  <div class="card"><h2>История изменений доступов</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Кто</th><th>Что</th></tr>
      ${(await db.all("SELECT at, actor_tag, details FROM audit_log WHERE action LIKE '%оступы к панели%' ORDER BY id DESC LIMIT 30").catch(() => []))
        .map((a) => `<tr><td class="muted">${fmt(a.at)}</td><td class="mini">${esc(a.actor_tag || '—')}</td><td class="mini">${renderMentions(client, esc((a.details || '').slice(0, 200)))}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
    </table></div>
  </div>`;
}

async function panelPages(client, user) {
  const pages = await db.all('SELECT * FROM site_pages ORDER BY slug').catch(() => []);
  const assets = await db.all('SELECT id, filename, mime, size, uploaded_at FROM page_assets ORDER BY id DESC LIMIT 100').catch(() => []);
  const assetCard = `<div class="card"><h2>Картинки для страниц</h2>
    <p class="mini">Загрузите картинку (сожмётся до 1280px) и вставьте в текст как <code>![подпись](URL)</code>. Ссылку возьмите из таблицы.</p>
    <form method="POST" action="/admin/asset/upload" class="form" onsubmit="return fcImgUpload(this,'file','data',1280,'image/jpeg')">${csrfField(user)}
      <label>Файл<input type="file" name="file" accept="image/*" required></label>
      <input type="hidden" name="data"><input type="hidden" name="filename">
      <button class="btn sm" type="submit">Загрузить</button>
    </form>
    <div class="tablewrap" style="margin-top:10px"><table><tr><th>Превью</th><th>URL</th><th>Размер</th><th></th></tr>
      ${assets.map((a) => `<tr>
        <td><img src="/asset/${a.id}" alt="" style="height:40px;border-radius:4px"></td>
        <td class="mini"><code>/asset/${a.id}</code></td>
        <td class="mini">${Math.round((a.size || 0) / 1024)} КБ</td>
        <td><form method="POST" action="/admin/asset/del" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${a.id}"><button class="btn ghost sm" type="submit">✕</button></form></td>
      </tr>`).join('') || '<tr><td colspan="4">пусто</td></tr>'}
    </table></div>
  </div>`;
  const list = [];
  for (const p of pages) {
    const vers = await db.all('SELECT id, saved_at, saved_by, title FROM site_page_versions WHERE slug = ? ORDER BY id DESC LIMIT 20', [p.slug]).catch(() => []);
    const verHtml = vers.length ? `<details style="margin-top:8px"><summary class="mini" style="cursor:pointer">история версий (${vers.length})</summary>
      <div class="tablewrap" style="margin-top:6px"><table><tr><th>Когда</th><th>Кто</th><th></th></tr>
        ${vers.map((v) => `<tr><td class="muted">${fmt(v.saved_at)}</td><td>${personLink(client, v.saved_by)}</td>
          <td style="white-space:nowrap"><a class="btn ghost sm" href="/panel/page_diff?slug=${esc(p.slug)}&vid=${v.id}">разница</a>
          <form method="POST" action="/admin/page/revert" style="display:inline">${csrfField(user)}<input type="hidden" name="vid" value="${v.id}"><button class="btn ghost sm" type="submit" onclick="return confirm('Откатить страницу к этой версии? Текущая уйдёт в историю.')">откатить</button></form></td></tr>`).join('')}
      </table></div></details>` : '';
    list.push(`<div class="card">
    <form method="POST" action="/admin/page/save" class="form">${csrfField(user)}<input type="hidden" name="orig" value="${esc(p.slug)}">
      <label>Адрес (slug) — открывается по /p/slug<input name="slug" value="${esc(p.slug)}" pattern="[a-z0-9-]{1,40}" required></label>
      <label>Заголовок<input name="title" value="${esc(p.title || '')}" maxlength="120"></label>
      <label>Содержимое (форматирование как в Discord)<textarea name="content" data-md rows="8" maxlength="20000">${esc(p.content || '')}</textarea></label>
      <label class="chk"><input type="checkbox" name="nav" value="1" ${p.nav ? 'checked' : ''}><span>Показывать пункт в меню шапки</span></label>
      <label class="chk"><input type="checkbox" name="published" value="1" ${(p.published == null || p.published) ? 'checked' : ''}><span>Опубликована (снять — черновик, видит только havirys)</span></label>
      <label>Авто-публикация в (необязательно — если время в будущем, страница опубликуется сама)<input type="datetime-local" name="publish_at" value="${p.publish_at ? esc(String(p.publish_at).slice(0, 16)) : ''}"></label>
      <div class="bar">
        ${!p.published && p.published != null ? '<span class="badge warn">черновик</span>' : ''}
        ${p.publish_at && !p.published ? `<span class="badge">публикация ${fmt(p.publish_at)}</span>` : ''}
        <button class="btn sm" type="submit">Сохранить</button>
        <a class="btn ghost sm" href="/p/${esc(p.slug)}" target="_blank">Открыть</a>
        <button class="btn ghost sm" formaction="/admin/page/del" style="background:var(--bad)" type="submit" onclick="return confirm('Удалить страницу?')">Удалить</button>
      </div>
    </form>
    ${verHtml}
  </div>`);
  }
  const tpls = await db.all('SELECT * FROM page_templates ORDER BY name').catch(() => []);
  const tplCard = `<div class="card"><h2>Шаблоны страниц</h2>
    ${tpls.map((t) => `<div class="bar"><span class="mini"><b>${esc(t.name)}</b> — ${esc((t.content || '').slice(0, 60))}…</span>
      <button class="btn ghost sm" type="button" onclick='fcPageTpl(${JSON.stringify(t.content || '')})'>вставить в новую</button>
      <form method="POST" action="/admin/page_tpl_del" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${t.id}"><button class="btn ghost sm" type="submit">✕</button></form>
    </div>`).join('') || '<span class="mini">пусто</span>'}
    <form method="POST" action="/admin/page_tpl_save" class="form" style="margin-top:8px">${csrfField(user)}
      <label>Название шаблона<input name="name" required maxlength="60"></label>
      <label>Содержимое<textarea name="content" data-md rows="4" maxlength="20000"></textarea></label>
      <button class="btn sm" type="submit">Сохранить шаблон</button>
    </form>
    <script>function fcPageTpl(c){var f=document.getElementById('newPageForm');if(f){f.content.value=c;f.scrollIntoView({behavior:'smooth'});}}</script>
  </div>`;
  return `
  <div class="card"><h2>Доп. страницы сайта</h2>
    <p class="mini">Стандартные адреса <code>/rules</code> и <code>/about</code> берут содержимое из страниц со slug <code>rules</code> и <code>about</code>. Любой другой slug доступен по <code>/p/slug</code>.</p>
    <form method="POST" action="/admin/page/save" class="form" id="newPageForm">${csrfField(user)}<input type="hidden" name="orig" value="">
      <label>Адрес (slug)<input name="slug" pattern="[a-z0-9-]{1,40}" placeholder="rules" required></label>
      <label>Заголовок<input name="title" maxlength="120"></label>
      <label>Содержимое<textarea name="content" data-md rows="5" maxlength="20000"></textarea></label>
      <label class="chk"><input type="checkbox" name="nav" value="1"><span>Показывать пункт в меню шапки</span></label>
      <label class="chk"><input type="checkbox" name="published" value="1" checked><span>Опубликована сразу</span></label>
      <button class="btn sm" type="submit">Создать страницу</button>
    </form>
  </div>
  ${tplCard}
  </div>${assetCard}${list.join('')}`;
}

async function myGiveawaysCard(did) {
  const mine = await db.all(
    `SELECT g.id, g.prize, g.status, g.ends_at, g.winners
       FROM giveaways g JOIN giveaway_entries e ON e.giveaway_id = g.id
      WHERE e.discord_id = ? ORDER BY g.id DESC LIMIT 30`, [did]).catch(() => []);
  const wonExtra = await db.all(
    "SELECT id, prize, status, ends_at, winners FROM giveaways WHERE status = 'ended' AND winners LIKE ? ORDER BY id DESC LIMIT 30",
    [`%${did}%`]).catch(() => []);
  const byId = new Map();
  for (const g of [...mine, ...wonExtra]) byId.set(g.id, g);
  const rows = [...byId.values()].sort((a, b) => b.id - a.id);
  if (!rows.length) return '';
  const winRows = rows.filter((g) => (g.winners || '').split(',').includes(did));
  const won = winRows.length;
  const list = rows.map((g) => {
    const iWon = (g.winners || '').split(',').includes(did);
    const st = g.status === 'active' ? `идёт, до ${fmt(g.ends_at)}` : (iWon ? '🏆 победа' : 'участвовал');
    return `<tr><td><a href="/g/${g.id}">${esc(g.prize)}</a></td><td>${st}</td></tr>`;
  }).join('');
  const winsBlock = won
    ? `<h3 style="font-size:14px;margin:6px 0">🏆 Ваши выигрыши (${won})</h3>
       <div class="bar" style="flex-wrap:wrap;gap:4px;margin-bottom:8px">${winRows.map((g) => `<a class="pill" href="/g/${g.id}">${esc(g.prize)}</a>`).join('')}</div>`
    : '';
  return `<div class="card"><h2>Мои розыгрыши (${rows.length}${won ? `, побед: ${won}` : ''})</h2>
    ${winsBlock}
    <div class="tablewrap"><table><tr><th>Приз</th><th>Статус</th></tr>${list}</table></div></div>`;
}

async function meBody(client, user) {
  const did = user.id;
  const acc = await accessFor(client, did);
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [did]);
  const av = await avatarDataUri(client, did, 128);
  const roleTags = acc.roleNames.length ? acc.roleNames.map((n) => `<span class="pill">${esc(n)}</span>`).join('') : '<span class="muted">нет ролей на сервере</span>';
  const myTicket = await db.get("SELECT id, subject FROM tickets WHERE opener_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [did]).catch(() => null);
  const ticketCard = myTicket ? `<div class="card"><h2>Мой открытый тикет</h2><a class="btn sm" href="/ticket/${myTicket.id}">🎫 ${esc(myTicket.subject || 'Тикет')} — открыть переписку</a></div>` : '';
  const logins = await db.all('SELECT ip, ua, at FROM web_logins WHERE discord_id = ? ORDER BY id DESC LIMIT 10', [did]).catch(() => []);
  const sessions = await db.all("SELECT sid, ip, ua, created_at, last_seen, label FROM web_sessions WHERE discord_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC LIMIT 20", [did]).catch(() => []);
  const sessRows = sessions.map((s) => `<tr>
    <td class="mini">
      <form method="POST" action="/me/session_label" class="bar" style="margin:0;gap:4px">${csrfField(user)}<input type="hidden" name="sid" value="${esc(s.sid)}">
        <input name="label" value="${esc(s.label || '')}" placeholder="${esc((s.ua || 'устройство').slice(0, 40))}" maxlength="40" style="max-width:150px">
        <button class="btn ghost sm" type="submit" title="Сохранить имя">✓</button>
      </form>
      ${s.sid === user.sid ? '<span class="badge ok">эта</span>' : ''}
      <div class="mini" style="opacity:.6">${esc((s.ua || '—').slice(0, 60))}</div>
    </td>
    <td>${esc(s.ip || '—')}</td>
    <td class="muted">${fmt(s.last_seen || s.created_at)}</td>
    <td>${s.sid === user.sid ? '' : `<form method="POST" action="/me/session_revoke" style="display:inline">${csrfField(user)}<input type="hidden" name="sid" value="${esc(s.sid)}"><button class="btn ghost sm" type="submit">завершить</button></form>`}</td>
  </tr>`).join('');
  const loginsCard = `<div class="card"><h2>Активные сессии</h2>
    <div class="tablewrap"><table><tr><th>Устройство</th><th>IP</th><th>Активность</th><th></th></tr>
      ${sessRows || '<tr><td colspan="4">—</td></tr>'}
    </table></div>
    <form method="POST" action="/me/logout_all" style="margin-top:10px" onsubmit="return confirm('Выйти со всех устройств? Текущая сессия тоже завершится.')">${csrfField(user)}<button class="btn sm" style="background:var(--bad)" type="submit">Выйти со всех устройств</button></form>
    <h3 style="margin-top:14px;font-size:14px">Последние входы</h3>
    <div class="tablewrap"><table><tr><th>Когда</th><th>IP</th><th>Браузер</th></tr>
      ${logins.map((l) => `<tr><td class="muted">${fmt(l.at)}</td><td>${esc(l.ip || '—')}</td><td class="mini">${esc((l.ua || '—').slice(0, 90))}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
    </table></div>
    <p class="mini" style="margin-top:10px"><a href="/me/export.json">⬇ Скачать все мои данные (JSON)</a></p>
  </div>`;

  const icalTok = await getIcalToken(did).catch(() => null);
  const icalUrl = icalTok ? `${baseUrl()}/calendar.ics?key=${icalTok}` : '';
  const icalCard = icalUrl ? `<div class="card"><h2>Календарь отпусков (подписка)</h2>
    <p class="mini">Личная ссылка-подписка: добавьте её в Google Календарь / Apple Календарь («Подписаться на календарь» / «Добавить по URL»). Отпуска будут появляться автоматически. Ссылку не публикуйте — она привязана к вам.</p>
    <input readonly onclick="this.select()" value="${esc(icalUrl)}" style="width:100%;font-family:monospace;font-size:12px">
    <div class="bar" style="margin-top:6px">
      <a class="btn ghost sm" href="${esc(icalUrl)}">Скачать .ics</a>
      <form method="POST" action="/me/ical_reset" style="display:inline" onsubmit="return confirm('Сбросить ссылку? Старая подписка перестанет работать.')">${csrfField(user)}<button class="btn ghost sm" type="submit">Сбросить ссылку</button></form>
    </div>
  </div>` : '';

  const logoutBtn = `${user.local ? '<a class="btn sm ghost" href="/account" style="margin-right:6px">Мой аккаунт</a>' : ''}<form method="POST" action="/logout" style="display:inline">${csrfField(user)}<button class="btn sm" type="submit" style="background:var(--bad)">Выйти из аккаунта</button></form>`;

  if (!p) {
    return `
      <div class="phead"><img class="avatar" width="72" height="72" src="${esc(av)}" alt=""><div><h1>Личный кабинет</h1>${logoutBtn}</div></div>
      <div class="card">
        <b>${esc(user.username)}</b> — вход выполнен, но вы <b>не состоите в организации</b>.
        <div class="muted" style="margin-top:6px">Уровень доступа: ${esc(acc.level)}. Роли на сервере: ${roleTags}</div>
      </div>
      <a class="btn" href="/apply">Подать заявку на вступление</a>
      ${loginsCard}`;
  }

  const passports = await passportsLib.getAllPassports(did).catch(() => []);
  const blRow = await db.get('SELECT id, appeal_blocked FROM blacklist WHERE discord_id = ?', [did]).catch(() => null);
  const canAppeal = !!(blRow && !blRow.appeal_blocked);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(did, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [did]).catch(() => null);
  const bs = await computeBadgesAndStreak(client, did);
  const myLink = await db.get('SELECT * FROM invite_links WHERE creator_id = ?', [did]).catch(() => null);
  const inviteCard = myLink
    ? `<div class="card"><h2>Моя ссылка-приглашение</h2>
        <p class="mini">Отправьте кандидату — в его заявке автоматически укажется, что пригласили вы.</p>
        <pre>${esc(baseUrl())}/i/${esc(myLink.code)}</pre>
        <p class="mini">Переходов: ${myLink.uses || 0} · подано заявок: ${myLink.signups || 0}</p></div>`
    : `<div class="card"><h2>Моя ссылка-приглашение</h2>
        <form method="POST" action="/me/invite">${csrfField(user)}<button class="btn sm" type="submit">Создать ссылку</button></form></div>`;
  const passRows = passports.map((pp) => `<tr>
    <td>${esc(pp.name)}</td>
    <td><span class="pill">№ ${esc(pp.static)}</span></td>
    <td>${esc(roleName(client, pp.role_id))}</td>
    <td>${pp.vacation_until ? '🏖️ отпуск до ' + fmt(pp.vacation_until) : (pp.afk_since ? '💤 AFK с ' + esc(pp.afk_since) : '—')}</td>
  </tr>`).join('');

  return `
    <div class="phead"><img class="avatar" width="72" height="72" src="${esc(av)}" alt=""><div>
      <h1>${esc(p.name)}</h1>
      <div class="muted">Discord: ${esc(user.username)} · ID ${esc(did)} · вступил ${fmt(p.joined_at)} · <a href="/u/${esc(did)}">полный профиль</a> · <a href="/u/${esc(did)}/card">карточка</a> · <a href="/compare">сравнить с другим</a></div>
      <div style="margin-top:8px">${logoutBtn}</div>
    </div></div>
    <div class="mecols">
    <div class="card"><h2>Роли на сервере</h2>${roleTags}</div>
    ${await myProgressCard(client, did, p)}
    <div class="card"><h2>Паспорта (${passports.length})</h2>
      <div class="tablewrap"><table>
        <tr><th>Имя Фамилия</th><th>Паспорт</th><th>Ранг</th><th>Статус</th></tr>
        ${passRows}
      </table></div>
    </div>
    <div class="card"><h2>Контракты за ${esc(contracts.formatWeekLabel(range))}</h2>
      <span class="badge ok">✅ выполнено ${week.fulfilled.length}</span>
      <span class="badge bad">❌ не выполнено ${week.unfulfilled.length}</span>
      ${(() => { const norm = config.WEEKLY_PROMOTION_CONTRACT_THRESHOLD || 3; const pct = Math.min(100, Math.round(week.fulfilled.length / norm * 100));
        return `<div style="margin-top:8px"><div class="mini">Для повышения на этой неделе засчитано <b>${week.fulfilled.length}</b> из ${norm}${week.fulfilled.length >= norm ? ' — порог набран ✅' : ` (ещё ${norm - week.fulfilled.length} для стрика повышения)`}. Обязательной нормы нет.</div>
        <div class="progress"><i style="width:${pct}%"></i></div></div>`; })()}
    </div>
    ${badgesCard(bs, p.pinned_badges)}
    <div class="card"><h2>Закрепить бейджи</h2>
      <p class="mini">Отмеченные показываются первыми и со ★ на вашем профиле.</p>
      <form method="POST" action="/me/pin_badges" class="form">${csrfField(user)}
        ${(bs.has ? Object.keys(bs.has).filter((k) => bs.has[k]) : []).map((k) => `<label class="chk"><input type="checkbox" name="b" value="${k}" ${String(p.pinned_badges || '').split(',').map((s) => s.trim()).includes(k) ? 'checked' : ''}><span>${esc((bs.LABELS && bs.LABELS[k]) || k)}</span></label>`).join('') || '<span class="mini">пока нет бейджей</span>'}
        <button class="btn sm" type="submit">Сохранить</button>
      </form>
    </div>
    <div class="card"><h2>Приглашения</h2>Подтверждённых за всё время: <b>${invRow ? invRow.c : 0}</b></div>
    <div class="card"><h2>Обо мне и приватность</h2>
      <p class="mini">Короткий текст на вашем публичном профиле (форматирование как в Discord). До 1000 символов.</p>
      <form method="POST" action="/me/about" class="form">${csrfField(user)}
        <textarea name="about" rows="4" maxlength="1000" placeholder="Пару слов о себе, часовой пояс, чем занимаюсь…">${esc(p.about || '')}</textarea>
        <label class="chk"><input type="checkbox" name="about_private" value="1" ${p.about_private ? 'checked' : ''}><span>Скрыть «Обо мне» от всех, кроме меня и HR+</span></label>
        <label class="chk"><input type="checkbox" name="contracts_private" value="1" ${p.contracts_private ? 'checked' : ''}><span>Скрыть контракты и их историю от всех, кроме меня и HR+</span></label>
        <label class="chk"><input type="checkbox" name="badges_private" value="1" ${p.badges_private ? 'checked' : ''}><span>Скрыть бейджи и достижения от всех, кроме меня и HR+</span></label>
        <button class="btn sm" type="submit">Сохранить</button>
      </form>
    </div>
    ${ticketCard}
    ${inviteCard}
    ${await myGiveawaysCard(did)}
    ${await memberActionsExtra(client, user, p, passports, acc)}
    ${icalCard}
    ${loginsCard}
    ${memberForms(user, passports, canAppeal)}
    </div>`;
}

// ---------- Панель управления ----------
const PANEL_TABS = [
  ['overview', 'Обзор'],
  ['sla', 'SLA'],
  ['apps', 'Заявки'],
  ['queues', 'Очереди'],
  ['contracts_check', 'Контракты — проверка'],
  ['role_check', 'Сверка ролей'],
  ['members', 'Участники'],
  ['contracts', 'Контракты'],
  ['invites', 'Приглашения'],
  ['hr_payouts', 'Выплаты HR'],
  ['giveaways', 'Розыгрыши'],
  ['blacklist', 'Чёрный список'],
  ['texts', 'Тексты'],
  ['forms', 'Формы'],
  ['faq_manage', 'Гайды FAQ'],
  ['reasons', 'Причины отказа'],
  ['broadcast', 'Рассылка'],
  ['settings', 'Настройки'],
  ['perms', 'Права команд'],
  ['admin', 'Админ'],
  ['landing', 'Главная страница'],
  ['pages', 'Страницы'],
  ['data', 'База данных'],
  ['grants', 'Доступы'],
  ['accounts', 'Аккаунты'],
];
// Разделы, которые havirys может выдавать точечно (без инфраструктурных).
const GRANTABLE_TABS = new Set([
  'overview', 'sla', 'apps', 'queues', 'contracts_check', 'role_check', 'members',
  'contracts', 'invites', 'hr_payouts', 'giveaways', 'blacklist', 'texts',
  'faq_manage', 'reasons', 'broadcast', 'settings',
]);
// HR-действие в панели разрешено, если ранг HR+ ИЛИ выдан доступ к разделу `tab`.
async function panelActionAllowed(client, user, acc, tab) {
  if (acc && acc.rank >= LEVELS.hr) return true;
  if (!GRANTABLE_TABS.has(tab)) return false;
  return (await getPanelGrants(client, user && user.id)).has(tab);
}
const _grantsCache = new Map(); // discordId -> { at, set:Set }
let _grantsPurgeAt = 0;
// Разделы, выданные участнику лично + всем его ролям.
async function getPanelGrants(client, discordId) {
  if (!discordId) return new Set();
  const hit = _grantsCache.get(discordId);
  if (hit && Date.now() - hit.at < 30000) return hit.set;
  const set = new Set();
  const nowIso = new Date().toISOString();
  const NOT_EXPIRED = "(expires_at IS NULL OR expires_at > ?)";
  try {
    // чистим протухшие не чаще раза в 10 минут на весь процесс
    if (Date.now() - _grantsPurgeAt > 600000) {
      _grantsPurgeAt = Date.now();
      db.run('DELETE FROM panel_grants WHERE expires_at IS NOT NULL AND expires_at <= ?', [nowIso]).catch(() => {});
    }
    const uRows = await db.all(`SELECT tab FROM panel_grants WHERE discord_id = ? AND COALESCE(subject_type,'user') = 'user' AND ${NOT_EXPIRED}`, [String(discordId), nowIso]);
    for (const r of uRows) set.add(r.tab);
    // роли участника
    let roleIds = [];
    try {
      const g = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
      const m = g ? g.members.cache.get(String(discordId)) : null;
      if (m) roleIds = [...m.roles.cache.keys()];
    } catch (_) {}
    if (roleIds.length) {
      const ph = roleIds.map(() => '?').join(',');
      const rRows = await db.all(`SELECT tab FROM panel_grants WHERE subject_type = 'role' AND discord_id IN (${ph}) AND ${NOT_EXPIRED}`, [...roleIds, nowIso]);
      for (const r of rRows) set.add(r.tab);
    }
  } catch (_) {}
  _grantsCache.set(discordId, { at: Date.now(), set });
  return set;
}

// Может ли этот пользователь видеть/открывать раздел панели `id`.
function panelCanTab(acc, grants, id) {
  const isHavirys = acc._isHavirys;
  const rankVis = {
    blacklist: acc.rank >= LEVELS.deputy, texts: acc.rank >= LEVELS.owner,
    faq_manage: acc.rank >= LEVELS.owner, reasons: acc.rank >= LEVELS.owner,
    broadcast: acc.rank >= LEVELS.owner, settings: acc.rank >= LEVELS.owner,
    perms: isHavirys, admin: isHavirys, data: acc.rank >= LEVELS.owner,
    forms: acc.rank >= LEVELS.hr,
    role_check: acc.rank >= LEVELS.deputy, hr_payouts: acc.rank >= LEVELS.owner,
    landing: isHavirys, pages: isHavirys, grants: isHavirys, accounts: isHavirys,
  };
  if (grants && grants.has(id) && GRANTABLE_TABS.has(id)) return true;
  if (acc.rank < LEVELS.hr) return false; // без ранга HR — только выданные разделы
  return rankVis[id] === undefined ? true : !!rankVis[id];
}

async function panelBody(client, acc, user, tab, pageNum, qtable, sp) {
  acc._isHavirys = !!(user && user.id === OWNER_ID);
  const grants = await getPanelGrants(client, user && user.id);
  const canTab = (id) => panelCanTab(acc, grants, id);
  const canData = canTab('data');
  const canBl = canTab('blacklist');
  const canOwner = acc.rank >= LEVELS.owner;
  const isHavirys = acc._isHavirys;

  const tabsHtml = PANEL_TABS
    .filter(([id]) => canTab(id))
    .map(([id, label]) => `<a class="${id === tab ? 'on' : ''}" href="/panel?tab=${id}">${esc(label)}</a>`).join('');

  let body = '';
  if (!canTab(tab)) body = '<div class="card">Раздел недоступен.</div>';
  else if (tab === 'overview') body = await panelOverview();
  else if (tab === 'sla') body = await panelSla(client, user, pageNum);
  else if (tab === 'apps') body = await panelApps(client, user, pageNum);
  else if (tab === 'queues') body = await panelQueues(client, user, pageNum);
  else if (tab === 'contracts_check') body = await panelContractCheck(client, user, pageNum, sp);
  else if (tab === 'role_check') body = await panelRoleCheck(client, user);
  else if (tab === 'members') body = await panelMembers(client, pageNum, user);
  else if (tab === 'contracts') body = await panelContracts(client);
  else if (tab === 'invites') body = await panelInvites(client);
  else if (tab === 'hr_payouts') body = await panelHrPayouts(client);
  else if (tab === 'giveaways') body = await panelGiveaways(client, acc, user);
  else if (tab === 'blacklist') body = await panelBlacklist(client, user);
  else if (tab === 'texts') body = await panelTexts(user);
  else if (tab === 'forms') body = await panelForms(client, user, acc);
  else if (tab === 'faq_manage') body = (await panelFaqManage(user)) + (await faqFeedbackReport());
  else if (tab === 'reasons') body = await panelReasons(user);
  else if (tab === 'broadcast') body = await panelBroadcast(user);
  else if (tab === 'settings') body = await panelSettings(user);
  else if (tab === 'perms') body = await panelPerms(user);
  else if (tab === 'admin') body = await panelAdmin(client, user);
  else if (tab === 'landing') body = await panelLanding(user);
  else if (tab === 'pages') body = await panelPages(client, user);
  else if (tab === 'grants') body = await panelGrants(client, user, sp);
  else if (tab === 'accounts') body = await panelAccounts(client, user);
  else if (tab === 'data') body = await panelData(client, qtable || 'participants', pageNum, user, sp);
  else body = '<div class="card">Раздел недоступен.</div>';

  const grantNote = (acc.rank < LEVELS.hr && grants.size)
    ? `<div class="muted">Вам выданы разделы: ${[...grants].map((t) => esc((PANEL_TABS.find(([i]) => i === t) || [t, t])[1])).join(', ')}</div>`
    : `<div class="muted">Ваш уровень: <b>${esc(acc.level)}</b></div>`;
  return `<h1>Панель управления</h1>
    ${grantNote}
    <div class="tabs">${tabsHtml}</div>
    ${body}`;
}

async function panelOverview() {
  const c = (sql, p = []) => db.get(sql, p).then((r) => (r ? r.c : 0));
  const q = {
    applications: await c("SELECT COUNT(*) c FROM applications WHERE status='pending'"),
    kicks: await c("SELECT COUNT(*) c FROM kicks WHERE status='pending'"),
    vacations: await c("SELECT COUNT(*) c FROM vacations WHERE status='pending'"),
    hr: await c("SELECT COUNT(*) c FROM hr_applications WHERE status='pending'"),
    data_change: await c("SELECT COUNT(*) c FROM data_change_requests WHERE status='pending'"),
    passport: await c("SELECT COUNT(*) c FROM passport_requests WHERE status='pending'"),
    appeals: await c("SELECT COUNT(*) c FROM appeals WHERE status='pending'"),
    codewords: await c("SELECT COUNT(*) c FROM codeword_submissions WHERE status='pending'"),
    tickets: await c("SELECT COUNT(*) c FROM tickets WHERE status='open'"),
  };
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const apps = await db.all('SELECT status FROM applications WHERE created_at >= ?', [since]);
  const accd = await db.all("SELECT status FROM acceptances WHERE joined_at >= ?", [since]);
  const total = apps.length;
  const acceptedN = apps.filter((a) => a.status === 'accepted').length;
  const stayed = accd.filter((a) => a.status === 'confirmed').length;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) + '%' : '—');

  const tile = (n, l) => `<div class="tile"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  return `
  <div class="card"><h2>Очереди на рассмотрение</h2><div class="grid">
    ${tile(q.applications, 'заявки на вступление')}
    ${tile(q.kicks, 'заявки на увольнение')}
    ${tile(q.vacations, 'заявки на отпуск')}
    ${tile(q.hr, 'заявки на HR')}
    ${tile(q.data_change, 'изменение данных')}
    ${tile(q.passport, 'добавление паспорта')}
    ${tile(q.appeals, 'апелляции ЧС')}
    ${tile(q.codewords, 'кодовые слова')}
    ${tile(q.tickets, 'открытых тикетов')}
  </div></div>
  <div class="card"><h2>Воронка найма за 30 дней</h2><div class="grid">
    ${tile(total, 'заявок подано')}
    ${tile(acceptedN + ' (' + pct(acceptedN, total) + ')', 'принято')}
    ${tile(stayed + ' (' + pct(stayed, acceptedN) + ')', 'досидело 3+ дня')}
  </div></div>`;
}

async function panelMembers(client, pageNum, user) {
  const totalRow = await db.get('SELECT COUNT(*) c FROM participants');
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all('SELECT * FROM participants ORDER BY name LIMIT ? OFFSET ?', [PAGE_SIZE, pageNum * PAGE_SIZE]);
  const rankOpts = (config.ROLE_IDS || []).map((rid) => `<option value="${esc(rid)}">${esc(roleName(client, rid))}</option>`).join('');
  const addForm = user ? `<div class="card"><h2>Добавить участника вручную</h2>
    <form method="POST" action="/panel/member/add" class="form">${csrfField(user)}
      <label>Discord ID<input name="discord_id" required pattern="[0-9]+" maxlength="25"></label>
      <label>Имя Фамилия<input name="name" required maxlength="60"></label>
      <label>№ Паспорта<input name="static" required pattern="[0-9]+" maxlength="12"></label>
      <label>LVL<input name="lvl" type="number" min="1" max="100" value="1"></label>
      <label>Ранг<select name="role_id">${rankOpts}</select></label>
      <button class="btn" type="submit">Добавить и оформить</button>
    </form>
    <p class="mini">Оформляет как приём заявки: роли, ник, канал-профиль, запись в историю.</p>
  </div>
  <div class="card"><h2>Импорт из CSV</h2>
    <form method="POST" action="/panel/member/import" class="form">${csrfField(user)}
      <label>CSV (колонки: discord_id, name, static, lvl, role_id — заголовок обязателен)<textarea name="csv" rows="5" placeholder="discord_id,name,static,lvl&#10;123...,Ivan Petrov,199615,20"></textarea></label>
      <button class="btn" type="submit">Импортировать</button>
    </form>
    <p class="mini">Пропускает уже существующих и занятые паспорта; итог покажет сколько добавлено/пропущено.</p>
  </div>` : '';
  const range = contracts.getWeekRange(0);
  const out = [];
  for (const p of rows) {
    const passports = await passportsLib.getAllPassports(p.discord_id);
    const week = await contracts.getUserWeekStats(p.discord_id, range);
    const status = passports.some((x) => x.vacation_until) ? '🏖️' : (passports.some((x) => x.afk_since) ? '💤' : '');
    out.push(`<tr>
      <td><a href="/u/${esc(p.discord_id)}">${esc(p.name)}</a></td>
      <td>${passports.map((x) => '№ ' + esc(x.static)).join(', ')}</td>
      <td>${passports.map((x) => esc(roleName(client, x.role_id))).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</td>
      <td>${week.fulfilled.length} / ${week.unfulfilled.length}</td>
      <td>${status || '—'}</td>
      <td class="muted">${fmt(p.joined_at)}</td>
    </tr>`);
  }
  return `${addForm}<div class="card"><h2>Участники — всего ${total}</h2>
    <div class="tablewrap"><table>
      <tr><th>Имя Фамилия</th><th>Паспорта</th><th>Ранги</th><th>Контракты нед.</th><th>Статус</th><th>Вступил</th></tr>
      ${out.join('')}
    </table></div>
    ${pager('/panel?tab=members', pageNum, total)}
  </div>`;
}

async function panelContracts(client) {
  const all = await contracts.getAllTimeLeaderboard();
  const week = await contracts.getWeekLeaderboard(contracts.getWeekRange(0));
  const rowsAll = all.slice(0, 25).map((r, i) => `<tr><td>${i + 1}</td><td>${personLink(client, r.discord_id)}</td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  const rowsWeek = week.slice(0, 25).map((r, i) => `<tr><td>${i + 1}</td><td>${personLink(client, r.discord_id)}</td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  return `
  <div class="card"><h2>Топ за неделю (${esc(contracts.formatWeekLabel(contracts.getWeekRange(0)))})</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${rowsWeek || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Топ за всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${rowsAll || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
}

async function panelInvites(client) {
  const all = await invitations.getAllTimeLeaderboard();
  const week = await invitations.getWeekLeaderboard(contracts.getWeekRange(0));
  const rows = (arr) => arr.slice(0, 25).map((r, i) => `<tr><td>${i + 1}</td><td>${personLink(client, r.inviter_discord_id)}</td><td>${r.cnt}</td></tr>`).join('');
  return `
  <div class="card"><h2>Топ приглашений за неделю</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Приглашений</th></tr>${rows(week) || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Топ приглашений за всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Приглашений</th></tr>${rows(all) || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
}

async function panelGiveaways(client, acc, user) {
  let manage = '';
  if (acc && acc.rank >= LEVELS.owner && user) {
    const active = await db.all("SELECT * FROM giveaways WHERE status='active' ORDER BY id DESC");
    const activeRows = [];
    for (const g of active) {
      const entrants = await giveaways.getEntries(g.id).catch(() => []);
      const entList = entrants.length
        ? `<details style="margin-top:6px"><summary class="mini" style="cursor:pointer">участники (${entrants.length})</summary>
             <div class="mini" style="margin-top:4px">${entrants.map((e) => personLink(client, e)).join(', ')}</div></details>`
        : '<span class="mini">пока никого</span>';
      activeRows.push(`<tr>
        <td>#${g.id} ${esc(g.prize)}</td>
        <td class="muted">${fmt(g.ends_at)}</td>
        <td>${entrants.length}${entList}</td>
        <td>
          <form method="POST" action="/panel/giveaway/end" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><button class="btn ghost sm" type="submit">Завершить</button></form>
          <form method="POST" action="/panel/giveaway/cancel" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><button class="btn ghost sm" type="submit">Отменить</button></form>
          <form method="POST" action="/panel/giveaway/entry_add" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><input name="did" placeholder="ID" pattern="[0-9]+" style="max-width:130px"><button class="btn ghost sm" type="submit">+уч.</button></form>
          <form method="POST" action="/panel/giveaway/entry_remove" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><input name="did" placeholder="ID" pattern="[0-9]+" style="max-width:130px"><button class="btn ghost sm" type="submit">−уч.</button></form>
        </td>
      </tr>`);
    }
    const ended = await db.all("SELECT * FROM giveaways WHERE status='ended' ORDER BY id DESC LIMIT 10");
    const endedRows = ended.map((g) => `<tr>
      <td>#${g.id} ${esc(g.prize)}</td>
      <td class="muted">${fmt(g.created_at)}</td>
      <td>${g.winners ? g.winners.split(',').filter(Boolean).map((w) => personLink(client, w)).join(', ') : '—'}</td>
      <td><form method="POST" action="/panel/giveaway/reroll" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><button class="btn ghost sm" type="submit">🎲 Реролл</button></form>
        <a class="btn ghost sm" href="/export/giveaway/${g.id}">CSV уч.</a></td>
    </tr>`).join('');
    const gwbl = await giveaways.getBlacklist();
    const gwblRows = gwbl.map((b) => `<tr><td>${personLink(client, b.discord_id)}</td><td>${esc(b.reason || '—')}</td>
      <td><form method="POST" action="/panel/gwbl/remove" style="display:inline">${csrfField(user)}<input type="hidden" name="did" value="${esc(b.discord_id)}"><button class="btn ghost sm" type="submit">убрать</button></form></td></tr>`).join('');
    const sched = await db.all("SELECT * FROM scheduled_giveaways WHERE status='pending' ORDER BY start_at ASC").catch(() => []);
    const schedRows = sched.map((s) => `<tr><td>${esc(s.prize)}</td><td class="muted">${fmt(s.start_at)}</td><td>${s.winners_count}</td>
      <td><form method="POST" action="/panel/giveaway/schedule_cancel" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${s.id}"><button class="btn ghost sm" type="submit">отменить</button></form></td></tr>`).join('');
    const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const recur = await db.all("SELECT * FROM giveaway_recurring_rules WHERE status IN ('active','paused') ORDER BY id DESC").catch(() => []);
    const recurRows = recur.map((r) => `<tr><td>${esc(r.prize)}</td><td>${WD[r.weekday] || '?'}</td><td>${r.winners_count}</td>
      <td><span class="badge ${r.status === 'active' ? 'ok' : 'warn'}">${r.status === 'active' ? 'активно' : 'на паузе'}</span></td>
      <td style="white-space:nowrap">
        <form method="POST" action="/panel/giveaway/recur_toggle" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${r.id}"><button class="btn ghost sm" type="submit">${r.status === 'active' ? 'пауза' : 'возобновить'}</button></form>
        <form method="POST" action="/panel/giveaway/recur_delete" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${r.id}"><button class="btn ghost sm" style="background:var(--bad)" type="submit">✕</button></form>
      </td></tr>`).join('');
    const recurCard = `<div class="card"><h2>Повторяющиеся розыгрыши</h2>
      <form method="POST" action="/panel/giveaway/recur_create" class="form">${csrfField(user)}
        <label>Приз<input name="prize" required maxlength="200"></label>
        <label>Число победителей<input name="winners" type="number" min="1" max="50" value="1" required></label>
        <label>Длительность каждого запуска (30m, 1h, 2d)<input name="duration" required maxlength="10"></label>
        <label>День недели<select name="weekday">${WD.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
        <label>ID канала<input name="channel_id" required pattern="[0-9]+" maxlength="25"></label>
        <label>ID обязательной роли (необязательно)<input name="role_id" pattern="[0-9]*" maxlength="25"></label>
        <button class="btn" type="submit">Создать правило</button>
      </form>
      <div class="tablewrap" style="margin-top:10px"><table><tr><th>Приз</th><th>День</th><th>Побед.</th><th>Статус</th><th></th></tr>${recurRows || '<tr><td colspan="5">—</td></tr>'}</table></div>
    </div>`;
    const tpls = await db.all('SELECT * FROM giveaway_templates ORDER BY name').catch(() => []);
    const tplRows = tpls.map((t) => `<tr>
      <td><b>${esc(t.name)}</b><div class="mini">${esc(t.prize)} · ${t.winners_count} побед. · ${esc(t.duration || '—')}</div></td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" type="button" onclick='fcGwTpl(${JSON.stringify({ prize: t.prize || '', winners: t.winners_count || 1, duration: t.duration || '', role_id: t.required_role_id || '', min_role_id: t.min_role_id || '', prize_tiers: t.prize_tiers || '' })})'>заполнить форму</button>
        <form method="POST" action="/panel/giveaway/tpl_del" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${t.id}"><button class="btn ghost sm" style="background:var(--bad)" type="submit">✕</button></form>
      </td></tr>`).join('');
    const tplCard = `<div class="card"><h2>Шаблоны розыгрышей</h2>
      <div class="tablewrap"><table><tr><th>Шаблон</th><th></th></tr>${tplRows || '<tr><td colspan="2">пока нет</td></tr>'}</table></div>
      <form method="POST" action="/panel/giveaway/tpl_save" class="form" style="margin-top:10px">${csrfField(user)}
        <label>Название шаблона<input name="name" required maxlength="60"></label>
        <label>Приз<input name="prize" required maxlength="200"></label>
        <label>Число победителей<input name="winners" type="number" min="1" max="50" value="1" required></label>
        <label>Длительность (30m, 1h, 2d)<input name="duration" maxlength="10"></label>
        <label>ID обязательной роли (необязательно)<input name="role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>ID минимальной роли (необязательно)<input name="min_role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>Призовые места (необязательно)<textarea name="prize_tiers" rows="2" maxlength="800"></textarea></label>
        <button class="btn sm" type="submit">Сохранить шаблон</button>
      </form>
      <script>function fcGwTpl(t){var f=document.getElementById('gwCreateForm');if(!f)return;for(var k in t){if(f[k]!==undefined)f[k].value=t[k];}f.scrollIntoView({behavior:'smooth'});}</script>
    </div>`;
    manage = `
    <div class="card"><h2>Создать розыгрыш</h2>
      <form method="POST" action="/panel/giveaway/create" class="form" id="gwCreateForm">
        ${csrfField(user)}
        <label>Приз<input name="prize" required maxlength="200"></label>
        <label>Число победителей<input name="winners" type="number" min="1" max="50" value="1" required></label>
        <label>Длительность (например 30m, 1h, 2d, 1w)<input name="duration" required maxlength="10"></label>
        <label>ID канала для публикации<input name="channel_id" required pattern="[0-9]+" maxlength="25"></label>
        <label>ID обязательной роли — только эта роль (необязательно)<input name="role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>ID минимальной роли — этот ранг и ВЫШЕ (необязательно)<input name="min_role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>Мин. выполненных контрактов за эту неделю (необязательно)<input name="min_contracts_week" type="number" min="0" max="99"></label>
        <label class="chk"><input type="checkbox" name="weight_by_contracts" value="1"><span>Бонус-билеты за активность: шанс победы растёт с числом контрактов за неделю (1 + контракты, максимум ×10)</span></label>
        <label>Призовые места (необязательно) — строка «место | приз», напр. «1 | Машина», «2-3 | 500к»<textarea name="prize_tiers" rows="3" maxlength="800" placeholder="1 | Главный приз&#10;2-3 | Утешительный приз"></textarea></label>
        <button class="btn" type="submit">Создать и опубликовать</button>
      </form>
    </div>
    ${tplCard}
    <div class="card"><h2>Активные розыгрыши</h2>
      <div class="tablewrap"><table><tr><th>Розыгрыш</th><th>Конец</th><th>Уч.</th><th>Действия</th></tr>${activeRows.join('') || '<tr><td colspan="4">—</td></tr>'}</table></div>
    </div>
    <div class="card"><h2>Запланировать розыгрыш</h2>
      <form method="POST" action="/panel/giveaway/schedule" class="form">
        ${csrfField(user)}
        <label>Приз<input name="prize" required maxlength="200"></label>
        <label>Число победителей<input name="winners" type="number" min="1" max="50" value="1" required></label>
        <label>Длительность розыгрыша (30m, 1h, 2d)<input name="duration" required maxlength="10"></label>
        <label>Старт: ДД.ММ.ГГГГ или дата-время<input name="start_at" required maxlength="30" placeholder="2026-09-01T18:00 или 01.09.2026"></label>
        <label>ID канала<input name="channel_id" required pattern="[0-9]+" maxlength="25"></label>
        <label>ID обязательной роли (необязательно)<input name="role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>ID минимальной роли (необязательно)<input name="min_role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>Призовые места (необязательно) — строка «место | приз»<textarea name="prize_tiers" rows="3" maxlength="800" placeholder="1 | Главный приз&#10;2-3 | Утешительный приз"></textarea></label>
        <button class="btn" type="submit">Запланировать</button>
      </form>
      <h3 style="margin-top:12px">Ожидают старта</h3>
      <div class="tablewrap"><table><tr><th>Приз</th><th>Старт</th><th>Победителей</th><th></th></tr>${schedRows || '<tr><td colspan="4">—</td></tr>'}</table></div>
    </div>
    ${recurCard}
    <div class="card"><a href="/giveaways/history">→ полная история розыгрышей</a></div>
    <div class="card"><h2>Завершённые — реролл</h2>
      <div class="tablewrap"><table><tr><th>Розыгрыш</th><th>Дата</th><th>Победители</th><th></th></tr>${endedRows || '<tr><td colspan="4">—</td></tr>'}</table></div>
    </div>
    <div class="card"><h2>ЧС розыгрышей</h2>
      <form method="POST" action="/panel/gwbl/add" class="form">${csrfField(user)}
        <label>Discord ID<input name="did" required pattern="[0-9]+" maxlength="25"></label>
        <label>Причина<input name="reason" maxlength="200"></label>
        <button class="btn sm" type="submit">Внести</button>
      </form>
      <div class="tablewrap"><table><tr><th>Discord</th><th>Причина</th><th></th></tr>${gwblRows || '<tr><td colspan="3">—</td></tr>'}</table></div>
    </div>`;
  }
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const rows = await giveaways.getFinishedSince(since);
  const list = rows.map((g) => `<tr>
    <td>${esc(g.prize)}</td>
    <td><span class="badge">${esc(ruStatus(g.status))}</span></td>
    <td class="muted">${fmt(g.created_at)}</td>
    <td>${g.winners ? g.winners.split(',').filter(Boolean).map((w) => personLink(client, w)).join(', ') : '—'}</td>
  </tr>`).join('');
  const wr = await giveaways.getEndedWinnersSince(since);
  const wc = new Map();
  for (const r of wr) for (const w of (r.winners || '').split(',').filter(Boolean)) wc.set(w, (wc.get(w) || 0) + 1);
  const top = [...wc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([w, n], i) => `<tr><td>${i + 1}</td><td>${personLink(client, w)}</td><td>${n}</td></tr>`).join('');
  return `
  ${manage}
  <div class="card"><h2>Розыгрыши за 90 дней</h2>
    <div class="tablewrap"><table><tr><th>Приз</th><th>Статус</th><th>Дата</th><th>Победители</th></tr>${list || '<tr><td colspan="4">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Чаще всех выигрывали</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Побед</th></tr>${top || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
}

const DATA_TABLES = {
  participants: ['Участники', [['discord_id', 'Discord ID'], ['discord_tag', 'Тег'], ['name', 'Имя Фамилия'], ['static', '№ Паспорта'], ['role_id', 'Ранг'], ['lvl', 'LVL'], ['joined_at', 'Вступил'], ['vacation_until', 'Отпуск до'], ['afk_since', 'AFK с']]],
  extra_passports: ['Доп. паспорта', [['discord_id', 'Discord ID'], ['name', 'Имя Фамилия'], ['static', '№ Паспорта'], ['position', 'Позиция'], ['role_id', 'Ранг']]],
  applications: ['Заявки на вступление', [['id', '#'], ['discord_tag', 'Тег'], ['name', 'Имя Фамилия'], ['static', '№ Паспорта'], ['lvl', 'LVL'], ['status', 'Статус'], ['reject_reason', 'Причина отказа'], ['created_at', 'Создана'], ['reviewed_at', 'Решена']]],
  kicks: ['Заявки на увольнение', [['id', '#'], ['discord_tag', 'Тег'], ['name', 'Имя Фамилия'], ['target_static', 'Паспорт'], ['reason', 'Причина'], ['status', 'Статус'], ['created_at', 'Создана']]],
  vacations: ['Заявки на отпуск', [['id', '#'], ['discord_tag', 'Тег'], ['until', 'До'], ['reason', 'Причина'], ['status', 'Статус'], ['created_at', 'Создана']]],
  contracts: ['Контракты', [['id', '#'], ['discord_id', 'Discord ID'], ['status', 'Статус'], ['submitted_at', 'Отправлен'], ['reviewed_by', 'Проверил'], ['reviewed_at', 'Проверен']]],
  invitations: ['Приглашения', [['id', '#'], ['inviter_discord_id', 'Пригласил'], ['invitee_name', 'Приглашённый'], ['invitee_static', '№ Паспорта'], ['status', 'Статус'], ['joined_at', 'Вступил']]],
  blacklist: ['Чёрный список', [['id', '#'], ['discord_id', 'Discord ID'], ['discord_tag', 'Тег'], ['static', '№ Паспорта'], ['reason', 'Причина'], ['until', 'До'], ['appeal_blocked', 'Апелляции запрещены'], ['added_by', 'Внёс'], ['created_at', 'Дата']]],
  giveaways: ['Розыгрыши', [['id', '#'], ['prize', 'Приз'], ['winners_count', 'Победителей'], ['status', 'Статус'], ['winners', 'ID победителей'], ['ends_at', 'Конец'], ['created_at', 'Создан']]],
  tickets: ['Тикеты', [['id', '#'], ['opener_id', 'Автор'], ['subject', 'Тема'], ['category', 'Тип'], ['status', 'Статус'], ['assigned_to', 'Взял'], ['rating', 'Оценка'], ['created_at', 'Создан'], ['closed_at', 'Закрыт']]],
  appeals: ['Апелляции ЧС', [['id', '#'], ['discord_id', 'Discord ID'], ['discord_tag', 'Тег'], ['status', 'Статус'], ['reject_reason', 'Причина отказа'], ['created_at', 'Создана'], ['resolved_at', 'Решена']]],
  codeword_submissions: ['Кодовые слова', [['id', '#'], ['discord_id', 'Discord ID'], ['name', 'Имя Фамилия'], ['static', '№ Паспорта'], ['status', 'Статус'], ['reviewed_by', 'Проверил'], ['submitted_at', 'Отправлено']]],
  web_users: ['Пользователи сайта', [['discord_id', 'Discord ID'], ['username', 'Ник'], ['first_login', 'Первый вход'], ['last_login', 'Последний вход'], ['login_count', 'Входов']]],
  audit_log: ['Аудит', [['id', '#'], ['actor_tag', 'Инициатор'], ['action', 'Действие'], ['details', 'Детали'], ['at', 'Когда']]],
};
const TICKET_CAT_RU = { question: 'Вопрос', complaint: 'Жалоба', other: 'Другое', appeal: 'Апелляция ЧС', bug: 'Баг на сайте', bug_discord: 'Баг Discord' };

function cell(client, col, val) {
  if (val == null || val === '') return '—';
  if (col === 'status') return esc(ruStatus(val));
  if (col === 'category') return esc(TICKET_CAT_RU[val] || val);
  if (col === 'role_id' || col === 'required_role_id' || col === 'min_role_id') return roleTag(client, val) || esc(roleName(client, val));
  if (col === 'appeal_blocked') return val ? 'да' : 'нет';
  if (col === 'rating') return val === 1 ? '👍' : (val === 0 ? '👎' : '—');
  if (/_at$|^until$|^ends_at$|^joined_at$|_login$/.test(col)) return esc(fmt(val));
  const s = String(val);
  const clipped = s.length > 200 ? s.slice(0, 200) + '…' : s;
  // details/text/note/reason часто содержат <@id> / <@&id> — показываем как в Discord
  if (/^(details|text|note|reason|content)$/.test(col)) return renderMentions(client, esc(clipped));
  return esc(clipped);
}

async function panelData(client, table, pageNum, user, sp) {
  const def = DATA_TABLES[table];
  if (!def) return '<div class="card">Неизвестная таблица.</div>';
  const [title, cols] = def;
  const canEdit = !!(user && user.id === OWNER_ID);
  const picker = Object.entries(DATA_TABLES)
    .map(([k, v]) => `<a class="${k === table ? 'on' : ''}" href="/panel?tab=data&table=${k}">${esc(v[0])}</a>`).join('');

  const q = sp ? (sp.get('q') || '').trim() : '';
  const sortReq = sp ? (sp.get('sort') || '') : '';
  const dir = sp && sp.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const info = await tableInfo(table);
  const colNames = info.map((ci) => ci.name);
  const sortCol = colNames.includes(sortReq) ? sortReq : 'rowid';

  let where = '';
  const wp = [];
  if (q) {
    const textCols = info.filter((ci) => /CHAR|TEXT|CLOB|^$/i.test(ci.type)).map((ci) => ci.name);
    if (textCols.length) {
      where = 'WHERE ' + textCols.map((cn) => `${cn} LIKE ?`).join(' OR ');
      for (const _ of textCols) wp.push(`%${q}%`);
    }
  }

  let total = 0;
  try {
    const t = await db.get(`SELECT COUNT(*) c FROM ${table} ${where}`, wp);
    total = t ? t.c : 0;
  } catch (_) {}
  let rows = [];
  try {
    rows = await db.all(`SELECT rowid AS __rid, * FROM ${table} ${where} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`, [...wp, PAGE_SIZE, pageNum * PAGE_SIZE]);
  } catch (e) {
    return `<div class="card">Ошибка чтения таблицы: ${esc(e.message)}</div>`;
  }
  const baseQ = `table=${table}${q ? '&q=' + encodeURIComponent(q) : ''}`;
  const sortLink = (key) => {
    const nd = (sortCol === key && dir === 'DESC') ? 'asc' : 'desc';
    return `/panel?tab=data&${baseQ}&sort=${key}&dir=${nd}`;
  };
  const head = (canEdit ? '<th></th>' : '') + cols.map(([key, label]) => `<th><a href="${sortLink(key)}">${esc(label)}${sortCol === key ? (dir === 'DESC' ? ' ▾' : ' ▴') : ''}</a></th>`).join('');
  const trs = rows.map((r) => {
    const editCell = canEdit ? `<td><a class="btn ghost sm" href="/panel/row?table=${table}&pk=${encodeURIComponent(r.__rid)}">✏️</a></td>` : '';
    return '<tr>' + editCell + cols.map(([key]) => `<td>${cell(client, key, r[key])}</td>`).join('') + '</tr>';
  }).join('');
  const addBtn = canEdit ? `<a class="btn sm" href="/panel/row/new?table=${table}">➕ Добавить строку</a>` : '';
  return `
  <div class="tabs">${picker}</div>
  <div class="card">
    <form method="GET" action="/panel" class="bar">
      <input type="hidden" name="tab" value="data"><input type="hidden" name="table" value="${esc(table)}">
      <input name="q" value="${esc(q)}" placeholder="поиск по тексту" style="max-width:260px">
      <button class="btn sm" type="submit">Найти</button>
      ${q ? `<a class="btn ghost sm" href="/panel?tab=data&table=${esc(table)}">сброс</a>` : ''}
    </form>
    <h2>${esc(title)} — найдено ${total}</h2>
    ${canEdit ? `<p class="muted" style="margin-bottom:10px">Режим редактирования (havirys): ✏️ — изменить строку. ${addBtn} <a class="btn ghost sm" href="/export/table/${esc(table)}.csv">⬇ Скачать всю таблицу CSV</a></p>
    <details style="margin-bottom:10px"><summary class="mini">CSV с выбором колонок</summary>
      <form method="GET" action="/export/table/${esc(table)}.csv" class="bar" style="flex-wrap:wrap;gap:4px;margin-top:6px">
        ${colNames.map((c) => `<label class="chk"><input type="checkbox" name="cols" value="${esc(c)}" checked><span>${esc(c)}</span></label>`).join('')}
        <button class="btn ghost sm" type="submit">⬇ Скачать выбранное</button>
      </form>
    </details>` : ''}
    <div class="tablewrap"><table><tr>${head}</tr>${trs || '<tr><td>—</td></tr>'}</table></div>
    ${pager(`/panel?tab=data&${baseQ}&sort=${sortCol}&dir=${dir.toLowerCase()}`, pageNum, total)}
  </div>`;
}

function pager(baseHref, pageNum, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return '';
  const sep = baseHref.includes('?') ? '&' : '?';
  const prev = pageNum > 0 ? `<a class="btn ghost sm" href="${baseHref}${sep}page=${pageNum - 1}">← Назад</a>` : '';
  const next = pageNum < pages - 1 ? `<a class="btn ghost sm" href="${baseHref}${sep}page=${pageNum + 1}">Вперёд →</a>` : '';
  return `<div class="pager">${prev}<span class="muted">стр. ${pageNum + 1} из ${pages}</span>${next}</div>`;
}

// ============ v3: запись через сайт ============
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } = dj;

let _guildRef = null;
function guildOf(client) {
  if (_guildRef) return _guildRef;
  const g = client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
  if (g) _guildRef = g; // кэшируем только когда бот уже подключён (объект стабильный)
  return g;
}

// Подписанная временная ссылка на /cimg/<id> — открывается без входа на сайт
// (для скринов в сообщениях Discord: кодовое слово и т.п.). Живёт 30 дней.
function signedCimgUrl(idOrUrl) {
  const m = /\/cimg\/(\d+)/.exec(String(idOrUrl || ''));
  const id = m ? m[1] : String(idOrUrl || '');
  if (!/^\d+$/.test(id)) return String(idOrUrl || '');
  const exp = Date.now() + 30 * 864e5;
  return `${baseUrl()}/cimg/${id}?t=${exp}.${sign('cimg:' + id + ':' + exp)}`;
}
function cimgTokenOk(id, tq) {
  const p = String(tq || '').split('.');
  if (p.length !== 2 || !/^\d+$/.test(p[0]) || Number(p[0]) < Date.now()) return false;
  try {
    const exp2 = sign('cimg:' + id + ':' + p[0]);
    return p[1].length === exp2.length && crypto.timingSafeEqual(Buffer.from(p[1]), Buffer.from(exp2));
  } catch (_) { return false; }
}

// Ссылка на пруф контракта: если это картинка (наш /cimg/... или .png/.jpg) —
// показываем миниатюрой; иначе обычной ссылкой (напр. на сообщение Discord).
function contractProof(url, label) {
  if (!url) return '';
  const u = String(url);
  const isImg = /\/cimg\/\d+/.test(u) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u);
  if (isImg) {
    return `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(label)}"><img src="${esc(u)}" alt="${esc(label)}" loading="lazy" style="max-width:150px;max-height:110px;border-radius:8px;border:1px solid var(--line);vertical-align:middle;margin:2px 6px 2px 0"></a>`;
  }
  return `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

// PRAGMA table_info кэшируется — схема во время работы не меняется (только
// на старте в db.init). Экономит запрос на каждом открытии редактора БД / правке.
const _tblInfoCache = new Map();
async function tableInfo(table) {
  if (_tblInfoCache.has(table)) return _tblInfoCache.get(table);
  let info = [];
  try { info = await db.all(`PRAGMA table_info(${table})`); } catch (_) {}
  if (info.length) _tblInfoCache.set(table, info);
  return info;
}
// Есть ли этот Discord-аккаунт сейчас на сервере организации.
async function memberOfGuild(client, discordId) {
  const id = String(discordId || '');
  if (!id || id.startsWith('local:') || id.startsWith('nodiscord-')) return false;
  const g = guildOf(client);
  if (!g) return false;
  if (g.members.cache.get(id)) return true;
  try { await g.members.fetch(id); return true; } catch (_) { return false; }
}
// Effective Discord id для проверки «на сервере»: у локального непривязанного
// к участнику аккаунта это его самостоятельно привязанный Discord (oauth).
function effectiveDiscordId(user) {
  if (!user) return null;
  if (user.local && String(user.id).startsWith('local:')) return user.oauthDiscordId || null;
  return user.id;
}

// Тело POST-запроса -> URLSearchParams (лимит 1 МБ)
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let aborted = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 8e6) { aborted = true; req.destroy(); } // до ~8 МБ (загрузка скринов)
    });
    req.on('end', () => resolve(aborted ? new URLSearchParams() : new URLSearchParams(data)));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

// CSRF-токен, привязанный к id пользователя и подписанный тем же секретом
function csrfToken(user) {
  const base = `${user.id}.${Math.floor(Date.now() / 1000)}`;
  return `${base}.${sign('csrf:' + base)}`;
}
function csrfOk(user, token) {
  if (!user || !token) return false;
  const p = String(token).split('.');
  if (p.length !== 3 || p[0] !== user.id) return false;
  const expected = sign('csrf:' + p[0] + '.' + p[1]);
  try {
    if (p[2].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(expected))) return false;
  } catch (_) { return false; }
  return (Date.now() / 1000 - Number(p[1])) < 7200; // токен живёт 2 часа
}
function csrfField(user) {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken(user))}">`;
}

// Анонимный CSRF-токен (для форм входа/регистрации, где ещё нет пользователя):
// подписанная метка времени, живёт 2 часа. Разделитель «|» — в base64url и в
// метке его нет (а IP не кладём: у IPv4/IPv6 есть точки/двоеточия).
function anonCsrf() {
  const base = `anon|${Math.floor(Date.now() / 1000)}`;
  return `${base}|${sign(base)}`;
}
function anonCsrfOk(_ip, token) {
  const p = String(token || '').split('|');
  if (p.length !== 3 || p[0] !== 'anon') return false;
  const base = `${p[0]}|${p[1]}`;
  try {
    const exp = sign(base);
    if (p[2].length !== exp.length || !crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(exp))) return false;
  } catch (_) { return false; }
  return (Date.now() / 1000 - Number(p[1])) < 7200;
}
function anonCsrfField() {
  return `<input type="hidden" name="_csrf" value="${esc(anonCsrf())}">`;
}

// ---------- Пароли локальных аккаунтов (scrypt, без сторонних зависимостей) ----------
function pwHash(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function pwMake(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: pwHash(pw, salt) }; }
function pwVerify(pw, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const a = Buffer.from(pwHash(pw, salt), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}
const LOGIN_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

const REVIEW_MENTION = () => config.ROLES_REVIEW_ALLOWED.map((r) => `<@&${r}>`).join(' ');
const REVIEW_MENTION_OPTS = { allowedMentions: { roles: config.ROLES_REVIEW_ALLOWED } };

async function postTo(client, channelId, payload) {
  const g = guildOf(client);
  if (!g || !channelId) return null;
  try {
    const ch = await g.channels.fetch(channelId);
    return await ch.send(payload);
  } catch (e) {
    console.error('[web] postTo', channelId, e.message);
    return null;
  }
}

async function dmTo(client, discordId, payload) {
  const g = guildOf(client);
  if (!g) return false;
  try {
    const m = await g.members.fetch(discordId);
    await m.send(payload);
    return true;
  } catch (_) { return false; }
}

// Двойной аудит: строка в БД + карточка в канал аудита Discord
async function webAudit(client, user, action, details) {
  try {
    await db.run(
      'INSERT INTO audit_log (actor_id, actor_tag, action, details, at) VALUES (?, ?, ?, ?, ?)',
      [user.id, `${user.username || user.id} (сайт)`, action, details || '', new Date().toISOString()],
    );
  } catch (e) { console.error('[web] audit', e.message); }
  await postTo(client, config.CHANNEL_AUDIT, {
    embeds: [new EmbedBuilder().setColor(0x5b6cff).setTitle('🌐 Действие с сайта').addFields(
      { name: 'Кто', value: `<@${user.id}> (${String(user.username || user.id).slice(0, 80)})` },
      { name: 'Действие', value: String(action).slice(0, 1000) },
      { name: 'Детали', value: String(details || '—').slice(0, 1000) },
    ).setTimestamp()],
  });
}

// Служебные/настроечные действия сайта (тема, страницы, меню, CSS, правка БД,
// импорт конфигурации, права команд, экспорты и т.п.). Пишется в audit_log с
// префиксом «⚙ » — на странице /аудит по умолчанию скрыто — и уходит в
// CHANNEL_SYSTEM_LOG, а НЕ в общий аудит-канал, чтобы не засорять его.
const META_PREFIX = '⚙ ';
async function webAuditMeta(client, user, action, details) {
  try {
    await db.run(
      'INSERT INTO audit_log (actor_id, actor_tag, action, details, at) VALUES (?, ?, ?, ?, ?)',
      [user.id, `${user.username || user.id} (сайт)`, META_PREFIX + action, details || '', new Date().toISOString()],
    );
  } catch (e) { console.error('[web] audit-meta', e.message); }
  await postTo(client, config.CHANNEL_SYSTEM_LOG || config.CHANNEL_AUDIT, {
    embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle('⚙ Служебное действие (сайт)').addFields(
      { name: 'Кто', value: `<@${user.id}> (${String(user.username || user.id).slice(0, 80)})` },
      { name: 'Действие', value: String(action).slice(0, 1000) },
      { name: 'Детали', value: String(details || '—').slice(0, 1000) },
    ).setTimestamp()],
  });
}

// Сессия «свежая», если её версия совпадает с web_users.sess_ver.
// Версию кэшируем на 60 сек, чтобы не читать БД на каждый запрос.
const _sessVerCache = new Map(); // discordId -> { at, ver }
const _frozenCache = new Map(); // discordId -> { at, frozen, reason }
async function sessionFresh(user) {
  if (!user) return false;
  const hit = _sessVerCache.get(user.id);
  let ver;
  if (hit && Date.now() - hit.at < 60000) {
    ver = hit.ver;
  } else {
    try {
      const row = await db.get('SELECT sess_ver FROM web_users WHERE discord_id = ?', [user.id]);
      ver = row ? (row.sess_ver || 0) : 0;
      _sessVerCache.set(user.id, { at: Date.now(), ver });
    } catch (_) { return true; }
  }
  if (ver !== (user.sv || 0)) return false;
  // разлогин конкретной сессии
  if (user.sid) {
    const rk = 'sid:' + user.sid;
    const rh = _sessVerCache.get(rk);
    if (rh && Date.now() - rh.at < 60000) return !rh.revoked;
    try {
      const sr = await db.get('SELECT revoked_at FROM web_sessions WHERE sid = ?', [user.sid]);
      const revoked = !!(sr && sr.revoked_at);
      _sessVerCache.set(rk, { at: Date.now(), revoked });
      return !revoked;
    } catch (_) { return true; }
  }
  return true;
}

// Создаёт полноценную веб-сессию для discordId (без OAuth) и возвращает
// строку Set-Cookie. Используется входом по одноразовой ссылке (/m/<token>).
async function issueWebSession(req, client, discordId) {
  const g = guildOf(client);
  const wu = await db.get('SELECT username, avatar FROM web_users WHERE discord_id = ?', [discordId]).catch(() => null);
  let uname = wu && wu.username;
  let avatar = (wu && wu.avatar) || '';
  if (!uname) {
    const m = g ? g.members.cache.get(String(discordId)) : null;
    uname = m ? m.user.username : String(discordId);
    if (m && m.user.avatar) avatar = m.user.avatar;
  }
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO web_users (discord_id, username, avatar, first_login, last_login, login_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar,
       last_login = excluded.last_login, login_count = login_count + 1`,
    [discordId, uname, avatar, now, now],
  );
  accessCache.delete(String(discordId));
  const svRow = await db.get('SELECT sess_ver FROM web_users WHERE discord_id = ?', [discordId]).catch(() => null);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '').slice(0, 300);
  await db.run('INSERT INTO web_logins (discord_id, ip, ua, at) VALUES (?, ?, ?, ?)', [discordId, ip, ua, now]).catch(() => {});
  const sid = crypto.randomBytes(9).toString('base64url');
  await db.run('INSERT INTO web_sessions (sid, discord_id, ip, ua, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)', [sid, discordId, ip, ua, now, now]).catch(() => {});
  const payload = makeSession({ id: String(discordId), username: uname, avatar, sv: svRow ? (svRow.sess_ver || 0) : 0, sid });
  return `fc_sess=${payload}; Path=/; Max-Age=${SESSION_DAYS * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`;
}

// Одноразовая ссылка входа: вызывается ботом (команда /сайт, кнопка в канале).
// Возвращает абсолютный URL вида https://…/m/<token>, живёт 10 минут.
async function createMagicLink(discordId) {
  const now = Date.now();
  // не плодим ссылки: максимум 3 неиспользованные и «свежие» за 15 минут
  try {
    const recent = await db.get(
      'SELECT COUNT(*) c FROM magic_links WHERE discord_id = ? AND used_at IS NULL AND created_at >= ?',
      [String(discordId), new Date(now - 15 * 60000).toISOString()],
    );
    if (recent && recent.c >= 3) {
      const last = await db.get(
        'SELECT token FROM magic_links WHERE discord_id = ? AND used_at IS NULL AND expires_at >= ? ORDER BY created_at DESC LIMIT 1',
        [String(discordId), new Date(now).toISOString()],
      );
      if (last) return baseUrl() + '/m/' + last.token;
    }
  } catch (_) {}
  const token = crypto.randomBytes(24).toString('base64url');
  await db.run(
    'INSERT INTO magic_links (token, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, String(discordId), new Date(now).toISOString(), new Date(now + 10 * 60000).toISOString()],
  );
  db.run('DELETE FROM magic_links WHERE expires_at < ?', [new Date(now - 24 * 3600000).toISOString()]).catch(() => {});
  return baseUrl() + '/m/' + token;
}

// ---------- iCal: подписка на календарь отпусков ----------
// Секретный токен для ссылки-подписки. Создаётся лениво при первом обращении.
async function getIcalToken(discordId) {
  const row = await db.get('SELECT ical_token FROM web_users WHERE discord_id = ?', [String(discordId)]).catch(() => null);
  if (row && row.ical_token) return row.ical_token;
  const token = crypto.randomBytes(18).toString('base64url');
  await db.run('UPDATE web_users SET ical_token = ? WHERE discord_id = ?', [token, String(discordId)]).catch(() => {});
  return token;
}
function icsEsc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsDate(d) {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}
async function buildVacationIcs(calName, onlyDiscordId) {
  const params = [];
  let sql = "SELECT v.id, v.discord_id, v.until, v.reason, v.created_at, p.name FROM vacations v "
    + "LEFT JOIN participants p ON p.discord_id = v.discord_id "
    + "WHERE v.status = 'accepted' AND v.until IS NOT NULL";
  if (onlyDiscordId) { sql += ' AND v.discord_id = ?'; params.push(String(onlyDiscordId)); }
  sql += ' ORDER BY v.created_at DESC LIMIT 800';
  const rows = await db.all(sql, params).catch(() => []);
  const host = (baseUrl().split('//')[1] || 'site').replace(/[^\w.-]/g, '');
  const stamp = `${icsDate(Date.now())}T000000Z`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Freelance Company//Vacations//RU',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(calName)}`,
  ];
  for (const r of rows) {
    const ds = icsDate(r.created_at);
    let de = icsDate(r.until);
    if (!ds || !de) continue;
    // DTEND для события-«на весь день» эксклюзивен — прибавляем сутки к дате окончания.
    const deEx = icsDate(new Date(new Date(r.until).getTime() + 864e5));
    lines.push('BEGIN:VEVENT', `UID:vac-${r.id}@${host}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ds}`, `DTEND;VALUE=DATE:${deEx || de}`,
      `SUMMARY:${icsEsc('🏖️ Отпуск — ' + (r.name || r.discord_id))}`);
    if (r.reason) lines.push(`DESCRIPTION:${icsEsc(r.reason)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Наблюдаемость: ошибки веб-сервера (5xx) и медленные запросы — в памяти,
// последние сутки; сбрасывается при рестарте (для /health этого достаточно).
const _errLog = [];
const _slowLog = [];
function recordWebErr(p, msg) {
  _errLog.push({ at: Date.now(), path: String(p).split('?')[0], msg: String(msg || '').slice(0, 300) });
  if (_errLog.length > 300) _errLog.splice(0, _errLog.length - 300);
}
const _since24 = () => Date.now() - 864e5;

// Простой rate-limit в памяти: не более N POST за окно на ключ.
const _rl = new Map();
function rateOk(key, limit = 40, windowMs = 60000) {
  const now = Date.now();
  const arr = (_rl.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  _rl.set(key, arr);
  if (_rl.size > 5000) for (const [k, v] of _rl) if (!v.length || now - v[v.length - 1] > windowMs) _rl.delete(k);
  return arr.length <= limit;
}

async function logDenial(client, user, what) {
  try {
    await db.run('INSERT INTO audit_log (actor_id, actor_tag, action, details, at) VALUES (?, ?, ?, ?, ?)',
      [user ? user.id : '', (user ? (user.username || user.id) : 'аноним') + ' (сайт)', 'Отказ доступа (сайт)', String(what).slice(0, 500), new Date().toISOString()]);
  } catch (_) {}
}

function flashBanner(u) {
  const ok = u.searchParams.get('ok');
  const err = u.searchParams.get('err');
  if (ok) return `<div class="toast ok" data-toast>✅ ${esc(ok)}</div>`;
  if (err) return `<div class="toast bad" data-toast>⛔ ${esc(err)}</div>`;
  return '';
}
function qs(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

// ---------- Карточки рассмотрения (copies из index.js, те же customId) ----------
function webApplyEmbed(app) {
  return new EmbedBuilder().setColor(0xfee75c).setTitle(`Заявка на вступление #${app.id}`).addFields(
    { name: 'Заявитель', value: `<@${app.discord_id}> (${app.discord_tag})` },
    { name: 'Имя Фамилия', value: app.name || '—', inline: true },
    { name: '№ Паспорта', value: app.static || '—', inline: true },
    { name: 'LVL', value: String(app.lvl || '—'), inline: true },
    { name: 'Кто пригласил', value: app.invited_by || '—', inline: true },
    { name: 'Навыки', value: app.skills || '—' },
    { name: 'Статус', value: '🕓 На рассмотрении · подано через сайт' },
  );
}
function webApplyComponents(app) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`apply_edit:${app.id}`).setLabel('✏️ Изменить').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`apply_accept:${app.id}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`apply_reject:${app.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`review_claim:application:${app.id}`).setLabel('🙋 Беру на рассмотрение').setStyle(ButtonStyle.Primary),
    ),
  ];
}
function webVacationEmbed(v) {
  return new EmbedBuilder().setColor(0xfee75c).setTitle(`Заявка на отпуск #${v.id}`).addFields(
    { name: 'Заявитель', value: `<@${v.discord_id}> (${v.discord_tag})` },
    { name: 'До какого числа', value: dates.formatDateTime(new Date(v.until)) },
    { name: 'Причина', value: v.reason || '—' },
    { name: 'Статус', value: '🕓 На рассмотрении · подано через сайт' },
  );
}
function webVacationComponents(v) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vacation_accept:${v.id}`).setLabel('✅ Одобрить').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vacation_reject:${v.id}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`review_claim:vacation:${v.id}`).setLabel('🙋 Беру на рассмотрение').setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ---------- Формы ----------
function applyBody(user, ref) {
  const refLine = ref ? `<p class="mini">Вас пригласили по ссылке (ID ${esc(ref)}) — это подставлено автоматически.</p>` : '';
  return `
  <h1>Заявка на вступление</h1>
  <div class="card">
    <p class="muted">Заполните форму — заявка уйдёт HR-Менеджерам в Discord. Ответ придёт в личные сообщения от бота.</p>
    ${refLine}
    <form method="POST" action="/apply" class="form">
      ${csrfField(user)}
      <label>Имя Фамилия персонажа<input name="name" required maxlength="60"></label>
      <label>№ Паспорта (только цифры)<input name="static" required pattern="[0-9]+" maxlength="12"></label>
      <label>LVL персонажа<input name="lvl" type="number" min="1" max="100" required></label>
      <label>Навыки / опыт<textarea name="skills" rows="3" maxlength="600"></textarea></label>
      <label>Кто пригласил (необязательно)<input name="invited_by" value="${esc(ref || '')}" maxlength="60"></label>
      <input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;opacity:0" aria-hidden="true">
      <button class="btn" type="submit">Отправить заявку</button>
    </form>
  </div>`;
}

function imgOrUrlFields(dataName, urlName, fileLabel) {
  return `<label>${fileLabel} — файл<input type="file" accept="image/*" data-img="${dataName}"></label>
    <label>…или ссылка<input name="${urlName}" maxlength="400" placeholder="https://..."></label>
    <input type="hidden" name="${dataName}">`;
}
// Один обработчик на все формы «скрин или ссылка»: сжимает выбранные файлы и шлёт.
const IMGFORM_SCRIPT = `
if(!window.fcImgFormSubmit) window.fcImgFormSubmit=function fcImgFormSubmit(f){
  var hid=f.querySelectorAll('input[type=file][data-img]'), pending=0;
  function done(){
    var okAll=true;
    hid.forEach(function(inp){
      var dn=inp.getAttribute('data-img'), un=dn.replace(/_data$/,'_url');
      var u=f[un]; var has=(f[dn]&&f[dn].value)||(u&&/^https?:\\/\\//i.test(u.value||''));
      if(!has)okAll=false;
    });
    if(!okAll){ alert('Приложите скриншот: файл с устройства или ссылку (http).'); return; }
    f.submit();
  }
  hid.forEach(function(inp){ var file=inp.files[0]; if(!file)return; pending++;
    var img=new Image(), url=URL.createObjectURL(file);
    img.onload=function(){ var s=Math.min(1,1280/Math.max(img.width,img.height));
      var c=document.createElement('canvas'); c.width=Math.round(img.width*s)||1; c.height=Math.round(img.height*s)||1;
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      try{ f[inp.getAttribute('data-img')].value=c.toDataURL('image/jpeg',0.72); }catch(e){}
      URL.revokeObjectURL(url); if(--pending===0)done(); };
    img.onerror=function(){ URL.revokeObjectURL(url); if(--pending===0)done(); };
    img.src=url; });
  if(pending===0)done();
  return false;
};`;

// Доп. действия участника: контракты в работе, кодовое слово, заявка на HR, возврат из AFK.
async function memberActionsExtra(client, user, p, passports, acc) {
  const did = user.id;
  const passOpts = passports.map((pp) => `<option value="${esc(pp.static)}">${esc(pp.name)} — № ${esc(pp.static)}</option>`).join('');
  const stuckH = (typeof config.STUCK_CONTRACT_HOURS === 'number' ? config.STUCK_CONTRACT_HOURS : 24);

  // Контракты в работе (взял, но не сдал итог)
  const taken = await db.all(
    "SELECT c.id, c.thread_id, c.taken_submitted_at, (SELECT u.id FROM contract_uploads u WHERE u.contract_id = c.id AND u.slot = 'taken' ORDER BY u.id DESC LIMIT 1) AS taken_img FROM contracts c WHERE c.discord_id = ? AND c.status = 'taken' ORDER BY c.taken_submitted_at ASC",
    [did],
  ).catch(() => []);
  const threadToPass = {};
  for (const pp of passports) if (pp.profile_thread_id) threadToPass[pp.profile_thread_id] = pp.static;
  const takenCard = `<div class="card"><h2>Контракты в работе (${taken.length})</h2>
    ${taken.length ? taken.map((c) => {
      const ageH = c.taken_submitted_at ? Math.floor((Date.now() - new Date(c.taken_submitted_at)) / 36e5) : 0;
      const stuck = ageH >= stuckH;
      const num = threadToPass[c.thread_id];
      const thumb = c.taken_img
        ? `<a href="/cimg/${c.taken_img}" target="_blank" rel="noopener" title="Скрин «взял»"><img src="/cimg/${c.taken_img}" alt="взял" style="max-width:120px;max-height:90px;border-radius:8px;border:1px solid var(--line);display:block;margin:6px 0"></a>`
        : '';
      return `<div class="bar" style="border-top:1px solid var(--line);padding-top:8px">
        <span class="mini">#${c.id}${num ? ' · № ' + esc(num) : ''} · взят ${fmt(c.taken_submitted_at)} · <span style="${stuck ? 'color:var(--bad);font-weight:700' : ''}">${ageH} ч назад${stuck ? ' — висит!' : ''}</span></span>
        ${thumb}
        <form method="POST" action="/me/contract_finish" class="form" style="margin:0" onsubmit="return fcImgFormSubmit(this)">${csrfField(user)}<input type="hidden" name="id" value="${c.id}">
          ${imgOrUrlFields('result_data', 'result_url', 'Скрин «Итог»')}
          <button class="btn sm" type="submit">Сдать итог на проверку</button>
        </form>
        <form method="POST" action="/me/contract_cancel" style="margin:4px 0 0" onsubmit="return confirm('Отменить взятый контракт #${c.id}? Скрин «взял» будет удалён.')">${csrfField(user)}<input type="hidden" name="id" value="${c.id}">
          <button class="btn sm ghost" type="submit">Отменить</button>
        </form>
      </div>`;
    }).join('') : '<span class="mini">нет — возьмите контракт выше</span>'}
  </div>`;

  // Кодовое слово
  const cwPend = await db.get("SELECT COUNT(*) c FROM codeword_submissions WHERE discord_id = ? AND status = 'pending'", [did]).catch(() => null);
  const codewordCard = `<div class="card"><h2>Кодовое слово «контракт» (Weazel News)</h2>
    <p class="mini">Пришлите скрин отправки кодового слова. После подтверждения руководством попадёт в дневной список на возврат денег.${cwPend && cwPend.c ? ` Сейчас на проверке: ${cwPend.c}.` : ''}</p>
    ${passports.length ? `<form method="POST" action="/me/codeword" class="form" onsubmit="return fcImgFormSubmit(this)">${csrfField(user)}
      <label>Паспорт<select name="static" required>${passOpts}</select></label>
      ${imgOrUrlFields('cw_data', 'cw_url', 'Скрин отправки')}
      <button class="btn" type="submit">Отправить</button>
    </form>` : '<p class="mini">Нужен паспорт.</p>'}
  </div>`;

  // Заявка на HR (если ещё не HR и нет открытой заявки) + статус последней
  let hrCard = '';
  if (acc.rank < LEVELS.hr) {
    const hrLast = await db.get("SELECT id, status, reject_reason, created_at FROM hr_applications WHERE discord_id = ? ORDER BY id DESC LIMIT 1", [did]).catch(() => null);
    const hrPend = hrLast && hrLast.status === 'pending';
    const statusLine = hrLast
      ? (hrLast.status === 'pending'
        ? `<p class="mini">Ваша заявка от ${fmt(hrLast.created_at)} — <span class="badge warn">на рассмотрении</span></p>`
        : hrLast.status === 'accepted'
          ? `<p class="mini">Последняя заявка — <span class="badge ok">принята</span> ${fmt(hrLast.created_at)}</p>`
          : `<p class="mini">Последняя заявка (${fmt(hrLast.created_at)}) — <span class="badge bad">отклонена</span>${hrLast.reject_reason ? `: ${esc(hrLast.reject_reason)}` : ''}</p>`)
      : '';
    hrCard = `<div class="card"><h2>Подать заявку на HR-Менеджера</h2>
      ${statusLine}
      ${hrPend ? '' : `
      <form method="POST" action="/me/hr_apply" class="form">${csrfField(user)}
        <label>Часов в неделю в игре<input name="hours_per_week" required maxlength="60"></label>
        <label>Когда готовы пройти мини-обучение<input name="training_ready" required maxlength="120"></label>
        <button class="btn" type="submit">${hrLast ? 'Подать заявку снова' : 'Отправить заявку'}</button>
      </form>`}
    </div>`;
  }

  // Возврат из AFK
  const afkPass = passports.filter((pp) => pp.afk_since);
  let afkCard = '';
  if (afkPass.length) {
    const reqs = await db.all('SELECT static FROM afk_return_requests WHERE discord_id = ?', [did]).catch(() => []);
    const reqSet = new Set(reqs.map((r) => r.static));
    afkCard = `<div class="card"><h2>Возврат из AFK</h2>
      <p class="mini">Нажмите «Я вернулся» — руководство подтвердит, и AFK снимется.</p>
      ${afkPass.map((pp) => reqSet.has(pp.static)
        ? `<div class="mini">№ ${esc(pp.static)} — запрос отправлен, ждём подтверждения ⏳</div>`
        : `<form method="POST" action="/me/afk_return" style="display:inline-block;margin:3px 6px 3px 0">${csrfField(user)}<input type="hidden" name="static" value="${esc(pp.static)}"><button class="btn sm" type="submit">Я вернулся (№ ${esc(pp.static)})</button></form>`).join('')}
    </div>`;
  }

  return `<script>${IMGFORM_SCRIPT}</script>` + takenCard + afkCard + codewordCard + hrCard;
}

function memberForms(user, passports = [], blacklisted = false) {
  const passOpts = passports.map((pp) => `<option value="${esc(pp.static)}">${esc(pp.name)} — № ${esc(pp.static)}</option>`).join('');
  return `
  <script>${IMGFORM_SCRIPT}</script>
  <div class="card"><h2>Взять контракт</h2>
    ${passports.length ? `
    <p class="mini">Пришлите скрин «взял контракт». Потом, когда выполните — сдадите итог кнопкой в «Контракты в работе».</p>
    <form method="POST" action="/me/contract_take" class="form" onsubmit="return fcImgFormSubmit(this)">
      ${csrfField(user)}
      <label>Паспорт<select name="static" required>${passOpts}</select></label>
      ${imgOrUrlFields('taken_data', 'taken_url', 'Скрин «Взял контракт»')}
      <button class="btn" type="submit">Взять контракт</button>
    </form>`
      : '<p class="mini">У вас нет паспортов — сдать контракт нельзя.</p>'}
  </div>
  <div class="card"><h2>Запросить отпуск</h2>
    <form method="POST" action="/me/vacation" class="form">
      ${csrfField(user)}
      <label>До какого числа (ДД.ММ.ГГГГ или, например, 7d)<input name="deadline" required maxlength="20"></label>
      <label>Причина<textarea name="reason" rows="2" maxlength="400"></textarea></label>
      <button class="btn" type="submit">Отправить на рассмотрение</button>
    </form>
  </div>
  <div class="card"><h2>Открыть тикет в поддержку</h2>
    <form method="POST" action="/me/ticket" class="form">
      ${csrfField(user)}
      <label>Тип обращения
        <select name="category">
          <option value="question">Вопрос</option>
          <option value="complaint">Жалоба</option>
          <option value="other">Другое</option>
          <option value="bug">🐞 Баг на сайте</option>
          <option value="bug_discord">🐞 Баг Discord</option>
        </select>
      </label>
      <label>Тема<input name="subject" required maxlength="100"></label>
      <label>Описание<textarea name="description" rows="3" maxlength="1000"></textarea></label>
      <button class="btn" type="submit">Создать тикет в Discord</button>
    </form>
    <p class="mini" style="margin-top:6px">Нашли ошибку на сайте? <a href="/bug">🐞 Сообщить о баге</a> — отдельная короткая форма.</p>
  </div>
  ${passports.length ? `<div class="card"><h2>Заявка на изменение Имени Фамилии</h2>
    <form method="POST" action="/me/data_change" class="form">${csrfField(user)}
      <label>Паспорт<select name="static">${passOpts}</select></label>
      <label>Новое Имя Фамилия<input name="new_name" required maxlength="60"></label>
      <button class="btn" type="submit">Отправить на рассмотрение</button>
    </form>
  </div>` : ''}
  <div class="card"><h2>Заявка на добавление паспорта</h2>
    <form method="POST" action="/me/passport_request" class="form">${csrfField(user)}
      <label>Имя Фамилия<input name="name" required maxlength="60"></label>
      <label>№ Паспорта<input name="static" required pattern="[0-9]+" maxlength="12"></label>
      <button class="btn" type="submit">Отправить на рассмотрение</button>
    </form>
  </div>
  ${blacklisted ? `<div class="card" style="border-color:#5c2626"><h2>Апелляция на чёрный список</h2>
    <form method="POST" action="/me/appeal" class="form">${csrfField(user)}
      <label>Ваше обращение к руководству<textarea name="text" rows="4" required maxlength="1500"></textarea></label>
      <button class="btn" type="submit">Подать апелляцию</button>
    </form>
  </div>` : ''}`;
}

async function panelBlacklist(client, user) {
  const rows = await db.all('SELECT * FROM blacklist ORDER BY id DESC LIMIT 100');
  const list = rows.map((b) => `<tr>
    <td>${esc(b.discord_id || '—')}</td>
    <td>${esc(b.static || '—')}</td>
    <td>${esc(b.reason || '—')}</td>
    <td class="muted">${b.until ? 'до ' + fmt(b.until) : 'бессрочно'}</td>
    <td><form method="POST" action="/panel/blacklist/remove" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${b.id}"><button class="btn ghost sm" type="submit">Убрать</button></form></td>
  </tr>`).join('');
  return `
  <div class="card"><h2>Внести в чёрный список</h2>
    <form method="POST" action="/panel/blacklist/add" class="form">
      ${csrfField(user)}
      <label>Discord ID<input name="discord_id" pattern="[0-9]*" maxlength="25"></label>
      <label>№ Паспорта<input name="static" pattern="[0-9]*" maxlength="12"></label>
      <label>Причина<input name="reason" required maxlength="300"></label>
      <label>До какого числа (пусто — бессрочно)<input name="until" maxlength="20"></label>
      <button class="btn" type="submit">Внести</button>
    </form>
    <p class="muted" style="margin-top:8px">Если человек сейчас в организации — его нужно уволить вручную в Discord, сайт только добавляет запись в ЧС.</p>
  </div>
  <div class="card"><h2>Записи ЧС (последние 100)</h2>
    <div class="tablewrap"><table><tr><th>Discord ID</th><th>Паспорт</th><th>Причина</th><th>Срок</th><th></th></tr>${list || '<tr><td colspan="5">—</td></tr>'}</table></div>
  </div>`;
}

async function rowEditBody(client, user, table, pk) {
  const def = DATA_TABLES[table];
  if (!def) return '<div class="card">Неизвестная таблица.</div>';
  const info = await tableInfo(table);
  const rowObj = await db.get(`SELECT rowid AS __rid, * FROM ${table} WHERE rowid = ?`, [pk]);
  if (!rowObj) return '<div class="card">Строка не найдена.</div>';
  const fields = info.map((ci) => {
    const val = rowObj[ci.name];
    const ro = ci.pk ? ' readonly' : '';
    return `<label>${esc(ci.name)} <span class="muted">${esc(ci.type)}${ci.pk ? ' · PK' : ''}</span>
      <input name="f_${esc(ci.name)}" value="${esc(val == null ? '' : val)}"${ro}></label>`;
  }).join('');
  return `
  <h1>${esc(def[0])} — строка (rowid ${esc(pk)})</h1>
  <p><a href="/panel?tab=data&table=${esc(table)}">← к таблице</a></p>
  <div class="card">
    <form method="POST" action="/panel/row/save" class="form">
      ${csrfField(user)}
      <input type="hidden" name="table" value="${esc(table)}">
      <input type="hidden" name="pk" value="${esc(pk)}">
      ${fields}
      <button class="btn" type="submit">Сохранить</button>
    </form>
  </div>
  <div class="card">
    <form method="POST" action="/panel/row/delete" onsubmit="return confirm('Удалить строку безвозвратно?')">
      ${csrfField(user)}
      <input type="hidden" name="table" value="${esc(table)}">
      <input type="hidden" name="pk" value="${esc(pk)}">
      <button class="btn" style="background:var(--bad)" type="submit">Удалить строку</button>
    </form>
  </div>`;
}

async function rowNewBody(client, user, table) {
  const def = DATA_TABLES[table];
  if (!def) return '<div class="card">Неизвестная таблица.</div>';
  const info = await tableInfo(table);
  const fields = info.filter((ci) => !(ci.pk && /INT/i.test(ci.type))).map((ci) =>
    `<label>${esc(ci.name)} <span class="muted">${esc(ci.type)}</span><input name="f_${esc(ci.name)}"></label>`).join('');
  return `
  <h1>${esc(def[0])} — новая строка</h1>
  <p><a href="/panel?tab=data&table=${esc(table)}">← к таблице</a></p>
  <div class="card"><form method="POST" action="/panel/row/add" class="form">
    ${csrfField(user)}<input type="hidden" name="table" value="${esc(table)}">
    ${fields}
    <button class="btn" type="submit">Добавить</button>
  </form></div>`;
}

// ---------- Аватары ----------
function avatarUrl(id, hash, size = 96) {
  if (hash) {
    const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=${size}`;
  }
  let idx = 0;
  try { idx = Number((BigInt(id) >> 22n) % 6n); } catch (_) { idx = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}
async function resolveAvatar(client, id, size = 128) {
  // размер картинки Discord должен быть степенью двойки (16..4096)
  const SZ = [16, 32, 64, 128, 256, 512, 1024];
  const s = SZ.includes(size) ? size : 128;
  const g = guildOf(client);
  if (g) {
    try {
      const m = g.members.cache.get(String(id)) || await g.members.fetch(id);
      return m.displayAvatarURL({ extension: 'png', size: s });
    } catch (_) {}
  }
  const wu = await db.get('SELECT avatar FROM web_users WHERE discord_id = ?', [id]).catch(() => null);
  return avatarUrl(id, wu && wu.avatar, s);
}
// Аватар в виде data:-URI (сервер скачивает картинку с CDN Discord и кодирует
// её в base64). Нужно там, где <img> попадает в клиентский рендер PNG/SVG:
// внешние картинки в foreignObject/canvas браузер не грузит, и аватар «ломается».
const _avUriCache = new Map(); // url -> { at, uri }
async function avatarDataUri(client, id, size = 128) {
  let url = '';
  try { url = await resolveAvatar(client, id, size); } catch (_) {}
  if (!url || url.startsWith('data:')) return url || '';
  const hit = _avUriCache.get(url);
  if (hit && Date.now() - hit.at < 3600e3) return hit.uri;
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const ct = (res.headers.get('content-type') || 'image/png').split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 2_000_000) return url;
    const uri = `data:${ct};base64,${buf.toString('base64')}`;
    _avUriCache.set(url, { at: Date.now(), uri });
    if (_avUriCache.size > 400) _avUriCache.clear();
    return uri;
  } catch (_) { return url; }
}

// ---------- Просмотр участников ----------
async function peopleBody(client, acc, query, pageNum, user) {
  const q = (query || '').trim();
  let where = '';
  let params = [];
  if (q) {
    where = 'WHERE name LIKE ? OR static LIKE ? OR discord_id = ? OR discord_tag LIKE ?';
    params = [`%${q}%`, `%${q}%`, q, `%${q}%`];
  }
  const totalRow = await db.get(`SELECT COUNT(*) c FROM participants ${where}`, params);
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all(
    `SELECT discord_id, name, static, role_id, joined_at FROM participants ${where} ORDER BY name LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, pageNum * PAGE_SIZE],
  );
  const bulk = acc.rank >= LEVELS.deputy && user;
  const cols = bulk ? 5 : 4;
  const list = rows.map((p) => `<tr>
    ${bulk ? `<td class="selcol"><input type="checkbox" class="pchk" name="ids" value="${esc(p.discord_id)}"></td>` : ''}
    <td>${onlineDot(client, p.discord_id)}<a href="/u/${esc(p.discord_id)}">${esc(p.name)}</a></td>
    <td>№ ${esc(p.static)}</td>
    <td>${esc(roleName(client, p.role_id))}</td>
    <td class="muted">${fmt(p.joined_at)}</td>
  </tr>`).join('');
  const head = `${bulk ? '<th class="selcol"><input type="checkbox" id="pchkAll" title="Выбрать всех на странице"></th>' : ''}<th>Имя Фамилия</th><th>Паспорт</th><th>Ранг</th><th>Вступил</th>`;
  const tableBlock = `<div class="tablewrap"><table><tr>${head}</tr>${list || `<tr><td colspan="${cols}">—</td></tr>`}</table></div>`;
  const inner = bulk
    ? `<form method="POST" action="/people/bulk" id="peopleBulk">${csrfField(user)}
        ${tableBlock}
        <div class="bulkbar">
          <span class="cap">Действие с отмеченными (<span class="cnt" id="pchkCnt">0</span>)</span>
          <div class="row">
            <select name="act">
              <option value="vacation">🏖️ Выдать отпуск</option>
              <option value="dm">✉️ Отправить ЛС</option>
              <option value="rank_recalc">🔁 Пересчитать ранги (всем)</option>
            </select>
            <input name="deadline" placeholder="срок: 7d или дата">
            <input name="text" placeholder="текст сообщения / причина">
            <button class="btn sm" type="submit">Применить</button>
          </div>
          <p class="hint">«Срок» — длительность вида <b>7d</b> либо дата; нужен для отпуска. «Текст» — тело ЛС при рассылке и причина в журнале. «Пересчитать ранги» действует на всех и отметок не требует.</p>
        </div>
        <script>(function(){var f=document.getElementById('peopleBulk');if(!f)return;
          var all=document.getElementById('pchkAll'),c=document.getElementById('pchkCnt');
          var boxes=function(){return f.querySelectorAll('input.pchk');};
          var upd=function(){var b=boxes(),n=0;for(var i=0;i<b.length;i++)if(b[i].checked)n++;
            if(c)c.textContent=n;if(all){all.checked=n>0&&n===b.length;all.indeterminate=n>0&&n<b.length;}};
          if(all)all.addEventListener('change',function(){var b=boxes();for(var i=0;i<b.length;i++)b[i].checked=all.checked;upd();});
          f.addEventListener('change',function(e){if(e.target&&e.target.classList&&e.target.classList.contains('pchk'))upd();});
          upd();})();</script>
      </form>`
    : tableBlock;
  return `
  <h1>Участники</h1>
  <div id="fc-recent" class="bar" style="flex-wrap:wrap;gap:4px;margin-bottom:8px"></div>
  <div class="card">
    <form method="GET" action="/people" class="form">
      <label>Поиск по имени / паспорту / Discord ID<input name="q" value="${esc(q)}" maxlength="60"></label>
      <button class="btn" type="submit">Найти</button>
    </form>
  </div>
  <div class="card"><h2>Найдено: ${total}</h2>
    ${inner}
    ${pager('/people' + (q ? '?q=' + encodeURIComponent(q) : ''), pageNum, total)}
  </div>`;
}

async function profileBody(client, viewer, acc, targetId) {
  if (!/^\d{5,25}$/.test(targetId || '')) return '<div class="card">Неверный ID.</div><p><a href="/people">← к списку</a></p>';
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [targetId]);
  const av = await avatarDataUri(client, targetId, 128);
  const bl = await db.all('SELECT * FROM blacklist WHERE discord_id = ?', [targetId]);
  const blBox = bl.length
    ? `<div class="card" style="border-color:#5c2626"><span class="badge bad">В чёрном списке</span> ${esc(bl.map((b) => (b.reason || '—') + (b.until ? ' (до ' + fmt(b.until) + ')' : '')).join('; '))}</div>`
    : '';

  if (!p) {
    return `
    <div class="phead"><img class="avatar" width="72" height="72" src="${esc(av)}" alt=""><h1>${esc(targetId)}</h1></div>
    ${blBox}
    <div class="card">Этот пользователь не состоит в организации.</div>
    <p><a href="/people">← к списку участников</a></p>`;
  }

  const passports = await passportsLib.getAllPassports(targetId);
  const ident = await passportsLib.computeEffectiveIdentity(targetId);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(targetId, range);
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [targetId]);
  const hist = await history.getHistory(targetId).catch(() => []);
  const contractHist = await db.all("SELECT status, submitted_at, reviewed_at, message_url, taken_message_url FROM contracts WHERE discord_id = ? ORDER BY COALESCE(submitted_at, reviewed_at) DESC LIMIT 40", [targetId]).catch(() => []);
  const thanksRows = await db.all('SELECT from_id, note, created_at FROM thanks WHERE to_id = ? ORDER BY id DESC LIMIT 30', [targetId]).catch(() => []);
  const thanksCnt = thanksRows.length;
  const badgeAwards = await db.all('SELECT badge_key, awarded_at FROM badge_awards WHERE discord_id = ? ORDER BY awarded_at DESC LIMIT 20', [targetId]).catch(() => []);
  // 12 недель контрактов для спарклайна — одним запросом, раскладываем по неделям в памяти
  const spWk = [];
  for (let w = 11; w >= 0; w--) { const r = contracts.getWeekRange(w); spWk.push([r.start.getTime(), r.end.getTime()]); }
  const oldest = spWk[0][0];
  const sparkWeeks = new Array(12).fill(0);
  const spRows = await db.all("SELECT submitted_at FROM contracts WHERE discord_id = ? AND status='fulfilled' AND submitted_at >= ?", [targetId, new Date(oldest).toISOString()]).catch(() => []);
  for (const row of spRows) {
    const t = new Date(row.submitted_at).getTime();
    for (let i = 0; i < 12; i++) { if (t >= spWk[i][0] && t <= spWk[i][1]) { sparkWeeks[i]++; break; } }
  }
  const nicks = await db.all('SELECT * FROM nickname_history WHERE discord_id = ? ORDER BY id DESC LIMIT 20', [targetId]).catch(() => []);
  const promos = await db.all(
    "SELECT * FROM audit_log WHERE (action LIKE '%овышение%' OR action LIKE '%онижение%') AND details LIKE ? ORDER BY id DESC LIMIT 20",
    [`%${targetId}%`],
  ).catch(() => []);
  const invitedByRow = await db.get('SELECT inviter_discord_id, joined_at FROM invitations WHERE invitee_discord_id = ? ORDER BY id DESC LIMIT 1', [targetId]).catch(() => null);
  const bs = await computeBadgesAndStreak(client, targetId, p, invRow ? invRow.c : 0);

  let roleTags = '<span class="muted">—</span>';
  const g = guildOf(client);
  if (g) {
    try {
      const m = g.members.cache.get(targetId) || await g.members.fetch(targetId);
      const names = m.roles.cache.filter((r) => r.name !== '@everyone').map((r) => `<span class="pill">${esc(r.name)}</span>`);
      roleTags = names.length ? names.join('') : '<span class="muted">нет ролей</span>';
    } catch (_) { roleTags = '<span class="muted">нет на сервере</span>'; }
  }

  const passRows = passports.map((pp) => `<tr>
    <td>${esc(pp.name)}</td>
    <td><span class="pill">№ ${esc(pp.static)}</span></td>
    <td>${esc(roleName(client, pp.role_id))}</td>
    <td>${pp.vacation_until ? '🏖️ до ' + fmt(pp.vacation_until) : (pp.afk_since ? '💤 AFK с ' + esc(pp.afk_since) : '—')}</td>
  </tr>`).join('');
  const histRows = (hist || []).slice(-12).reverse()
    .map((e) => `<tr><td class="muted">${fmt(e.at)}</td><td>${esc(e.event || e.type || '')}</td><td>${e.static ? '№ ' + esc(e.static) : ''}</td><td>${esc(e.note || '')}</td></tr>`).join('');

  let actions = '';
  const canManage = acc.rank >= LEVELS.deputy;
  const canHr = acc.rank >= LEVELS.hr;
  if (canHr) {
    const passOpts = passports.map((pp) => `<option value="${esc(pp.static)}">${esc(pp.name)} — № ${esc(pp.static)} (${esc(roleName(client, pp.role_id))})</option>`).join('');
    const blocks = [];
    if (canManage) {
      blocks.push(`<form method="POST" action="/u/rank" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Ранг паспорта</h3>
        <label>Паспорт<select name="static">${passOpts}</select></label>
        <label>Действие<select name="dir"><option value="up">Повысить</option><option value="down">Понизить</option></select></label>
        <button class="btn sm" type="submit">Применить</button></form>`);
      blocks.push(`<form method="POST" action="/u/rename" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Переименовать паспорт</h3>
        <label>Паспорт<select name="static">${passOpts}</select></label>
        <label>Новое Имя Фамилия<input name="name" required maxlength="60"></label>
        <button class="btn sm" type="submit">Сохранить</button></form>`);
      blocks.push(`<form method="POST" action="/u/passport_add" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Добавить паспорт</h3>
        <label>Имя Фамилия<input name="name" required maxlength="60"></label>
        <label>№ Паспорта<input name="static" required pattern="[0-9]+" maxlength="12"></label>
        <button class="btn sm" type="submit">Добавить</button></form>`);
      if (passports.length > 1) {
        blocks.push(`<form method="POST" action="/u/passport_remove" class="form" onsubmit="return confirm('Удалить этот паспорт?')">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
          <h3>Удалить паспорт</h3>
          <label>Паспорт<select name="static">${passOpts}</select></label>
          <button class="btn sm" style="background:var(--bad)" type="submit">Удалить</button></form>`);
      }
      blocks.push(`<form method="POST" action="/u/kick" class="form" onsubmit="return confirm('Полностью уволить участника из организации?')">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Уволить из организации</h3>
        <label>Причина<input name="reason" required maxlength="200"></label>
        <button class="btn sm" style="background:var(--bad)" type="submit">Уволить</button></form>`);
      blocks.push(`<form method="POST" action="/u/freeze" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>${p.frozen ? 'Разморозить доступ к сайту' : 'Заморозить доступ к сайту'}</h3>
        ${p.frozen
          ? `<p class="mini">Сейчас заморожен${p.frozen_reason ? `: ${esc(p.frozen_reason)}` : ''}.</p><input type="hidden" name="on" value="0"><button class="btn sm" type="submit">Разморозить</button>`
          : `<label>Причина (покажется участнику)<input name="reason" maxlength="200"></label><input type="hidden" name="on" value="1"><button class="btn sm" style="background:var(--warn)" type="submit">Заморозить</button>`}
      </form>`);
    }
    const anyVac = passports.some((pp) => pp.vacation_until);
    const anyAfk = passports.some((pp) => pp.afk_since);
    const passSel = (lbl) => `<label>${lbl}<select name="static"><option value="">— все паспорта —</option>${passOpts}</select></label>`;
    blocks.push(`<form method="POST" action="/u/vacation" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <h3>Выдать отпуск</h3>
      ${passSel('Кому — паспорт или все')}
      <label>До какого числа (ДД.ММ.ГГГГ или 7d)<input name="deadline" required maxlength="20"></label>
      <label>Причина<input name="reason" maxlength="200"></label>
      <button class="btn sm" type="submit">Выдать</button></form>`);
    if (anyVac) {
      blocks.push(`<form method="POST" action="/u/vacation_revoke" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Снять отпуск</h3>
        ${passSel('С кого — паспорт или все')}
        <button class="btn sm" type="submit">Снять</button></form>`);
    }
    blocks.push(`<form method="POST" action="/u/afk" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <h3>Отметить AFK</h3>
      ${passSel('Кому — паспорт или все')}
      <label>Дата начала (ДД.ММ.ГГГГ)<input name="date" required maxlength="20"></label>
      <label>Причина<input name="reason" maxlength="200"></label>
      <button class="btn sm" type="submit">Отметить</button></form>`);
    if (anyAfk) {
      blocks.push(`<form method="POST" action="/u/afk_clear" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Снять AFK</h3>
        ${passSel('С кого — паспорт или все')}
        <button class="btn sm" type="submit">Снять</button></form>`);
    }
    blocks.push(`<form method="POST" action="/u/contract" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <h3>Записать контракт</h3>
      <label>Паспорт (необязательно)<select name="static"><option value="">— общий —</option>${passOpts}</select></label>
      <label>Ссылка на скриншот<input name="link" required maxlength="300"></label>
      <label>Итог<select name="status"><option value="fulfilled">Выполнен</option><option value="unfulfilled">Не выполнен</option></select></label>
      <button class="btn sm" type="submit">Записать</button></form>`);
    actions = `<div class="card"><h2>Действия</h2><div class="actions">${blocks.join('')}</div></div>`;
  }

  const nickRows = nicks.map((n) => `<tr><td class="muted">${fmt(n.at)}</td><td>${esc(n.old_nick || '—')}</td><td>${esc(n.new_nick || '—')}</td><td class="muted">${n.changed_by && n.changed_by !== 'unknown' ? personLink(client, n.changed_by) : '—'}</td></tr>`).join('');
  const chRows = contractHist.map((c) => `<tr>
    <td class="muted">${fmt(c.submitted_at || c.reviewed_at)}</td>
    <td><span class="badge ${c.status === 'fulfilled' ? 'ok' : c.status === 'unfulfilled' ? 'bad' : 'warn'}">${esc(ruStatus(c.status))}</span></td>
    <td>${[contractProof(c.taken_message_url, 'взял'), contractProof(c.message_url, 'итог')].filter(Boolean).join(' ') || '—'}</td>
  </tr>`).join('');
  const selfOrHr = (viewer && viewer.id === targetId) || canHr;
  const aboutHidden = p.about_private && !selfOrHr;
  const contractsHidden = p.contracts_private && !selfOrHr;
  const badgesHidden = p.badges_private && !selfOrHr;
  const contractHistCard = contractsHidden ? '' : `<div class="card"><h2>История контрактов (${contractHist.length})</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Итог</th><th>Пруф</th></tr>${chRows || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
  const aboutCard = (p.about && !aboutHidden) ? `<div class="card"><h2>Обо мне</h2>${mdToHtml(String(p.about).slice(0, 1000))}</div>` : '';
  const weekContractsCard = contractsHidden
    ? `<div class="card"><h2>Контракты</h2><span class="muted">Участник скрыл контракты.</span> · Приглашений подтверждено: <b>${invRow ? invRow.c : 0}</b></div>`
    : `<div class="card"><h2>Контракты за ${esc(contracts.formatWeekLabel(range))}</h2>
    <span class="badge ok">✅ ${week.fulfilled.length}</span> <span class="badge bad">❌ ${week.unfulfilled.length}</span>
    &nbsp;·&nbsp; Приглашений подтверждено: <b>${invRow ? invRow.c : 0}</b>
    <div class="mini" style="margin-top:8px">Контракты по неделям (12 нед.): ${sparkline(sparkWeeks)} <b>${sparkWeeks.reduce((a, b) => a + b, 0)}</b></div>
  </div>`;

  // Благодарности
  const canThank = viewer && viewer.id !== targetId && (acc.rank >= LEVELS.member) && !bl.length;
  const thanksCard = `<div class="card"><h2>Благодарности${thanksCnt ? ` · ${thanksCnt}` : ''}</h2>
    ${canThank ? `<form method="POST" action="/u/thank" class="bar" style="margin-bottom:8px">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <input name="note" placeholder="за что (необязательно)" maxlength="200" style="flex:1"><button class="btn sm" type="submit">🙏 Поблагодарить</button></form>` : ''}
    ${thanksRows.length ? thanksRows.map((th) => `<div class="mini" style="border-left:2px solid var(--line);padding-left:8px;margin:5px 0">${personLink(client, th.from_id)} · ${fmt(th.created_at)}${th.note ? `<br>${esc(th.note)}` : ''}</div>`).join('') : '<span class="mini">пока нет</span>'}
  </div>`;

  // Гостевая книга
  const gbRows = await db.all('SELECT id, author_id, text, created_at FROM guestbook WHERE profile_id = ? ORDER BY id DESC LIMIT 50', [targetId]).catch(() => []);
  const canGb = viewer && (acc.rank >= LEVELS.member) && !bl.length;
  const gbCanDel = (authorId) => viewer && (viewer.id === authorId || viewer.id === targetId || acc.rank >= LEVELS.hr);
  const guestbookCard = `<div class="card"><h2>Гостевая книга${gbRows.length ? ` · ${gbRows.length}` : ''}</h2>
    ${canGb ? `<form method="POST" action="/u/guestbook_add" class="bar" style="margin-bottom:8px">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <input name="text" placeholder="оставить запись…" maxlength="500" required style="flex:1"><button class="btn sm" type="submit">Написать</button></form>` : ''}
    ${gbRows.length ? gbRows.map((gr) => `<div class="mini" style="border-left:2px solid var(--line);padding-left:8px;margin:6px 0">
      <b>${personLink(client, gr.author_id)}</b> · ${fmt(gr.created_at)}
      ${gbCanDel(gr.author_id) ? `<form method="POST" action="/u/guestbook_del" style="display:inline">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}"><input type="hidden" name="id" value="${gr.id}"><button class="btn ghost sm" type="submit" style="padding:0 6px">✕</button></form>` : ''}
      <br>${esc(gr.text)}</div>`).join('') : '<span class="mini">пока пусто</span>'}
  </div>`;

  // Лента активности: контракты + бейджи + благодарности, единый список по дате
  const feed = [];
  for (const c of contractHist.slice(0, 30)) feed.push({ at: c.submitted_at || c.reviewed_at, txt: c.status === 'fulfilled' ? '✅ контракт выполнен' : c.status === 'unfulfilled' ? '❌ контракт не выполнен' : '📄 контракт на проверке' });
  if (!badgesHidden) for (const b of badgeAwards) feed.push({ at: b.awarded_at, txt: `🏅 бейдж «${esc((badges.LABELS && badges.LABELS[b.badge_key]) || b.badge_key)}»` });
  for (const th of thanksRows) feed.push({ at: th.created_at, txt: `🙏 благодарность от ${nickOf(client, th.from_id) || 'участника'}` });
  feed.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const activityCard = (contractsHidden && !selfOrHr)
    ? ''
    : `<div class="card"><h2>Лента активности</h2>
      ${feed.slice(0, 20).map((f) => `<div class="mini" style="margin:4px 0"><span class="muted">${fmt(f.at)}</span> — ${f.txt}</div>`).join('') || '<span class="mini">пусто</span>'}
    </div>`;

  const promoRows = promos.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${esc(r.action)}</td><td>${renderMentions(client, esc((r.details || '').slice(0, 200)))}</td></tr>`).join('');
  const invitedByLine = invitedByRow
    ? `<div class="card"><h2>Пригласил</h2>${personLink(client, invitedByRow.inviter_discord_id)} · ${fmt(invitedByRow.joined_at)}</div>`
    : '';

  let notesCard = '';
  let extraStaffCards = '';
  if (canHr) {
    const cmdCard = await personCommandsCard(client, targetId).catch(() => '');
    const siteActs = await db.all("SELECT action, details, at FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT 15", [targetId]).catch(() => []);
    const siteCard = `<div class="card"><h2>Действия на сайте (последние 15)</h2>
      <div class="tablewrap"><table><tr><th>Когда</th><th>Действие</th><th>Детали</th></tr>
        ${siteActs.map((a) => `<tr><td class="muted">${fmt(a.at)}</td><td>${esc(a.action || '')}</td><td class="mini">${renderMentions(client, esc((a.details || '').slice(0, 160)))}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
      </table></div>
      <a class="mini" href="/audit?who=${esc(targetId)}">весь аудит по этому человеку →</a></div>`;
    extraStaffCards = cmdCard + siteCard;
    const notes = await db.all('SELECT * FROM staff_notes WHERE target_id = ? ORDER BY id DESC LIMIT 50', [targetId]).catch(() => []);
    notesCard = `<div class="card"><h2>Заметки руководства (только для HR+)</h2>
      ${notes.map((n) => `<div class="mini" style="border-left:2px solid var(--line);padding-left:8px;margin:6px 0">
        <b>${esc(n.author_name || n.author_id)}</b> · ${fmt(n.at)}
        <form method="POST" action="/u/note_del" style="display:inline">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}"><input type="hidden" name="id" value="${n.id}"><button class="btn ghost sm" type="submit" style="padding:0 6px">✕</button></form>
        <br>${esc(n.text)}</div>`).join('') || '<span class="mini">пусто</span>'}
      <form method="POST" action="/u/note_add" class="bar" style="margin-top:8px">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}"><input name="text" placeholder="новая заметка" maxlength="1000" style="flex:1"><button class="btn ghost sm" type="submit">Добавить</button></form>
    </div>`;
  }

  return `
  <div class="phead"><img class="avatar" width="72" height="72" src="${esc(av)}" alt=""><div>
    <h1>${onlineDot(client, targetId)}${esc(ident ? ident.name + ' | ' + ident.static : p.name)}</h1>
    <div class="muted">Discord: ${esc(p.discord_tag || targetId)} · ID ${esc(targetId)} · вступил ${fmt(p.joined_at)}</div>
  </div></div>
  ${blBox}
  ${aboutCard}
  ${thanksCard}
  ${guestbookCard}
  ${activityCard}
  <div class="card"><h2>Роли на сервере</h2>${roleTags}</div>
  <div class="card"><h2>Паспорта (${passports.length})</h2>
    <div class="tablewrap"><table><tr><th>Имя Фамилия</th><th>Паспорт</th><th>Ранг</th><th>Статус</th></tr>${passRows || '<tr><td colspan="4">—</td></tr>'}</table></div>
  </div>
  ${weekContractsCard}
  ${badgesHidden ? `<div class="card"><h2>Достижения</h2><span class="muted">Участник скрыл достижения.</span></div>` : badgesCard(bs, p.pinned_badges)}
  <div class="card"><h2>Карточка для Discord</h2>
    <pre id="mcard">${esc((ident ? ident.name + ' | ' + ident.static : p.name) + '\nРанг: ' + roleName(client, (ident && ident.roleId) || p.role_id) + '\nDiscord: <@' + targetId + '>\nКонтракты (всего): ' + bs.fulfilled + '\nЗа неделю: +' + week.fulfilled.length + ' / -' + week.unfulfilled.length + '\nПриглашений: ' + (invRow ? invRow.c : 0) + '\nВступил: ' + fmt(p.joined_at))}</pre>
    <button class="btn sm" type="button" onclick="navigator.clipboard.writeText(document.getElementById('mcard').textContent).then(()=>{this.textContent='Скопировано ✓'})">Скопировать</button>
  </div>
  ${invitedByLine}
  ${notesCard}
  ${extraStaffCards}
  ${actions}
  ${contractHistCard}
  <div class="card"><h2>История паспортов (вступления / увольнения)</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Событие</th><th>Паспорт</th><th>Заметка</th></tr>${histRows || '<tr><td colspan="4">—</td></tr>'}</table></div>
  </div>
  <div class="card"><h2>Повышения / понижения</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Действие</th><th>Детали</th></tr>${promoRows || '<tr><td colspan="3">—</td></tr>'}</table></div>
  </div>
  <div class="card"><h2>История ников</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Было</th><th>Стало</th><th>Кто</th></tr>${nickRows || '<tr><td colspan="4">—</td></tr>'}</table></div>
  </div>
  <p><a href="/people">← к списку участников</a></p>`;
}

// ---------- Диаграммы (inline SVG/CSS, без библиотек) ----------
function barChart(items) {
  const max = Math.max(1, ...items.map((i) => Number(i.value) || 0));
  const cols = items.map((i) => {
    const pct = Math.round(((Number(i.value) || 0) / max) * 100);
    return `<div class="col"><div class="val">${esc(i.value)}</div><div class="track"><i class="bar2" style="height:${pct}%"></i></div><div class="cap">${esc(i.label)}</div></div>`;
  }).join('');
  return `<div class="chart">${cols}</div>`;
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, cols) {
  const head = cols.map((c) => csvCell(c.label)).join(';');
  const body = rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(';')).join('\n');
  return String.fromCharCode(0xFEFF) + head + '\n' + body;
}

// ---------- Минимальный ZIP-архиватор (метод STORE, без зависимостей) ----------
let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 14);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, eocd]);
}

// ---------- Дашборд / аналитика (HR+) ----------
const _dashCache = new Map(); // days -> { at, html }
async function dashboardBody(client, periodDays) {
  const dKey = String(periodDays || '30');
  const hit = _dashCache.get(dKey);
  if (hit && Date.now() - hit.at < 90000) return hit.html;
  const html = await dashboardBodyBuild(client, periodDays);
  _dashCache.set(dKey, { at: Date.now(), html });
  return html;
}
async function dashboardBodyBuild(client, periodDays) {
  const c = (sql, p = []) => db.get(sql, p).then((r) => (r ? r.c : 0));
  const dNum = parseInt(periodDays, 10);
  const days = Number.isFinite(dNum) && dNum >= 1 && dNum <= 366 ? dNum : 30;
  const since30 = new Date(Date.now() - days * 864e5).toISOString();
  const periodBar = `<div class="bar" style="flex-wrap:wrap"><span class="mini">Период:</span>
    ${[7, 30, 90, 180].map((d) => `<a class="btn ${d === days ? '' : 'ghost '}sm" href="/dashboard?days=${d}">${d} дн.</a>`).join('')}
    <form method="GET" action="/dashboard" style="display:inline-flex;gap:4px"><input name="days" type="number" min="1" max="366" value="${days}" style="width:70px"><button class="btn ghost sm" type="submit">свой</button></form>
  </div>`;

  // Удовлетворённость тикетами за период (#40)
  const tr = await db.all("SELECT rating FROM tickets WHERE rating IS NOT NULL AND rated_at >= ?", [since30]).catch(() => []);
  const tUp = tr.filter((x) => x.rating).length;
  const satCard = `<div class="card"><h2>Оценки закрытых тикетов за ${days} дн.</h2>
    ${tr.length ? `<div class="grid"><div class="tile"><div class="n">👍 ${tUp}</div><div class="l">помогло</div></div>
      <div class="tile"><div class="n">👎 ${tr.length - tUp}</div><div class="l">не помогло</div></div>
      <div class="tile"><div class="n">${Math.round((tUp / tr.length) * 100)}%</div><div class="l">довольны</div></div></div>`
      : '<span class="muted">За период оценок не было.</span>'}</div>`;

  const apps = await db.all('SELECT status, created_at, reviewed_at FROM applications WHERE created_at >= ?', [since30]);
  const total = apps.length;
  const accepted = apps.filter((a) => a.status === 'accepted').length;
  const rejected = apps.filter((a) => a.status === 'rejected').length;
  const pending = apps.filter((a) => a.status === 'pending').length;
  const stayed = await c("SELECT COUNT(*) c FROM acceptances WHERE joined_at >= ? AND status='confirmed'", [since30]);

  const reviewed = apps.filter((a) => a.reviewed_at && a.created_at);
  const avgH = reviewed.length
    ? Math.round(reviewed.reduce((s, a) => s + (new Date(a.reviewed_at) - new Date(a.created_at)), 0) / reviewed.length / 3600000)
    : 0;

  // по неделям: контракты за 6 недель — одним запросом
  const weeks = [];
  const wkR = [];
  for (let w = 5; w >= 0; w--) { const r = contracts.getWeekRange(w); wkR.push(r); weeks.push({ label: contracts.formatWeekLabel(r).replace(/\s*—.*/, ''), value: 0, _s: r.start.getTime(), _e: r.end.getTime() }); }
  const wkRows = await db.all("SELECT submitted_at FROM contracts WHERE status='fulfilled' AND submitted_at >= ?", [new Date(wkR[0].start).toISOString()]).catch(() => []);
  for (const row of wkRows) {
    const t = new Date(row.submitted_at).getTime();
    for (const wk of weeks) { if (t >= wk._s && t <= wk._e) { wk.value++; break; } }
  }

  const onVac = await c('SELECT COUNT(*) c FROM participants WHERE vacation_until IS NOT NULL') + await c('SELECT COUNT(DISTINCT discord_id) c FROM extra_passports WHERE vacation_until IS NOT NULL');
  const onAfk = await c('SELECT COUNT(*) c FROM participants WHERE afk_since IS NOT NULL');
  const tile = (n, l) => `<div class="tile"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;

  // В зоне риска: на прошлой неделе было заметно контрактов, на этой — спад до 0/1.
  const norm = config.WEEKLY_PROMOTION_CONTRACT_THRESHOLD || 3;
  const rThis = contracts.getWeekRange(0);
  const rPrev = contracts.getWeekRange(1);
  const cntThis = await db.all("SELECT discord_id, COUNT(*) c FROM contracts WHERE status='fulfilled' AND submitted_at BETWEEN ? AND ? GROUP BY discord_id", [rThis.start.toISOString(), rThis.end.toISOString()]).catch(() => []);
  const cntPrev = await db.all("SELECT discord_id, COUNT(*) c FROM contracts WHERE status='fulfilled' AND submitted_at BETWEEN ? AND ? GROUP BY discord_id", [rPrev.start.toISOString(), rPrev.end.toISOString()]).catch(() => []);
  const mapThis = new Map(cntThis.map((r) => [r.discord_id, r.c]));
  const onLeave = new Set((await db.all("SELECT discord_id FROM participants WHERE vacation_until IS NOT NULL OR afk_since IS NOT NULL").catch(() => [])).map((r) => r.discord_id));
  const atRisk = cntPrev
    .filter((r) => r.c >= norm && (mapThis.get(r.discord_id) || 0) <= 1 && !onLeave.has(r.discord_id))
    .map((r) => ({ id: r.discord_id, prev: r.c, now: mapThis.get(r.discord_id) || 0 }))
    .sort((a, b) => (b.prev - b.now) - (a.prev - a.now))
    .slice(0, 12);
  const riskCard = `<div class="card"><h2>В зоне риска — падение активности (${atRisk.length})</h2>
    ${atRisk.length
      ? `<div class="tablewrap"><table><tr><th>Участник</th><th>Прошлая нед.</th><th>Эта нед.</th></tr>
        ${atRisk.map((x) => `<tr><td>${personLink(client, x.id)}</td><td>${x.prev}</td><td style="color:var(--bad);font-weight:700">${x.now}</td></tr>`).join('')}
      </table></div>`
      : '<span class="muted">Резких спадов нет.</span>'}</div>`;

  // Сравнение недель: эта vs прошлая
  const r0 = contracts.getWeekRange(0); const r1 = contracts.getWeekRange(1);
  const cmp = async (a, b) => ({
    contracts: await c("SELECT COUNT(*) c FROM contracts WHERE status='fulfilled' AND submitted_at BETWEEN ? AND ?", [a, b]),
    apps: await c('SELECT COUNT(*) c FROM applications WHERE created_at BETWEEN ? AND ?', [a, b]),
    invites: await c("SELECT COUNT(*) c FROM invitations WHERE joined_at BETWEEN ? AND ? AND status='confirmed'", [a, b]),
  });
  const cw = await cmp(r0.start.toISOString(), r0.end.toISOString());
  const lw = await cmp(r1.start.toISOString(), r1.end.toISOString());
  const delta = (n, o) => { const d = n - o; return d === 0 ? '' : ` <span style="color:var(--${d > 0 ? 'ok' : 'bad'})">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`; };

  // ── Retention: доля принятых, кто ещё в организации спустя 1/2/4 недели
  const accAll = await db.all("SELECT applicant_discord_id, joined_at FROM acceptances WHERE joined_at IS NOT NULL").catch(() => []);
  const partSet = new Set((await db.all('SELECT discord_id FROM participants').catch(() => [])).map((r) => r.discord_id));
  const retention = (wk) => {
    const cutoff = Date.now() - wk * 7 * 864e5;
    const cohort = accAll.filter((a) => new Date(a.joined_at).getTime() <= cutoff);
    if (!cohort.length) return null;
    const stayed = cohort.filter((a) => partSet.has(a.applicant_discord_id)).length;
    return { n: cohort.length, stayed, pct: Math.round((stayed / cohort.length) * 100) };
  };
  const retCard = (() => {
    const cells = [1, 2, 4].map((w) => {
      const r = retention(w);
      return `<div class="tile"><div class="n">${r ? r.pct + '%' : '—'}</div><div class="l">спустя ${w} нед.${r ? ` (${r.stayed}/${r.n})` : ''}</div></div>`;
    }).join('');
    // Линия по когортам: для каждой недели вступления за последние 10 недель — % оставшихся
    const coh = [];
    for (let w = 10; w >= 1; w--) {
      const rr = contracts.getWeekRange(w);
      const cohort = accAll.filter((a) => { const t = new Date(a.joined_at).getTime(); return t >= rr.start.getTime() && t <= rr.end.getTime(); });
      const stayed = cohort.filter((a) => partSet.has(a.applicant_discord_id)).length;
      coh.push({ label: rr.start.toISOString().slice(0, 10), value: cohort.length ? Math.round((stayed / cohort.length) * 100) : null, n: cohort.length });
    }
    return `<div class="card"><h2>Удержание принятых (retention)</h2><div class="grid">${cells}</div>
      <h3 style="margin-top:12px;font-size:14px">По когортам вступления (10 недель)</h3>
      ${lineChart(coh)}
      <p class="mini">Точка = неделя, когда участники были приняты; значение = сколько из них ещё в организации.</p></div>`;
  })();

  // ── Тепловая карта: выполненные контракты по дню недели × часу (МСК), 60 дней
  const chAll = await db.all("SELECT submitted_at FROM contracts WHERE status='fulfilled' AND submitted_at >= ?", [new Date(Date.now() - 60 * 864e5).toISOString()]).catch(() => []);
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of chAll) {
    if (!r.submitted_at) continue;
    const d = new Date(new Date(r.submitted_at).getTime() + 3 * 3600000);
    grid[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++;
  }
  const maxCell = Math.max(1, ...grid.flat());
  const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const heatHtml = `<div class="card"><h2>Когда выполняют контракты (60 дней, МСК)</h2>
    <div style="overflow-x:auto"><div class="heat" style="min-width:640px">
      <div class="hl"></div>${Array.from({ length: 24 }, (_, h) => `<div class="hl" style="text-align:center">${h % 3 === 0 ? h : ''}</div>`).join('')}
      ${grid.map((row, di) => `<div class="hl">${WD[di]}</div>${row.map((v) => `<div class="hc" title="${v}" style="opacity:${v ? (0.15 + 0.85 * v / maxCell).toFixed(2) : 0.06}"></div>`).join('')}`).join('')}
    </div></div>
    <p class="mini">Чем ярче — тем больше выполненных контрактов в этот час.</p></div>`;

  return `
  <div class="bar" style="justify-content:space-between;flex-wrap:wrap">
    <h1 style="margin:0">Дашборд</h1>
    <span class="bar" style="margin:0">
      <a class="btn ghost sm" href="/export/dashboard.html?days=${days}">💾 Скачать (HTML)</a>
      <button class="btn ghost sm" type="button" onclick="fcDashPng(this)">🖼️ Картинкой (PNG)</button>
      <button class="btn ghost sm" type="button" onclick="window.print()">🖨️ Печать / PDF</button>
    </span>
  </div>
  ${periodBar}
  <div class="tabs">
    <a href="/leaderboards">Лидерборды</a><a href="/calendar">Календарь отпусков</a><a href="/search">Поиск везде</a><a href="/commands">Команды</a><a href="/audit">Аудит</a><a href="/tools">Экспорт и обслуживание</a><a href="/health">Здоровье системы</a><a href="/panel">Панель</a>
  </div>
  <script>
  function fcDashPng(btn){
    var node=document.querySelector('.wrap'); if(!node)return;
    var old=btn.textContent; btn.textContent='рендерю…'; btn.disabled=true;
    try{
      var rect=node.getBoundingClientRect(), w=Math.ceil(rect.width), h=Math.ceil(node.scrollHeight);
      var css=''; for(var i=0;i<document.styleSheets.length;i++){try{var rl=document.styleSheets[i].cssRules;for(var j=0;j<rl.length;j++)css+=rl[j].cssText+'\\n';}catch(e){}}
      var clone=node.cloneNode(true);
      clone.querySelectorAll('button,form,.tabs,script').forEach(function(e){e.remove()});
      var bg=getComputedStyle(document.body).backgroundColor||'#0f1013';
      clone.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
      clone.style.width=w+'px'; clone.style.background=bg; clone.style.padding='8px';
      var html=new XMLSerializer().serializeToString(clone);
      var cssX=css.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><style>'+cssX+'</style><foreignObject width="100%" height="100%">'+html+'</foreignObject></svg>';
      var img=new Image();
      img.onload=function(){
        var c=document.createElement('canvas'); c.width=w*2; c.height=h*2;
        var ctx=c.getContext('2d'); ctx.scale(2,2); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
        ctx.drawImage(img,0,0);
        c.toBlob(function(b){
          if(!b){btn.textContent='не вышло — используйте HTML';setTimeout(function(){btn.textContent=old;btn.disabled=false},2500);return;}
          var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='dashboard-'+new Date().toISOString().slice(0,10)+'.png'; a.click();
          setTimeout(function(){URL.revokeObjectURL(a.href)},4000);
          btn.textContent=old; btn.disabled=false;
        },'image/png');
      };
      img.onerror=function(){btn.textContent='не вышло — используйте HTML';setTimeout(function(){btn.textContent=old;btn.disabled=false},2500);};
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    }catch(e){btn.textContent='не вышло — используйте HTML';setTimeout(function(){btn.textContent=old;btn.disabled=false},2500);}
  }
  </script>
  <div class="card"><h2>Воронка найма за ${days} дн.</h2>
    <div class="grid">${tile(total, 'заявок')}${tile(accepted, 'принято')}${tile(rejected, 'отказано')}${tile(pending, 'в очереди')}${tile(stayed, 'досидело 3+ дня')}</div>
    ${barChart([{ label: 'подано', value: total }, { label: 'принято', value: accepted }, { label: 'отказ', value: rejected }, { label: '3+ дня', value: stayed }])}
  </div>
  <div class="card"><h2>Скорость рассмотрения заявок</h2>
    <p class="mini">Среднее время до решения за ${days} дн.: <b>${avgH} ч</b> · рассмотрено ${reviewed.length} из ${total}</p>
  </div>
  <div class="card"><h2>Выполненные контракты по неделям</h2>${barChart(weeks)}
    <p class="mini" style="margin-top:6px"><a href="/export/chart.csv?type=weekly_contracts">⬇ данные графика (CSV)</a></p></div>
  <div class="card"><h2>Эта неделя vs прошлая</h2><div class="grid">
    ${tile(`${cw.contracts}${delta(cw.contracts, lw.contracts)}`, `контракты (было ${lw.contracts})`)}
    ${tile(`${cw.apps}${delta(cw.apps, lw.apps)}`, `заявки (было ${lw.apps})`)}
    ${tile(`${cw.invites}${delta(cw.invites, lw.invites)}`, `приглашения (было ${lw.invites})`)}
  </div></div>
  <div class="card"><h2>Статусы сейчас</h2>
    <div class="grid">${tile(onVac, 'в отпуске')}${tile(onAfk, 'AFK')}</div>
  </div>
  ${retCard}
  ${riskCard}
  ${satCard}
  ${heatHtml}
  ${await (async () => {
    // Статистика HR по людям за 30 дней
    const rev = await db.all("SELECT accepted_by, rejected_by, status, created_at, reviewed_at FROM applications WHERE reviewed_at >= ?", [since30]).catch(() => []);
    const byHr = new Map();
    for (const a of rev) {
      const who = a.accepted_by || a.rejected_by;
      if (!who) continue;
      if (!byHr.has(who)) byHr.set(who, { acc: 0, rej: 0, sumH: 0, n: 0 });
      const o = byHr.get(who);
      if (a.status === 'accepted') o.acc++; else if (a.status === 'rejected') o.rej++;
      if (a.reviewed_at && a.created_at) { o.sumH += (new Date(a.reviewed_at) - new Date(a.created_at)) / 3600000; o.n++; }
    }
    const hrRows = [...byHr.entries()].sort((x, y) => (y[1].acc + y[1].rej) - (x[1].acc + x[1].rej))
      .map(([w, o]) => `<tr><td>${personLink(client, w)}</td><td>${o.acc}</td><td>${o.rej}</td><td>${o.n ? Math.round(o.sumH / o.n) + ' ч' : '—'}</td></tr>`).join('');

    // ── Баланс нагрузки HR: заявки + очереди + тикеты за период
    const load = new Map();
    const bump = (id, k, v = 1) => { if (!id) return; if (!load.has(id)) load.set(id, { apps: 0, queues: 0, tickets: 0, contracts: 0 }); load.get(id)[k] += v; };
    for (const a of rev) bump(a.accepted_by || a.rejected_by, 'apps');
    for (const [tbl] of [['kicks'], ['vacations'], ['hr_applications'], ['data_change_requests'], ['passport_requests']]) {
      const qq = await db.all(`SELECT assigned_to FROM ${tbl} WHERE reviewed_at >= ? AND assigned_to IS NOT NULL`, [since30]).catch(() => []);
      for (const r of qq) bump(r.assigned_to, 'queues');
    }
    const tk = await db.all("SELECT closed_by FROM tickets WHERE status='archived' AND closed_at >= ? AND closed_by IS NOT NULL", [since30]).catch(() => []);
    for (const r of tk) bump(r.closed_by, 'tickets');
    const cc = await db.all("SELECT reviewed_by FROM contracts WHERE reviewed_at >= ? AND reviewed_by IS NOT NULL", [since30]).catch(() => []);
    for (const r of cc) bump(r.reviewed_by, 'contracts');
    const loadRows = [...load.entries()]
      .map(([id, o]) => ({ id, ...o, total: o.apps + o.queues + o.tickets + o.contracts }))
      .sort((x, y) => y.total - x.total);
    const loadTotal = loadRows.reduce((s, r) => s + r.total, 0) || 1;
    const balanceCard = `<div class="card"><h2>Баланс нагрузки HR за ${days} дн.</h2>
      <div class="tablewrap"><table>
        <tr><th>Сотрудник</th><th>Заявки</th><th>Очереди</th><th>Тикеты</th><th>Контракты</th><th>Всего</th><th>Доля</th></tr>
        ${loadRows.map((r) => `<tr><td>${personLink(client, r.id)}</td><td>${r.apps}</td><td>${r.queues}</td><td>${r.tickets}</td><td>${r.contracts}</td><td><b>${r.total}</b></td>
          <td><div class="progress" style="min-width:90px"><i style="width:${Math.round((r.total / loadTotal) * 100)}%"></i></div> ${Math.round((r.total / loadTotal) * 100)}%</td></tr>`).join('') || '<tr><td colspan="7">—</td></tr>'}
      </table></div>
      <p class="mini">Учтено: решения по заявкам, взятые в работу очереди, закрытые тикеты, проверенные контракты.</p></div>`;
    // Статистика отпусков за 30 дней
    const vac = await db.all("SELECT status, until, created_at FROM vacations WHERE created_at >= ?", [since30]).catch(() => []);
    const vAcc = vac.filter((v) => v.status === 'accepted');
    const vRej = vac.filter((v) => v.status === 'rejected').length;
    const avgDays = vAcc.length ? Math.round(vAcc.reduce((s, v) => s + Math.max(0, (new Date(v.until) - new Date(v.created_at)) / 864e5), 0) / vAcc.length) : 0;
    return `<div class="card"><h2>HR за ${days} дн. (по людям)</h2>
      <div class="tablewrap"><table><tr><th>Сотрудник</th><th>Принял</th><th>Отклонил</th><th>Ср. время</th></tr>${hrRows || '<tr><td colspan="4">—</td></tr>'}</table></div></div>
    ${balanceCard}
    <div class="card"><h2>Отпуска за ${days} дн.</h2><div class="grid">
      ${tile(vac.length, 'заявок')}${tile(vAcc.length, 'одобрено')}${tile(vRej, 'отклонено')}${tile(avgDays + ' дн.', 'средняя длина')}${tile(onVac, 'в отпуске сейчас')}
    </div></div>`;
  })()}
  `;
}

async function leaderboardsBody(client, viewerId) {
  const range = contracts.getWeekRange(0);
  const cAll = await contracts.getAllTimeLeaderboard();
  const cWeek = await contracts.getWeekLeaderboard(range);
  const iAll = await invitations.getAllTimeLeaderboard();
  const iWeek = await invitations.getWeekLeaderboard(range);
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const wr = await giveaways.getEndedWinnersSince(since);
  const wc = new Map();
  for (const r of wr) for (const w of (r.winners || '').split(',').filter(Boolean)) wc.set(w, (wc.get(w) || 0) + 1);
  const gwTop = [...wc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  // Место зрителя в полном списке (не только в топ-20) + плашка.
  const myRank = (arr, key) => {
    const idx = arr.findIndex((r) => r[key] === viewerId);
    return idx < 0 ? null : { pos: idx + 1, total: arr.length };
  };
  const meLine = (mr, unit) => mr
    ? `<p class="mini" style="margin-top:6px">Ты — <b>#${mr.pos}</b> из ${mr.total} ${unit}</p>`
    : `<p class="mini" style="margin-top:6px">Тебя пока нет в этом списке</p>`;
  const rowCls = (id) => (id && id === viewerId ? ' style="background:color-mix(in srgb,var(--accent) 14%,transparent)"' : '');

  const ctab = (arr) => arr.slice(0, 20).map((r, i) => `<tr${rowCls(r.discord_id)}><td>${i + 1}</td><td>${personLink(client, r.discord_id)}</td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  const itab = (arr) => arr.slice(0, 20).map((r, i) => `<tr${rowCls(r.inviter_discord_id)}><td>${i + 1}</td><td>${personLink(client, r.inviter_discord_id)}</td><td>${r.cnt}</td></tr>`).join('');
  // Топ по благодарностям за 30 дней
  const thRows = await db.all("SELECT to_id, COUNT(*) c FROM thanks WHERE created_at > ? GROUP BY to_id ORDER BY c DESC LIMIT 20", [new Date(Date.now() - 30 * 864e5).toISOString()]).catch(() => []);
  const thTab = thRows.map((r, i) => `<tr${rowCls(r.to_id)}><td>${i + 1}${i === 0 ? ' 🏅' : ''}</td><td>${personLink(client, r.to_id)}</td><td>${r.c}</td></tr>`).join('');
  return `
  <h1>Лидерборды</h1>
  <div class="card"><h2>🙏 Самые полезные — благодарности за 30 дней</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Благодарностей</th></tr>${thTab || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Контракты — неделя (${esc(contracts.formatWeekLabel(range))})</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${ctab(cWeek) || '<tr><td colspan="3">—</td></tr>'}</table></div>${meLine(myRank(cWeek, 'discord_id'), 'по контрактам за неделю')}</div>
  <div class="card"><h2>Контракты — всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${ctab(cAll) || '<tr><td colspan="3">—</td></tr>'}</table></div>${meLine(myRank(cAll, 'discord_id'), 'по контрактам за всё время')}</div>
  <div class="card"><h2>Приглашения — неделя</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Кол-во</th></tr>${itab(iWeek) || '<tr><td colspan="3">—</td></tr>'}</table></div>${meLine(myRank(iWeek, 'inviter_discord_id'), 'по приглашениям за неделю')}</div>
  <div class="card"><h2>Приглашения — всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Кол-во</th></tr>${itab(iAll) || '<tr><td colspan="3">—</td></tr>'}</table></div>${meLine(myRank(iAll, 'inviter_discord_id'), 'по приглашениям за всё время')}</div>
  <div class="card"><h2>Победители розыгрышей (180 дней)</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Побед</th></tr>${gwTop.map(([w, n], i) => `<tr${rowCls(w)}><td>${i + 1}</td><td>${personLink(client, w)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
}

async function compareBody(client, meId, otherId, periodDays) {
  const range = contracts.getWeekRange(0);
  const pd = [30, 90, 180, 365].includes(+periodDays) ? +periodDays : 90;
  const since = new Date(Date.now() - pd * 864e5).toISOString();
  const gather = async (id) => {
    const p = await db.get('SELECT name, joined_at FROM participants WHERE discord_id = ?', [id]).catch(() => null);
    const bs = await computeBadgesAndStreak(client, id);
    const week = await contracts.getUserWeekStats(id, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
    const periodC = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status = 'fulfilled' AND submitted_at >= ?", [id, since]).catch(() => null);
    const thanks = await db.get('SELECT COUNT(*) c FROM thanks WHERE to_id = ? AND created_at >= ?', [id, since]).catch(() => null);
    const tks = await db.get("SELECT COUNT(*) c FROM tickets WHERE opener_id = ? AND created_at >= ?", [id, since]).catch(() => null);
    return {
      id, name: (p && p.name) || nickOf(client, id) || ('ID ' + String(id).slice(-6)),
      inOrg: !!p,
      fulfilled: bs.fulfilled || 0, week: week.fulfilled.length,
      periodC: periodC ? periodC.c : 0, thanks: thanks ? thanks.c : 0, tickets: tks ? tks.c : 0,
      invites: bs.invConfirmed || 0, streak: bs.streak || 0,
      days: bs.days || 0, wins: bs.wins || 0, badges: (bs.badges || []).length,
    };
  };
  const me = await gather(meId);

  const people = await db.all('SELECT discord_id, name FROM participants ORDER BY name').catch(() => []);
  const opts = people.filter((r) => r.discord_id !== meId)
    .map((r) => `<option value="${esc(r.discord_id)}" ${r.discord_id === otherId ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const picker = `<div class="card"><form method="GET" action="/compare" class="form">
    <label>Сравнить меня с<select name="with">${opts}</select></label>
    <label>Период для метрик за период<select name="days">${[30, 90, 180, 365].map((d) => `<option value="${d}" ${d === pd ? 'selected' : ''}>${d} дн.</option>`).join('')}</select></label>
    <button class="btn sm" type="submit">Сравнить</button>
  </form></div>`;

  if (!otherId || !/^\d{5,25}$/.test(otherId)) return `<h1>Сравнение</h1>${picker}`;
  const ot = await gather(otherId);
  const row = (label, a, b, better = 'high') => {
    const win = a === b ? '' : ((better === 'high') === (a > b) ? 'a' : 'b');
    return `<tr><td>${esc(label)}</td>
      <td style="${win === 'a' ? 'color:var(--ok);font-weight:700' : ''}">${a}</td>
      <td style="${win === 'b' ? 'color:var(--ok);font-weight:700' : ''}">${b}</td></tr>`;
  };
  return `<h1>Сравнение</h1>${picker}
  <div class="card"><h2>${esc(me.name)} vs ${esc(ot.name)}</h2>
    <div class="tablewrap"><table>
      <tr><th>Показатель</th><th>${esc(me.name)}</th><th>${esc(ot.name)}</th></tr>
      ${row('Контракты за всё время', me.fulfilled, ot.fulfilled)}
      ${row('Контракты на этой неделе', me.week, ot.week)}
      ${row(`Контракты за ${pd} дн.`, me.periodC, ot.periodC)}
      ${row(`Благодарностей за ${pd} дн.`, me.thanks, ot.thanks)}
      ${row(`Тикетов открыто за ${pd} дн.`, me.tickets, ot.tickets, 'low')}
      ${row('Приглашений подтверждено', me.invites, ot.invites)}
      ${row('Недельный стрик', me.streak, ot.streak)}
      ${row('Дней в организации', me.days, ot.days)}
      ${row('Побед в розыгрышах', me.wins, ot.wins)}
      ${row('Бейджей открыто', me.badges, ot.badges)}
    </table></div>
    <p class="mini"><a href="/u/${esc(ot.id)}">профиль ${esc(ot.name)}</a></p>
  </div>`;
}

async function calendarBody(client, user) {
  let icalCard = '';
  if (user) {
    const tok = await getIcalToken(user.id).catch(() => null);
    if (tok) {
      const mine = `${baseUrl()}/calendar.ics?key=${tok}`;
      const all = `${baseUrl()}/calendar-all.ics?key=${tok}`;
      icalCard = `<div class="card"><h2>Подписка на календарь (.ics)</h2>
        <p class="mini">Добавьте ссылку в Google/Apple Календарь как подписку по URL. Ссылки привязаны к вам — не публикуйте их.</p>
        <label class="mini">Мои отпуска<input readonly onclick="this.select()" value="${esc(mine)}" style="width:100%;font-family:monospace;font-size:12px"></label>
        <label class="mini" style="margin-top:6px;display:block">Все отпуска организации (только HR+)<input readonly onclick="this.select()" value="${esc(all)}" style="width:100%;font-family:monospace;font-size:12px"></label>
        <div class="bar" style="margin-top:6px"><a class="btn ghost sm" href="${esc(mine)}">Скачать мои</a><a class="btn ghost sm" href="${esc(all)}">Скачать все</a>
          <form method="POST" action="/me/ical_reset" style="display:inline" onsubmit="return confirm('Сбросить ссылки?')">${csrfField(user)}<button class="btn ghost sm" type="submit">Сбросить</button></form></div>
      </div>`;
    }
  }
  const parts = await db.all('SELECT discord_id, name, static, vacation_until, afk_since FROM participants');
  const extras = await db.all('SELECT discord_id, name, static, vacation_until, afk_since FROM extra_passports');
  const all = [...parts, ...extras];
  const vac = all.filter((p) => p.vacation_until).sort((a, b) => new Date(a.vacation_until) - new Date(b.vacation_until));
  const afk = all.filter((p) => p.afk_since);
  const vrows = vac.map((p) => `<tr><td><a href="/u/${esc(p.discord_id)}">${esc(p.name)}</a></td><td>№ ${esc(p.static)}</td><td>${fmt(p.vacation_until)}</td><td class="muted">${Math.ceil((new Date(p.vacation_until) - Date.now()) / 864e5)} дн.</td></tr>`).join('');
  const arows = afk.map((p) => `<tr><td><a href="/u/${esc(p.discord_id)}">${esc(p.name)}</a></td><td>№ ${esc(p.static)}</td><td>${esc(p.afk_since)}</td></tr>`).join('');
  const sched = await db.all("SELECT prize, winners_count, start_at FROM scheduled_giveaways WHERE status='pending' ORDER BY start_at ASC").catch(() => []);
  const srows = sched.map((s) => `<tr><td>🎉 ${esc(s.prize)}</td><td>${fmt(s.start_at)}</td><td class="muted">через ${Math.max(0, Math.ceil((new Date(s.start_at) - Date.now()) / 3600000))} ч</td></tr>`).join('');
  return `
  <h1>Календарь</h1>
  ${icalCard}
  <div class="card"><h2>Предстоящие розыгрыши (${sched.length})</h2>
    <div class="tablewrap"><table><tr><th>Приз</th><th>Старт</th><th>Осталось</th></tr>${srows || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>В отпуске (${vac.length})</h2>
    <div class="tablewrap"><table><tr><th>Имя</th><th>Паспорт</th><th>До</th><th>Осталось</th></tr>${vrows || '<tr><td colspan="4">—</td></tr>'}</table></div></div>
  <div class="card"><h2>AFK (${afk.length})</h2>
    <div class="tablewrap"><table><tr><th>Имя</th><th>Паспорт</th><th>С</th></tr>${arows || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
}

async function searchBody(client, query) {
  const q = (query || '').trim();
  if (!q) {
    return `<h1>Поиск везде</h1><div class="card"><form method="GET" action="/search" class="form"><label>Запрос (имя, паспорт, Discord ID, текст)<input name="q" maxlength="80" autofocus></label><button class="btn" type="submit">Искать</button></form></div>`;
  }
  const like = `%${q}%`;
  const P = await db.all('SELECT discord_id, name, static FROM participants WHERE name LIKE ? OR static LIKE ? OR discord_id = ? OR discord_tag LIKE ? LIMIT 25', [like, like, q, like]);
  const A = await db.all('SELECT id, discord_tag, name, static, status FROM applications WHERE name LIKE ? OR static LIKE ? OR discord_id = ? OR discord_tag LIKE ? ORDER BY id DESC LIMIT 25', [like, like, q, like]);
  const B = await db.all('SELECT id, discord_id, static, reason, until FROM blacklist WHERE discord_id = ? OR static LIKE ? OR reason LIKE ? ORDER BY id DESC LIMIT 25', [q, like, like]);
  const T = await db.all('SELECT id, opener_id, subject, category, status FROM tickets WHERE subject LIKE ? OR opener_id = ? ORDER BY id DESC LIMIT 25', [like, q]);
  const AU = await db.all("SELECT at, actor_tag, action, details FROM audit_log WHERE action LIKE ? OR details LIKE ? OR actor_tag LIKE ? OR actor_id = ? ORDER BY id DESC LIMIT 25", [like, like, like, q]);
  const TH = await db.all('SELECT from_id, to_id, note, created_at FROM thanks WHERE from_id = ? OR to_id = ? OR note LIKE ? ORDER BY id DESC LIMIT 25', [q, q, like]);
  const CN = await db.all("SELECT id, discord_id, status, submitted_at, message_url FROM contracts WHERE discord_id = ? OR message_url LIKE ? ORDER BY id DESC LIMIT 25", [q, like]);
  const CW = await db.all("SELECT id, discord_id, name, static, status, submitted_at FROM codeword_submissions WHERE discord_id = ? OR name LIKE ? OR static LIKE ? OR discord_tag LIKE ? ORDER BY id DESC LIMIT 25", [q, like, like, like]).catch(() => []);
  const HR = await db.all("SELECT id, discord_id, discord_tag, status, created_at FROM hr_applications WHERE discord_id = ? OR discord_tag LIKE ? ORDER BY id DESC LIMIT 25", [q, like]).catch(() => []);
  const GB = await db.all("SELECT id, profile_id, author_id, text, created_at FROM guestbook WHERE text LIKE ? OR author_id = ? OR profile_id = ? ORDER BY id DESC LIMIT 25", [like, q, q]).catch(() => []);
  // подсветка совпадений
  const hl = (s) => {
    const e = esc(s == null ? '' : String(s));
    if (!q) return e;
    try { return e.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>'); } catch (_) { return e; }
  };
  const sec = (id, title, rowsHtml, colsN) => `<div class="card" id="s-${id}"><h2>${esc(title)}</h2><div class="tablewrap"><table>${rowsHtml || `<tr><td colspan="${colsN}">—</td></tr>`}</table></div></div>`;
  const secs = [
    ['people', 'Участники (' + P.length + ')', '<tr><th>Имя</th><th>Паспорт</th></tr>' + P.map((r) => `<tr><td><a href="/u/${esc(r.discord_id)}">${hl(r.name)}</a></td><td>№ ${hl(r.static)}</td></tr>`).join(''), 2],
    ['apps', 'Заявки (' + A.length + ')', '<tr><th>#</th><th>Имя</th><th>Паспорт</th><th>Статус</th></tr>' + A.map((r) => `<tr><td>#${r.id}</td><td>${hl(r.name || r.discord_tag)}</td><td>${hl(r.static || '—')}</td><td>${esc(ruStatus(r.status))}</td></tr>`).join(''), 4],
    ['contracts', 'Контракты (' + CN.length + ')', '<tr><th>#</th><th>Участник</th><th>Итог</th><th>Когда</th><th>Пруф</th></tr>' + CN.map((r) => `<tr><td>#${r.id}</td><td>${personLink(client, r.discord_id)}</td><td>${esc(ruStatus(r.status))}</td><td class="muted">${fmt(r.submitted_at)}</td><td>${r.message_url ? `<a href="${esc(r.message_url)}" target="_blank" rel="noopener">ссылка</a>` : '—'}</td></tr>`).join(''), 5],
    ['thanks', 'Благодарности (' + TH.length + ')', '<tr><th>От</th><th>Кому</th><th>За что</th><th>Когда</th></tr>' + TH.map((r) => `<tr><td>${personLink(client, r.from_id)}</td><td>${personLink(client, r.to_id)}</td><td>${hl(r.note || '—')}</td><td class="muted">${fmt(r.created_at)}</td></tr>`).join(''), 4],
    ['audit', 'Аудит (' + AU.length + ')', '<tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Детали</th></tr>' + AU.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${hl(r.actor_tag || '—')}</td><td>${hl(r.action || '')}</td><td class="mini">${hl((r.details || '').slice(0, 160))}</td></tr>`).join(''), 4],
    ['bl', 'Чёрный список (' + B.length + ')', '<tr><th>#</th><th>Discord ID</th><th>Паспорт</th><th>Причина</th></tr>' + B.map((r) => `<tr><td>#${r.id}</td><td>${hl(r.discord_id || '—')}</td><td>${hl(r.static || '—')}</td><td>${hl(r.reason || '—')}</td></tr>`).join(''), 4],
    ['tickets', 'Тикеты (' + T.length + ')', '<tr><th>#</th><th>Тема</th><th>Тип</th><th>Статус</th></tr>' + T.map((r) => `<tr><td><a href="/ticket/${r.id}">#${r.id}</a></td><td>${hl(r.subject || '—')}</td><td>${esc(TICKET_CAT_RU[r.category] || r.category || '—')}</td><td>${esc(ruStatus(r.status))}</td></tr>`).join(''), 4],
    ['cw', 'Кодовые слова (' + CW.length + ')', '<tr><th>#</th><th>Кто</th><th>Имя</th><th>Паспорт</th><th>Статус</th><th>Когда</th></tr>' + CW.map((r) => `<tr><td>#${r.id}</td><td>${personLink(client, r.discord_id)}</td><td>${hl(r.name || '—')}</td><td>${hl(r.static || '—')}</td><td>${esc(ruStatus(r.status))}</td><td class="muted">${fmt(r.submitted_at)}</td></tr>`).join(''), 6],
    ['hr', 'Заявки в HR (' + HR.length + ')', '<tr><th>#</th><th>Кто</th><th>Статус</th><th>Когда</th></tr>' + HR.map((r) => `<tr><td>#${r.id}</td><td>${personLink(client, r.discord_id)}</td><td>${esc(ruStatus(r.status))}</td><td class="muted">${fmt(r.created_at)}</td></tr>`).join(''), 4],
    ['gb', 'Гостевая книга (' + GB.length + ')', '<tr><th>Профиль</th><th>Автор</th><th>Текст</th><th>Когда</th></tr>' + GB.map((r) => `<tr><td><a href="/u/${esc(r.profile_id)}">профиль</a></td><td>${personLink(client, r.author_id)}</td><td>${hl((r.text || '').slice(0, 160))}</td><td class="muted">${fmt(r.created_at)}</td></tr>`).join(''), 4],
  ];
  const counts = { people: P.length, apps: A.length, contracts: CN.length, thanks: TH.length, audit: AU.length, bl: B.length, tickets: T.length, cw: CW.length, hr: HR.length, gb: GB.length };
  const jump = `<div class="bar" style="flex-wrap:wrap;gap:4px">${secs.filter(([id]) => counts[id]).map(([id, title]) => `<a class="pill" href="#s-${id}">${esc(title)}</a>`).join('') || '<span class="mini">ничего не найдено</span>'}</div>`;
  return `
  <h1>Поиск: «${esc(q)}»</h1>
  <div class="card"><form method="GET" action="/search" class="form"><label>Запрос<input id="qf" name="q" value="${esc(q)}" maxlength="80"></label>
    <div class="bar"><button class="btn" type="submit">Искать</button><button class="btn ghost sm" type="button" id="qsave">★ Сохранить запрос</button></div>
    <div id="qsaved" class="bar" style="flex-wrap:wrap;gap:4px;margin-top:6px"></div>
  </div>
  ${jump}
  ${secs.map(([id, t, rows, n]) => sec(id, t, rows, n)).join('')}
  <script>(function(){try{
    var sv=JSON.parse(localStorage.getItem('fc_saved_q')||'[]'); if(!Array.isArray(sv))sv=[];
    function render(){var box=document.getElementById('qsaved');if(!box)return;
      box.innerHTML=sv.map(function(x){return '<a class="pill" href="/search?q='+encodeURIComponent(x)+'">'+x.replace(/</g,'&lt;')+'</a>';}).join('')
        +(sv.length?' <button class="btn ghost sm" type="button" id="qclear">очистить</button>':'');
      var qc=document.getElementById('qclear'); if(qc)qc.onclick=function(){sv=[];localStorage.setItem('fc_saved_q','[]');render();};}
    var b=document.getElementById('qsave'); if(b)b.onclick=function(){var v=(document.getElementById('qf')||{}).value; if(v&&sv.indexOf(v)<0){sv.unshift(v);sv=sv.slice(0,12);localStorage.setItem('fc_saved_q',JSON.stringify(sv));render();}};
    render();
  }catch(e){}})();</script>`;
}

async function auditBody(client, sp, pageNum, user) {
  const who = (sp.get('who') || '').trim();
  const act = (sp.get('act') || '').trim();
  const showSys = sp.get('sys') === '1';
  const days = parseInt(sp.get('days') || '14', 10) || 14;
  const per = Math.min(200, Math.max(10, parseInt(sp.get('per'), 10) || PAGE_SIZE));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const cond = ['at >= ?'];
  const par = [since];
  if (who) { cond.push('(actor_id = ? OR actor_tag LIKE ?)'); par.push(who, `%${who}%`); }
  if (act) { cond.push('action LIKE ?'); par.push(`%${act}%`); }
  if (!showSys && !act) { cond.push("action NOT LIKE ?"); par.push(META_PREFIX + '%'); }
  const where = 'WHERE ' + cond.join(' AND ');
  const totalRow = await db.get(`SELECT COUNT(*) c FROM audit_log ${where}`, par);
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...par, per, pageNum * per]);
  const auditPages = Math.max(1, Math.ceil(total / per));
  const auditPager = auditPages > 1 ? `<div class="pager">${pageNum > 0 ? `<a class="btn ghost sm" href="/audit?${qs({ who, act, days, per })}&page=${pageNum - 1}">← Назад</a>` : ''}<span class="muted">стр. ${pageNum + 1} из ${auditPages}</span>${pageNum < auditPages - 1 ? `<a class="btn ghost sm" href="/audit?${qs({ who, act, days, per })}&page=${pageNum + 1}">Вперёд →</a>` : ''}</div>` : '';
  const perSel = `<span class="mini">На странице: ${[30, 60, 120, 200].map((n) => n === per ? `<b>${n}</b>` : `<a href="/audit?${qs({ who, act, days, per: n })}">${n}</a>`).join(' · ')}</span>`;
  const trs = rows.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${esc(r.actor_tag || r.actor_id || '—')}</td><td>${esc(r.action || '')}</td><td>${renderMentions(client, esc((r.details || '').slice(0, 300)))}</td></tr>`).join('');
  const qkeep = qs({ who, act, days, ...(showSys ? { sys: '1' } : {}) });
  const undoable = await db.all("SELECT * FROM undo_actions WHERE done_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 10", [new Date().toISOString()]).catch(() => []);
  const undoCard = undoable.length ? `<div class="card"><h2>Можно отменить (5 мин)</h2>
    ${undoable.map((u2) => {
      const label = u2.kind === 'rank' ? 'смена ранга'
        : u2.kind === 'dbrow' ? (() => { try { const p = JSON.parse(u2.payload || '{}'); return `правка БД: ${esc(p.table || '')} #${esc(String(p.pk || ''))} (${p.op === 'delete' ? 'удаление' : 'изменение'})`; } catch (_) { return 'правка БД'; } })()
        : u2.kind;
      const who = u2.kind === 'dbrow' ? '' : ` · ${personLink(client, u2.target_id)}`;
      return `<div class="bar"><span class="mini">${label}${who} · ${fmt(u2.created_at)}</span>
      <form method="POST" action="/undo" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${u2.id}"><button class="btn ghost sm" type="submit">Отменить</button></form></div>`;
    }).join('')}
  </div>` : '';
  return `
  <h1>Аудит</h1>
  ${undoCard}
  <div class="card"><form method="GET" action="/audit" class="form">
    <label>Кто (Discord ID или часть тега)<input name="who" value="${esc(who)}" maxlength="60"></label>
    <label>Действие содержит<input name="act" value="${esc(act)}" maxlength="60"></label>
    <label>За сколько дней<input name="days" type="number" min="1" max="365" value="${days}"></label>
    <label class="chk"><input type="checkbox" name="sys" value="1" ${showSys ? 'checked' : ''}><span>Показывать служебные (⚙ тема, страницы, правка БД и т.п.)</span></label>
    <button class="btn" type="submit">Применить</button>
    <a class="btn ghost sm" href="/audit.csv?${qkeep}">Экспорт CSV</a>
  </form>
  <div class="bar"><span class="mini">Пресеты:</span>
    <a class="btn ghost sm" href="/audit?act=Увольнение">Увольнения</a>
    <a class="btn ghost sm" href="/audit?act=Повышение">Повышения</a>
    <a class="btn ghost sm" href="/audit?act=ЧС">Изменения ЧС</a>
    <a class="btn ghost sm" href="/audit?act=Розыгрыш">Розыгрыши</a>
    <a class="btn ghost sm" href="/audit?act=сайт">Действия с сайта</a>
    <a class="btn ghost sm" href="/audit?sys=1&act=${encodeURIComponent(META_PREFIX)}">Служебные ⚙</a>
    <a class="btn ghost sm" href="/audit?who=${esc(OWNER_ID)}">Действия havirys</a>
    <a class="btn ghost sm" href="/audit?act=Отказ доступа">Отказы доступа</a>
  </div></div>
  <div class="card"><h2>Записей: ${total}</h2>
    <div class="bar" style="margin-bottom:6px">${perSel}</div>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Детали</th></tr>${trs || '<tr><td colspan="4">—</td></tr>'}</table></div>
    ${auditPager}
  </div>`;
}

async function toolsBody(client, acc, user) {
  const g = guildOf(client);
  let rolesTxt = '(бот офлайн)';
  let chansTxt = '';
  if (g) {
    rolesTxt = g.roles.cache.filter((r) => r.name !== '@everyone').sort((a, b) => b.position - a.position).map((r) => `${r.name} = ${r.id}`).join('\n');
    chansTxt = g.channels.cache.filter((ch) => ch.type === 0 || ch.type === 4).sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0)).map((ch) => `${ch.name} = ${ch.id}`).join('\n');
  }
  const isOwnerTools = acc.rank >= LEVELS.owner;
  const brRows = await db.all('SELECT * FROM badge_roles ORDER BY badge_key').catch(() => []);
  const brList = brRows.map((b) => `<tr><td>${esc(badges.LABELS[b.badge_key] || b.badge_key)}</td><td>${roleTag(client, b.role_id)}</td><td class="muted">${fmt(b.created_at)}</td></tr>`).join('');
  const badgeCard = `<div class="card"><h2>Авто-роли за бейджи</h2>
    <p class="mini">Бот сам создаёт роль, когда первый участник заработал бейдж, и разносит роли по людям (в течение часа + при старте). Отключается в config: <code>BADGE_AUTO_ROLES: false</code>.</p>
    <div class="tablewrap"><table><tr><th>Бейдж</th><th>Роль</th><th>Создана</th></tr>${brList || '<tr><td colspan="3">пока ни одной</td></tr>'}</table></div>
    ${isOwnerTools && user ? `<form method="POST" action="/tools/badge_sync" style="margin-top:10px">${csrfField(user)}<button class="btn sm" type="submit">Синхронизировать сейчас</button></form>` : ''}
  </div>`;
  return `
  <h1>Экспорт и обслуживание</h1>
  <div class="card"><h2>Скачать</h2>
    <div class="bar">
      ${isOwnerTools ? '<a class="btn sm" href="/export/db.sqlite">База данных (.sqlite)</a>' : ''}
      ${isOwnerTools ? '<a class="btn sm" href="/export/archive.zip">Весь архив (.zip)</a>' : ''}
      <a class="btn sm" href="/export/participants.csv">Участники CSV</a>
      <a class="btn sm" href="/export/audit.csv?days=90">Аудит за 90 дней CSV</a>
      <a class="btn sm" href="/export/stats.csv">Статистика за неделю CSV</a>
    </div>
  </div>
  ${badgeCard}
  ${isOwnerTools && user ? `<div class="card"><h2>Резервные копии</h2>
    <form method="POST" action="/tools/backup_now">${csrfField(user)}<button class="btn sm" type="submit">Сделать бэкап сейчас</button></form>
    <div class="tablewrap" style="margin-top:10px"><table><tr><th>Файл</th><th>Размер</th><th></th></tr>
      ${(() => { let bl = []; try { bl = backup.listBackups() || []; } catch (_) {} return bl.map((b) => `<tr><td>${esc(b.name || b.filename || b)}</td><td class="muted">${b.size ? (b.size / 1048576).toFixed(2) + ' МБ' : '—'}</td><td><a class="btn ghost sm" href="/export/backup/${encodeURIComponent(b.name || b.filename || b)}">скачать</a></td></tr>`).join('') || '<tr><td colspan="3">нет копий</td></tr>'; })()}
    </table></div>
    <h3 style="font-size:14px;margin-top:12px">Кто скачивал базу (последние 20)</h3>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Кто</th><th>Что</th></tr>
      ${(await db.all("SELECT at, actor_tag, action, details FROM audit_log WHERE action LIKE '%качивани%БД%' OR action LIKE '%рхива .zip%' OR action LIKE '%Резервн%' ORDER BY id DESC LIMIT 20").catch(() => []))
        .map((a) => `<tr><td class="muted">${fmt(a.at)}</td><td class="mini">${esc(a.actor_tag || '—')}</td><td class="mini">${esc(a.action || '')}${a.details ? ' — ' + esc(String(a.details).slice(0, 80)) : ''}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
    </table></div>
  </div>
  <div class="card"><h2>Статистика за период</h2>
    <form method="GET" action="/export/stats-period.csv" class="form">
      <label>С даты (ГГГГ-ММ-ДД)<input name="from" type="date" required></label>
      <label>По дату<input name="to" type="date" required></label>
      <button class="btn sm" type="submit">Скачать CSV</button>
    </form>
  </div>` : ''}
  <div class="card"><h2>ID ролей</h2><pre>${esc(rolesTxt)}</pre></div>
  <div class="card"><h2>ID каналов</h2><pre>${esc(chansTxt)}</pre></div>
  ${isOwnerTools && user ? `<div class="card"><h2>Загрузить базу (замена файла)</h2>
    <form method="POST" action="/panel/db/restore" class="form" onsubmit="return confirm('ЗАМЕНИТЬ рабочую базу данных содержимым из поля ниже? Это необратимо. Бот перечитает файл только после перезапуска.')">
      ${csrfField(user)}
      <label>Base64 файла .sqlite<textarea name="b64" rows="4" required></textarea></label>
      <button class="btn" style="background:var(--bad)" type="submit">Заменить базу</button>
    </form>
    <p class="mini">Только для аварийного восстановления. Резервные копии бот кладёт на диск и в канал бэкапов.</p>
  </div>` : ''}`;
}

// ---------- Панель: новые вкладки ----------
async function panelSla(client, user, pageNum = 0) {
  const slaMs = (config.REVIEW_SLA_HOURS || 24) * 3600000;
  const cutoff = new Date(Date.now() - slaMs).toISOString();
  const defs = [
    ['applications', 'Заявки на вступление'],
    ['kicks', 'Заявки на увольнение'],
    ['vacations', 'Заявки на отпуск'],
    ['passport_requests', 'Добавление паспорта'],
    ['data_change_requests', 'Изменение данных'],
    ['hr_applications', 'Заявки в HR'],
  ];
  const claimBtn = (table, id) => `<form method="POST" action="/panel/sla/claim" style="display:inline">${csrfField(user)}<input type="hidden" name="table" value="${table}"><input type="hidden" name="id" value="${id}"><button class="btn ghost sm" type="submit">Взять на себя</button></form>`;
  const blocks = [];
  let maxTotal = 0;
  for (const [table, title] of defs) {
    const tr = await db.get(`SELECT COUNT(*) c FROM ${table} WHERE status='pending'`).catch(() => null);
    const cnt = tr ? tr.c : 0;
    if (cnt > maxTotal) maxTotal = cnt;
    const rows = await db.all(`SELECT id, discord_id, discord_tag, assigned_to, created_at FROM ${table} WHERE status='pending' ORDER BY created_at ASC LIMIT ? OFFSET ?`, [PAGE_SIZE, pageNum * PAGE_SIZE]).catch(() => []);
    if (!rows.length) continue;
    const trs = rows.map((r) => {
      const ageH = Math.floor((Date.now() - new Date(r.created_at)) / 3600000);
      const stale = (r.created_at || '') < cutoff;
      return `<tr style="${stale ? 'background:rgba(255,107,107,.10)' : ''}">
        <td>#${r.id}</td>
        <td><a href="/u/${esc(r.discord_id)}">${esc(r.discord_tag || r.discord_id)}</a></td>
        <td>${ageH} ч ${stale ? '<span class="badge bad">SLA</span>' : ''}</td>
        <td>${r.assigned_to ? personLink(client, r.assigned_to) : claimBtn(table, r.id)}</td>
      </tr>`;
    }).join('');
    blocks.push(`<div class="card"><h2>${esc(title)} (${rows.length})</h2><div class="tablewrap"><table><tr><th>#</th><th>Заявитель</th><th>Возраст</th><th>Ответственный</th></tr>${trs}</table></div></div>`);
  }
  const tickets = await db.all("SELECT id, subject, assigned_to, created_at FROM tickets WHERE status='open' ORDER BY created_at ASC").catch(() => []);
  if (tickets.length) {
    const trs = tickets.map((t) => {
      const ageH = Math.floor((Date.now() - new Date(t.created_at)) / 3600000);
      const stale = (t.created_at || '') < cutoff;
      return `<tr style="${stale ? 'background:rgba(255,107,107,.10)' : ''}"><td>#${t.id}</td><td>${esc(t.subject || '—')}</td><td>${ageH} ч ${stale ? '<span class="badge bad">SLA</span>' : ''}</td><td>${t.assigned_to ? personLink(client, t.assigned_to) : claimBtn('tickets', t.id)}</td></tr>`;
    }).join('');
    blocks.push(`<div class="card"><h2>Открытые тикеты (${tickets.length})</h2><div class="tablewrap"><table><tr><th>#</th><th>Тема</th><th>Возраст</th><th>Ответственный</th></tr>${trs}</table></div></div>`);
  }
  return `<div class="card"><h2>SLA — порог ${config.REVIEW_SLA_HOURS || 24} ч</h2><p class="mini">Красным подсвечено то, что висит дольше порога без решения.</p>${pager('/panel?tab=sla', pageNum, maxTotal)}</div>${blocks.join('') || '<div class="card">Всё в пределах SLA 👍</div>'}${pager('/panel?tab=sla', pageNum, maxTotal)}`;
}

async function panelApps(client, user, pageNum = 0) {
  const totalRow = await db.get("SELECT COUNT(*) c FROM applications WHERE status='pending'");
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all("SELECT * FROM applications WHERE status='pending' ORDER BY id ASC LIMIT ? OFFSET ?", [PAGE_SIZE, pageNum * PAGE_SIZE]);
  const presetSel = await rejectPresetSelect('application');
  const cards = [];
  for (const a of rows) {
    const comments = await db.all('SELECT * FROM application_comments WHERE application_id = ? ORDER BY id ASC', [a.id]).catch(() => []);
    const thread = comments.map((c) => `<div class="mini" style="border-left:2px solid var(--line);padding-left:8px;margin:4px 0"><b>${esc(c.author_name || c.author_id)}</b> · ${fmt(c.at)}<br>${esc(c.text)}</div>`).join('');
    cards.push(`<div class="card">
    <label class="chk" style="float:right"><input type="checkbox" form="bulkReject" name="ids" value="${a.id}"><span class="mini">выбрать</span></label>
    <b>Заявка #${a.id}</b> — ${personLink(client, a.discord_id)} (${esc(a.discord_tag || '')}) ${accountAgeBadge(a.discord_id)}
    <div class="mini">${esc(a.name || '—')} · № ${esc(a.static || '—')} · LVL ${esc(a.lvl || '—')} · ${fmt(a.created_at)}</div>
    <div class="mini">Навыки: ${esc((a.skills || '—').slice(0, 300))}</div>
    <div class="mini">Пригласил: ${esc(a.invited_by || '—')}</div>
    <div style="margin:8px 0">${thread || '<span class="mini">Комментариев нет.</span>'}
      <form method="POST" action="/panel/app/comment" class="bar">${csrfField(user)}<input type="hidden" name="id" value="${a.id}"><input name="text" placeholder="комментарий" maxlength="1000" style="flex:1"><button class="btn ghost sm" type="submit">Добавить</button></form>
    </div>
    <div class="actions" style="margin-top:10px">
      <form method="POST" action="/panel/app/accept" class="form">${csrfField(user)}<input type="hidden" name="id" value="${a.id}">
        <h3>Принять</h3>
        <label>Имя Фамилия<input name="name" value="${esc(a.name || '')}" required maxlength="60"></label>
        <label>№ Паспорта<input name="static" value="${esc(a.static || '')}" required pattern="[0-9]+" maxlength="12"></label>
        <label>LVL<input name="lvl" type="number" value="${esc(a.lvl || 1)}" min="1" max="100"></label>
        <button class="btn sm" type="submit">✅ Принять и добавить</button>
      </form>
      <form method="POST" action="/panel/app/reject" class="form">${csrfField(user)}<input type="hidden" name="id" value="${a.id}">
        <h3>Отказать</h3>
        ${presetSel ? `<label>Готовая причина${presetSel}</label>` : ''}
        <label>Или свой текст<input name="reason" maxlength="300"></label>
        <button class="btn sm" style="background:var(--bad)" type="submit">❌ Отказать</button>
      </form>
    </div>
  </div>`);
  }
  const directAdd = `<div class="card"><h2>Добавить участника напрямую (без заявки)</h2>
    <p class="mini">Полный онбординг как при приёме заявки: роли, ник, канал-профиль, ЛС с правилами, запись в аудит Discord. Discord-аккаунт должен быть на сервере.</p>
    <form method="POST" action="/panel/member/add_direct" class="form" onsubmit="return confirm('Добавить участника в организацию?')">${csrfField(user)}
      <label>Discord ID<input name="discord_id" required pattern="[0-9]{5,25}" maxlength="25"></label>
      <label>Имя Фамилия<input name="name" required maxlength="60"></label>
      <label>№ Паспорта<input name="static" required pattern="[0-9]+" maxlength="12"></label>
      <label>LVL<input name="lvl" type="number" value="1" min="1" max="100"></label>
      <button class="btn" type="submit">➕ Добавить участника</button>
    </form></div>`;
  const bulkBar = rows.length > 1 ? `<div class="card"><h3 style="font-size:14px;margin:0 0 6px">Массовый отказ по выбранным</h3>
    <form method="POST" action="/panel/app/reject_bulk" id="bulkReject" class="bar" style="flex-wrap:wrap;gap:6px" onsubmit="return confirm('Отклонить все выбранные заявки?')">${csrfField(user)}
      ${presetSel ? `<label>Причина${presetSel}</label>` : ''}
      <input name="reason" placeholder="или свой текст причины" maxlength="300" style="flex:1;min-width:160px">
      <button class="btn sm" style="background:var(--bad)" type="submit">❌ Отклонить выбранные</button>
    </form></div>` : '';
  return `<div class="card"><h2>Заявки на вступление — всего ${total}</h2><p class="mini">Приём с сайта выполняет полный онбординг: роли, ник, профиль-канал, ЛС с правилами.</p>${pager('/panel?tab=apps', pageNum, total)}</div>${directAdd}${bulkBar}${cards.join('') || '<div class="card">Очередь пуста.</div>'}${pager('/panel?tab=apps', pageNum, total)}`;
}

async function rejectPresetSelect(queue) {
  const rows = await db.all('SELECT text FROM reject_reason_templates WHERE queue = ? ORDER BY position, id', [queue]).catch(() => []);
  if (!rows.length) return '';
  return `<select name="preset"><option value="">— свой текст ниже —</option>${rows.map((r) => `<option value="${esc(r.text)}">${esc(r.text.slice(0, 80))}</option>`).join('')}</select>`;
}

const QUEUE_DEFS = {
  passport: ['passport_requests', 'Добавление паспорта'],
  data_change: ['data_change_requests', 'Изменение данных'],
  hr_app: ['hr_applications', 'Заявки в HR'],
  appeal: ['appeals', 'Апелляции ЧС'],
  codeword: ['codeword_submissions', 'Кодовые слова'],
};
async function panelQueues(client, user, pageNum = 0) {
  const out = [];
  let maxTotal = 0;
  const presetByKey = {};
  for (const key of Object.keys(QUEUE_DEFS)) presetByKey[key] = await rejectPresetSelect(key === 'hr_app' ? 'hr_application' : key);
  for (const [key, [table, title]] of Object.entries(QUEUE_DEFS)) {
    const cr = await db.get(`SELECT COUNT(*) c FROM ${table} WHERE status='pending'`).catch(() => null);
    const cnt = cr ? cr.c : 0;
    if (cnt > maxTotal) maxTotal = cnt;
    const rows = await db.all(`SELECT * FROM ${table} WHERE status='pending' ORDER BY id ASC LIMIT ? OFFSET ?`, [PAGE_SIZE, pageNum * PAGE_SIZE]).catch(() => []);
    const cards = rows.map((r) => {
      let info = '';
      if (key === 'passport') info = `${esc(r.name)} · № ${esc(r.static)}`;
      else if (key === 'data_change') info = `№ ${esc(r.target_static)}: «${esc(r.old_name)}» → «${esc(r.new_name)}»`;
      else if (key === 'hr_app') info = `часов/нед: ${esc(r.hours_per_week)} · обучать готов: ${esc(r.training_ready)}`;
      else if (key === 'appeal') info = esc((r.text || '—').slice(0, 300));
      else if (key === 'codeword') info = `${esc(r.name)} · № ${esc(r.static)} · <a href="${esc(r.screenshot_url || r.message_url || '#')}" target="_blank" rel="noopener">скрин</a>`;
      return `<div class="card">
        <b>#${r.id}</b> — ${personLink(client, r.discord_id)} · ${fmt(r.created_at || r.submitted_at)}
        <div class="mini">${info}</div>
        <div class="bar">
          <form method="POST" action="/panel/queue/approve" style="display:inline">${csrfField(user)}<input type="hidden" name="q" value="${key}"><input type="hidden" name="id" value="${r.id}"><button class="btn sm" type="submit">✅ Одобрить</button></form>
          <form method="POST" action="/panel/queue/reject" style="display:inline">${csrfField(user)}<input type="hidden" name="q" value="${key}"><input type="hidden" name="id" value="${r.id}">${presetByKey[key] || ''}<input name="reason" placeholder="причина отказа" maxlength="200" style="max-width:180px"><button class="btn sm" style="background:var(--bad)" type="submit">❌</button></form>
        </div>
      </div>`;
    }).join('');
    out.push(`<div class="card"><h2>${esc(title)} (${cnt})</h2></div>${cards || '<div class="card">Пусто.</div>'}`);
  }
  return `<div class="card">${pager('/panel?tab=queues', pageNum, maxTotal)}</div>${out.join('')}${pager('/panel?tab=queues', pageNum, maxTotal)}`;
}

async function panelTexts(user) {
  const keys = [['rules', 'Свод правил'], ['agitation', 'Агитация'], ['hr_info', 'HR-вакансия']];
  const defaults = { rules: content.DEFAULT_RULES, agitation: content.DEFAULT_AGITATION, hr_info: content.DEFAULT_HR_INFO };
  const parts = [];
  for (const [k, title] of keys) {
    let cur = '';
    try { const row = await contentVersions.getLatestVersion(k); cur = row ? row.content : ''; } catch (_) {}
    if (!cur || !cur.trim()) cur = defaults[k] || ''; // нет сохранённой версии — подставляем текущий дефолт
    const extra = k === 'rules'
      ? `<form method="POST" action="/panel/rules_broadcast" style="margin-top:8px" onsubmit="return confirm('Отправить правила в канал правил и в ЛС всем участникам?')">${csrfField(user)}<button class="btn ghost sm" type="submit">📕 Разослать правила</button></form>`
      : (k === 'agitation' || k === 'hr_info'
        ? `<form method="POST" action="/panel/text/publish" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="key" value="${k}"><button class="btn ghost sm" type="submit">Опубликовать в канал</button></form>`
        : '');
    parts.push(`<div class="card"><h2>${esc(title)}</h2>
      <form method="POST" action="/panel/text/save" class="form">${csrfField(user)}<input type="hidden" name="key" value="${k}">
        <label>Текст<textarea name="content" data-md rows="8" maxlength="6000">${esc(cur)}</textarea></label>
        <button class="btn" type="submit">Сохранить новую версию</button>
      </form>${extra}</div>`);
  }
  return parts.join('');
}

const FORM_FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'checkbox'];
// Приводит присланный JSON полей формы к безопасному массиву.
function sanitizeFormFields(raw) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch (_) { return null; }
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out = [];
  for (const f of arr.slice(0, 40)) {
    if (!f || typeof f !== 'object') continue;
    const key = String(f.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    const label = String(f.label || '').slice(0, 120).trim();
    if (!key || !label || seen.has(key)) continue;
    const type = FORM_FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const o = { key, label, type, required: !!f.required };
    if (type === 'select') {
      o.options = (Array.isArray(f.options) ? f.options : []).map((x) => String(x).slice(0, 80).trim()).filter(Boolean).slice(0, 30);
      if (!o.options.length) continue;
    }
    seen.add(key);
    out.push(o);
  }
  return out;
}

async function panelForms(client, user, acc) {
  const canEdit = acc.rank >= LEVELS.owner;
  const forms = await db.all('SELECT * FROM forms ORDER BY id DESC').catch(() => []);

  const listRows = (await Promise.all(forms.map(async (f) => {
    const pc = await db.get("SELECT COUNT(*) c FROM form_submissions WHERE form_id = ? AND status='pending'", [f.id]).catch(() => null);
    const tc = await db.get('SELECT COUNT(*) c FROM form_submissions WHERE form_id = ?', [f.id]).catch(() => null);
    return `<tr>
      <td>${esc(f.name)}</td>
      <td><a href="/form/${esc(f.slug)}" target="_blank" rel="noopener">/form/${esc(f.slug)}</a></td>
      <td>${pc ? pc.c : 0} / ${tc ? tc.c : 0}</td>
      <td>${f.active ? '✅' : '—'}</td>
      <td style="white-space:nowrap">${canEdit ? `
        <button class="btn ghost sm" type="button" onclick='fcFormLoad(${JSON.stringify(String(f.id))})'>изменить</button>
        <form method="POST" action="/panel/forms/toggle" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${f.id}"><button class="btn ghost sm" type="submit">${f.active ? 'выкл' : 'вкл'}</button></form>
        <form method="POST" action="/panel/forms/delete" style="display:inline" onsubmit="return confirm('Удалить форму «${esc(f.name)}» и все её заявки?')">${csrfField(user)}<input type="hidden" name="id" value="${f.id}"><button class="btn ghost sm" style="background:var(--bad)" type="submit">✕</button></form>
      ` : '<span class="mini">—</span>'}</td>
    </tr>`;
  }))).join('');
  const listCard = `<div class="card"><h2>Формы (${forms.length})</h2>
    ${forms.length ? `<div class="tablewrap"><table><tr><th>Название</th><th>Ссылка</th><th>Заявок (ждут / всего)</th><th>Активна</th><th></th></tr>${listRows}</table></div>` : '<p class="mini">Форм пока нет.</p>'}
  </div>`;

  let editorCard = '';
  if (canEdit) {
    const FORMS_MAP = Object.fromEntries(forms.map((f) => [String(f.id), {
      name: f.name || '', slug: f.slug || '', description: f.description || '', channel_id: f.channel_id || '', fields: f.fields || '[]',
    }]));
    editorCard = `<div class="card" id="formEditor"><h2>Создать / изменить форму</h2>
      <form method="POST" action="/panel/forms/save" class="form" onsubmit="return fcFormSubmit(this)">${csrfField(user)}
        <input type="hidden" name="id" id="fe_id" value="">
        <label>Название<input name="name" id="fe_name" required maxlength="80"></label>
        <label>Адрес формы: /form/<input name="slug" id="fe_slug" required maxlength="40" pattern="[a-z0-9_-]+" placeholder="напр. hr-otchet"></label>
        <label>Описание (необязательно)<textarea name="description" id="fe_desc" rows="2" maxlength="500"></textarea></label>
        <label>ID Discord-канала для заявок<input name="channel_id" id="fe_channel" pattern="[0-9]*" maxlength="25"></label>
        <h3 style="font-size:14px;margin:10px 0 4px">Поля формы</h3>
        <div id="fe_rows"></div>
        <div class="bar"><button class="btn ghost sm" type="button" onclick="fcFormAddRow()">+ Поле</button></div>
        <textarea id="fe_fields" name="fields" style="display:none"></textarea>
        <div class="bar" style="margin-top:8px">
          <button class="btn" type="submit">Сохранить форму</button>
          <button class="btn ghost sm" type="button" onclick="fcFormClear()">Новая / очистить</button>
        </div>
      </form>
      <script>
      var FORMS_MAP=${JSON.stringify(FORMS_MAP).replace(/</g, '\\u003c')};
      function fcSlugify(s){return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);}
      function fcFormRow(fl){
        fl=fl||{};
        var d=document.createElement('div'); d.className='bar'; d.style.cssText='margin:4px 0;flex-wrap:wrap'; d.dataset.frow='1';
        d.innerHTML='<input class="ff-label" placeholder="Вопрос / подпись поля" maxlength="120" style="flex:2;min-width:150px">'
          +'<input class="ff-key" placeholder="ключ" maxlength="40" style="flex:1;min-width:80px">'
          +'<select class="ff-type"><option value="text">строка</option><option value="textarea">текст</option><option value="select">выбор</option><option value="number">число</option><option value="checkbox">галочка</option></select>'
          +'<label class="mini" style="display:flex;align-items:center;gap:3px"><input type="checkbox" class="ff-req"> обяз.</label>'
          +'<input class="ff-opts" placeholder="варианты через запятую (для «выбор»)" maxlength="400" style="flex:2;min-width:150px">'
          +'<button class="btn ghost sm" type="button" onclick="var r=this.parentNode;if(r.previousElementSibling)r.parentNode.insertBefore(r,r.previousElementSibling);fcFormSync()">▲</button>'
          +'<button class="btn ghost sm" type="button" onclick="var r=this.parentNode,n=r.nextElementSibling;if(n)r.parentNode.insertBefore(n,r);fcFormSync()">▼</button>'
          +'<button class="btn ghost sm" type="button" style="background:var(--bad)" onclick="this.parentNode.remove();fcFormSync()">✕</button>';
        d.querySelector('.ff-label').value=fl.label||'';
        d.querySelector('.ff-key').value=fl.key||'';
        d.querySelector('.ff-type').value=fl.type||'text';
        d.querySelector('.ff-req').checked=!!fl.required;
        d.querySelector('.ff-opts').value=(fl.options||[]).join(', ');
        d.querySelectorAll('input,select').forEach(function(e){e.addEventListener('input',fcFormSync);});
        return d;
      }
      function fcFormAddRow(fl){document.getElementById('fe_rows').appendChild(fcFormRow(fl));fcFormSync();}
      function fcFormSync(){
        var rows=document.querySelectorAll('#fe_rows [data-frow]'), out=[];
        rows.forEach(function(r){
          var label=r.querySelector('.ff-label').value.trim();
          var key=(r.querySelector('.ff-key').value.trim()||fcSlugify(label)).replace(/-/g,'_');
          r.querySelector('.ff-key').value=key;
          if(!label||!key)return;
          var t=r.querySelector('.ff-type').value;
          var o={key:key,label:label,type:t,required:r.querySelector('.ff-req').checked};
          if(t==='select')o.options=r.querySelector('.ff-opts').value.split(',').map(function(x){return x.trim()}).filter(Boolean);
          out.push(o);
        });
        document.getElementById('fe_fields').value=JSON.stringify(out);
      }
      function fcFormClear(){['fe_id','fe_name','fe_slug','fe_desc','fe_channel'].forEach(function(i){document.getElementById(i).value='';});document.getElementById('fe_rows').innerHTML='';fcFormAddRow();}
      function fcFormLoad(id){
        var f=FORMS_MAP[id]; if(!f)return;
        document.getElementById('fe_id').value=id;
        document.getElementById('fe_name').value=f.name||'';
        document.getElementById('fe_slug').value=f.slug||'';
        document.getElementById('fe_desc').value=f.description||'';
        document.getElementById('fe_channel').value=f.channel_id||'';
        var box=document.getElementById('fe_rows'); box.innerHTML='';
        var arr=[]; try{arr=JSON.parse(f.fields||'[]')}catch(e){}
        arr.forEach(function(fl){box.appendChild(fcFormRow(fl))});
        if(!box.children.length)box.appendChild(fcFormRow());
        fcFormSync();
        document.getElementById('formEditor').scrollIntoView({behavior:'smooth'});
      }
      function fcFormSubmit(f){fcFormSync();return true;}
      (function(){ if(!document.getElementById('fe_rows').children.length) fcFormAddRow(); })();
      </script>
    </div>`;
  }

  const pend = await db.all(
    "SELECT s.*, f.name form_name, f.fields form_fields FROM form_submissions s LEFT JOIN forms f ON f.id = s.form_id WHERE s.status = 'pending' ORDER BY s.id DESC LIMIT 100",
  ).catch(() => []);
  const pendCard = `<div class="card"><h2>Заявки на рассмотрении (${pend.length})</h2>
    ${pend.length ? pend.map((s) => {
      let fields = []; try { fields = JSON.parse(s.form_fields || '[]'); } catch (_) {}
      let data = {}; try { data = JSON.parse(s.data || '{}'); } catch (_) {}
      const rows = fields.map((fl) => `<div class="mini"><b>${esc(fl.label)}:</b> ${esc(String(data[fl.key] == null ? '' : data[fl.key])).slice(0, 600) || '—'}</div>`).join('');
      return `<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px">
        <div class="mini">#${s.id} · «${esc(s.form_name || '?')}» · ${personLink(client, s.discord_id)} · ${fmt(s.created_at)}</div>
        ${rows || '<div class="mini">(без полей)</div>'}
        <form method="POST" action="/panel/forms/review" class="bar" style="margin-top:6px;flex-wrap:wrap">${csrfField(user)}<input type="hidden" name="id" value="${s.id}">
          <input name="note" placeholder="комментарий (виден автору при отклонении)" maxlength="300" style="flex:1;min-width:160px">
          <button class="btn sm" name="act" value="approve" type="submit">Принять</button>
          <button class="btn ghost sm" name="act" value="reject" type="submit">Отклонить</button>
        </form>
      </div>`;
    }).join('') : '<p class="mini">Пусто.</p>'}
  </div>`;

  return `${!canEdit ? '<div class="muted">Создавать и менять формы может Владелец; вам доступен разбор заявок.</div>' : ''}${listCard}${editorCard}${pendCard}`;
}

// Страница «Сообщить о баге» — создаёт приватный тикет с категорией bug.
async function bugReportBody(client, user, acc) {
  const isMember = acc.rank >= LEVELS.member
    || !!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]).catch(() => null));
  if (!isMember) {
    return `<h1>🐞 Сообщить о баге</h1>
      <div class="card">Баг-репорт создаётся как приватный тикет — это доступно участникам организации. Если вы ещё не вступили, опишите проблему в Discord.</div>
      <p><a href="/me">← в кабинет</a></p>`;
  }
  const openT = await db.get(
    "SELECT id FROM tickets WHERE opener_id = ? AND status='open' AND (category IS NULL OR category != 'appeal')",
    [user.id],
  ).catch(() => null);
  return `<h1>🐞 Сообщить о баге</h1>
  <div class="card">
    ${openT
      ? `<p>У вас уже открыт тикет — <a href="/ticket/${openT.id}">#${openT.id}</a>. Опишите баг прямо в нём.</p>`
      : `<p class="mini">Опишите, что сломалось и как это повторить. Создастся приватный тикет — переписку увидите только вы и руководство.</p>
      <form method="POST" action="/me/ticket" class="form">${csrfField(user)}
        <input type="hidden" name="from" value="bug">
        <label>Где баг<select name="category">
          <option value="bug">На сайте</option>
          <option value="bug_discord">В Discord (бот)</option>
        </select></label>
        <label>Кратко: что за баг<input name="subject" maxlength="100" required placeholder="напр. не открывается страница профиля"></label>
        <label>Где произошло (страница сайта, команда бота, канал)<input id="bugpage" name="page" maxlength="300" placeholder="/u/123 · /выплаты_hr · #канал"></label>
        <label>Подробно: что делали, что ожидали, что получилось<textarea name="description" rows="5" maxlength="2000" required></textarea></label>
        <button class="btn" type="submit">Отправить баг-репорт</button>
      </form>
      <script>(function(){try{var i=document.getElementById('bugpage');if(i&&!i.value&&document.referrer&&document.referrer.indexOf(location.origin)===0)i.value=document.referrer.slice(location.origin.length);}catch(e){}})();</script>`}
  </div>
  <p><a href="/me">← в кабинет</a></p>`;
}

// Публичная страница формы конструктора (/form/<slug>). Нужен вход, ранг не важен.
async function formPublicBody(client, user, f) {
  let fields = [];
  try { fields = JSON.parse(f.fields || '[]'); } catch (_) {}
  const mine = await db.get(
    'SELECT status FROM form_submissions WHERE form_id = ? AND discord_id = ? ORDER BY id DESC LIMIT 1',
    [f.id, user.id],
  ).catch(() => null);
  const controls = fields.map((fl) => {
    const nm = 'f_' + fl.key;
    const req = fl.required ? ' required' : '';
    const star = fl.required ? ' *' : '';
    if (fl.type === 'textarea') return `<label>${esc(fl.label)}${star}<textarea name="${esc(nm)}" rows="3" maxlength="4000"${req}></textarea></label>`;
    if (fl.type === 'select') return `<label>${esc(fl.label)}${star}<select name="${esc(nm)}"${req}><option value="">— выбрать —</option>${(fl.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></label>`;
    if (fl.type === 'checkbox') return `<label class="chk"><input type="checkbox" name="${esc(nm)}" value="1"><span>${esc(fl.label)}</span></label>`;
    if (fl.type === 'number') return `<label>${esc(fl.label)}${star}<input type="number" name="${esc(nm)}" step="any"${req}></label>`;
    return `<label>${esc(fl.label)}${star}<input name="${esc(nm)}" maxlength="500"${req}></label>`;
  }).join('');
  return `<h1>${esc(f.name)}</h1>
    ${f.description ? `<div class="card">${mdToHtml(String(f.description).slice(0, 500))}</div>` : ''}
    ${mine && mine.status === 'pending' ? '<div class="card" style="border-color:var(--warn)">У вас уже есть заявка по этой форме на рассмотрении.</div>' : ''}
    <div class="card"><form method="POST" action="/form/submit" class="form">${csrfField(user)}<input type="hidden" name="slug" value="${esc(f.slug)}">
      ${controls || '<p class="mini">В форме пока нет полей.</p>'}
      <button class="btn" type="submit">Отправить</button>
    </form></div>
    <p><a href="/me">← в кабинет</a></p>`;
}

async function panelAccounts(client, user) {
  const rows = await db.all("SELECT discord_id, login, email, linked_discord_id, oauth_discord_id, first_login, login_count FROM web_users WHERE is_local = 1 ORDER BY first_login DESC LIMIT 300").catch(() => []);
  const reqs = await db.all("SELECT * FROM password_reset_requests WHERE status = 'pending' ORDER BY id DESC LIMIT 100").catch(() => []);
  const list = rows.map((r) => {
    const linked = r.linked_discord_id
      ? `${personLink(client, r.linked_discord_id)} <span class="mini">${esc(r.linked_discord_id)}</span>`
      : '<span class="mini">—</span>';
    const oauthOk = r.oauth_discord_id && guildOf(client) && guildOf(client).members.cache.get(r.oauth_discord_id);
    return `<tr>
      <td><b>${esc(r.login || '—')}</b><div class="mini">${esc(r.email || '')}</div></td>
      <td>${linked}</td>
      <td class="mini">${r.oauth_discord_id ? esc(r.oauth_discord_id) + (oauthOk ? ' ✅' : ' ⚠ не на сервере') : '—'}</td>
      <td class="muted">${fmt(r.first_login)} · входов ${r.login_count || 0}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/panel/accounts/link" class="bar" style="margin:0;gap:4px">${csrfField(user)}<input type="hidden" name="id" value="${esc(r.discord_id)}">
          <input name="participant" placeholder="Discord ID / № паспорта" maxlength="30" style="max-width:150px">
          <button class="btn ghost sm" type="submit">привязать к участнику</button>
        </form>
        ${r.linked_discord_id ? `<form method="POST" action="/panel/accounts/unlink" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${esc(r.discord_id)}"><button class="btn ghost sm" type="submit">отвязать</button></form>` : ''}
        <form method="POST" action="/panel/accounts/reset_pw" style="display:inline" onsubmit="return confirm('Сбросить пароль? Появится временный пароль — передайте его пользователю.')">${csrfField(user)}<input type="hidden" name="id" value="${esc(r.discord_id)}"><button class="btn ghost sm" type="submit">сбросить пароль</button></form>
      </td>
    </tr>`;
  }).join('');
  return `
  <div class="card"><h2>Локальные аккаунты (${rows.length})</h2>
    <p class="mini">Вход по логину/паролю без Discord. «Привязать к участнику» — по Discord ID или № паспорта: тогда человек на сайте работает от имени этого участника.</p>
    <div class="tablewrap"><table><tr><th>Логин / почта</th><th>Привязан к участнику</th><th>Свой Discord</th><th>Создан</th><th></th></tr>
      ${list || '<tr><td colspan="5">пусто</td></tr>'}
    </table></div>
  </div>
  <div class="card"><h2>Заявки на сброс пароля (${reqs.length})</h2>
    ${reqs.length ? reqs.map((q) => `<div class="bar" style="border-top:1px solid var(--line);padding-top:8px">
      <span class="mini"><b>${esc(q.login || '—')}</b> · ${esc(q.email || '—')} · ${fmt(q.created_at)}${q.note ? `<br>${esc(q.note)}` : ''}</span>
      <form method="POST" action="/panel/accounts/reset_done" style="margin:0">${csrfField(user)}<input type="hidden" name="id" value="${q.id}"><button class="btn ghost sm" type="submit">Выполнено</button></form>
    </div>`).join('') : '<p class="mini">Пусто.</p>'}
  </div>`;
}

async function panelBroadcast(user) {
  const tpls = await db.all('SELECT * FROM broadcast_templates ORDER BY id DESC').catch(() => []);
  const opts = tpls.map((t) => `<option data-text="${esc(t.text)}">${esc(t.name)}</option>`).join('');
  const tplList = tpls.map((t) => `<tr><td>${esc(t.name)}</td><td class="mini">${esc((t.text || '').slice(0, 120))}</td>
    <td><form method="POST" action="/panel/broadcast/tpl_delete" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${t.id}"><button class="btn ghost sm" type="submit">удалить</button></form></td></tr>`).join('');
  return `<div class="card"><h2>Рассылка</h2>
    <form method="POST" action="/panel/broadcast" class="form" onsubmit="return confirm('Отправить сообщение?')">
      ${csrfField(user)}
      <label>Куда<select name="mode"><option value="channel">В канал (по ID)</option><option value="dm_all">В ЛС всем участникам</option></select></label>
      <label>ID канала (для режима «в канал»)<input name="channel_id" pattern="[0-9]*" maxlength="25"></label>
      ${tpls.length ? `<label>Вставить шаблон<select onchange="var t=this.selectedOptions[0].dataset.text;if(t)this.form.text.value=t"><option value="">—</option>${opts}</select></label>` : ''}
      <label>Текст<textarea name="text" rows="5" required maxlength="1800"></textarea></label>
      <button class="btn" type="submit">Отправить</button>
    </form>
    <p class="mini">Подстановки для режима «в ЛС»: <code>{имя}</code> <code>{паспорт}</code> <code>{ранг}</code>. В ЛС рассылка идёт с паузами; у кого закрыты ЛС — пропускаются.</p>
  </div>
  <div class="card"><h2>Шаблоны рассылок</h2>
    <form method="POST" action="/panel/broadcast/tpl_save" class="form">${csrfField(user)}
      <label>Название<input name="name" required maxlength="80"></label>
      <label>Текст<textarea name="text" rows="4" required maxlength="1800"></textarea></label>
      <button class="btn sm" type="submit">Сохранить шаблон</button>
    </form>
    ${tpls.length ? `<div class="tablewrap"><table><tr><th>Название</th><th>Текст</th><th></th></tr>${tplList}</table></div>` : ''}
  </div>`;
}

const FEATURE_FLAGS = [
  ['applications', 'Приём заявок на вступление'],
  ['contracts', 'Приём контрактов по скриншотам'],
  ['reminders', 'Напоминания (SLA, отпуска, HR)'],
];
async function panelSettings(user) {
  const rows = await db.all('SELECT key, value FROM settings ORDER BY key').catch(() => []);
  const flags = [];
  for (const [k, lbl] of FEATURE_FLAGS) {
    const v = await db.getSetting(`feature_${k}_enabled`);
    const on = v !== 'false';
    flags.push(`<form method="POST" action="/panel/feature/toggle" style="display:flex;gap:10px;align-items:center;margin:6px 0">
      ${csrfField(user)}<input type="hidden" name="key" value="${k}"><input type="hidden" name="on" value="${on ? '0' : '1'}">
      <span style="min-width:280px">${esc(lbl)}</span>
      <button class="btn ${on ? '' : 'ghost'} sm" type="submit">${on ? '✅ включено' : '⬜ выключено'}</button>
    </form>`);
  }
  const list = rows.map((s) => `<form method="POST" action="/panel/setting/save" class="form" style="border-bottom:1px solid var(--line);padding-bottom:10px">
    ${csrfField(user)}<input type="hidden" name="key" value="${esc(s.key)}">
    <label>${esc(s.key)}<input name="value" value="${esc(s.value == null ? '' : s.value)}"></label>
    <button class="btn sm" type="submit">Сохранить</button>
  </form>`).join('');
  const backupTime = (await db.getSetting('backup.time')) || '';
  return `<div class="card"><h2>Переключатели</h2>${flags.join('')}</div>
  <div class="card"><h2>Автобэкап БД</h2>
    <p class="mini">Время ежедневной резервной копии по МСК (формат ЧЧ:ММ). Пусто — по умолчанию 23:59. Применяется в течение часа.</p>
    <form method="POST" action="/panel/setting/save" class="bar">${csrfField(user)}<input type="hidden" name="key" value="backup.time">
      <input name="value" type="time" value="${esc(backupTime)}"><button class="btn sm" type="submit">Сохранить</button>
    </form>
  </div>
  <div class="card"><h2>Настройки (settings)</h2>${list || '<p class="mini">Пока пусто.</p>'}
    <form method="POST" action="/panel/setting/save" class="form" style="margin-top:14px">
      ${csrfField(user)}
      <h3>Новый ключ</h3>
      <label>Ключ<input name="key" required maxlength="60"></label>
      <label>Значение<input name="value" maxlength="200"></label>
      <button class="btn sm" type="submit">Добавить</button>
    </form>
  </div>`;
}

async function panelPerms(user) {
  const tiers = HOOKS.commandDefaultTiers || {};
  const labels = HOOKS.tierLabels || {};
  const overrides = new Map((await db.all('SELECT command_name, tier FROM command_permission_overrides').catch(() => [])).map((o) => [o.command_name, o.tier]));
  const tierOpts = Object.keys(labels).map((t) => `<option value="${esc(t)}">${esc(labels[t] || t)}</option>`).join('');
  const rows = Object.keys(tiers).sort().map((name) => {
    const eff = overrides.has(name) ? overrides.get(name) : tiers[name];
    const isOv = overrides.has(name);
    return `<tr>
      <td><code>/${esc(name)}</code></td>
      <td>${esc(labels[eff] || eff)}${isOv ? ' <span class="badge warn">изменено</span>' : ''}</td>
      <td><form method="POST" action="/panel/perm/save" style="display:flex;gap:4px">${csrfField(user)}<input type="hidden" name="name" value="${esc(name)}">
        <select name="tier">${tierOpts}</select>
        <button class="btn sm" type="submit">OK</button>
        ${isOv ? `<button class="btn ghost sm" formaction="/panel/perm/reset" type="submit">сброс</button>` : ''}
      </form></td>
    </tr>`;
  }).join('');
  return `<div class="card"><h2>Права команд (${Object.keys(tiers).length})</h2>
    <p class="mini">Переопределение хранится в БД и перебивает значение по умолчанию. «сброс» возвращает дефолт.</p>
    <form method="POST" action="/panel/perm/sync" style="margin-bottom:10px" onsubmit="return confirm('Синхронизировать видимость всех команд в интерфейсе Discord?')">${csrfField(user)}<button class="btn sm" type="submit">Синхронизировать видимость команд в Discord</button></form>
    <div class="tablewrap"><table><tr><th>Команда</th><th>Текущий тир</th><th>Изменить</th></tr>${rows}</table></div>
  </div>`;
}

// ---------- Админ-панель havirys: бренд, тема, Discord ----------
const THEME_DEFAULTS = {
  bg: '#0f1013', panel: '#17181c', panel2: '#1e2025', line: '#2a2c33', text: '#e9e9ee',
  muted: '#9b9ba6', accent: '#5b6cff', accent2: '#8ea1ff', ok: '#3ecf8e', bad: '#ff6b6b', warn: '#f2c94c',
};
const THEME_LABELS = {
  bg: 'Фон страницы', panel: 'Карточки', panel2: 'Панели и поля', line: 'Границы', text: 'Основной текст',
  muted: 'Серый текст', accent: 'Акцент (кнопки)', accent2: 'Акцент 2 / ссылки', ok: 'Успех', bad: 'Ошибка', warn: 'Предупреждение',
};
const THEME_PRESETS = {
  default: {},
  amoled: { bg: '#000000', panel: '#0a0a0a', panel2: '#141414', line: '#242424', text: '#f0f0f0', muted: '#8a8a8a', accent: '#4f8cff', accent2: '#79a9ff' },
  ocean: { bg: '#0b1622', panel: '#122232', panel2: '#18314a', line: '#20415f', text: '#e6f0f7', muted: '#8fa9bd', accent: '#1fb6c9', accent2: '#5fd3e2' },
  forest: { bg: '#0e1712', panel: '#15211a', panel2: '#1d2f24', line: '#2a3f31', text: '#e8f2ea', muted: '#94ab9c', accent: '#3fae6b', accent2: '#71cf97' },
  plum: { bg: '#160f1a', panel: '#1e1626', panel2: '#2a1f36', line: '#3a2c49', text: '#f1e9f5', muted: '#a996b3', accent: '#9b59d0', accent2: '#bd8ae0' },
  midnight: { bg: '#0a0e1a', panel: '#111629', panel2: '#182038', line: '#26304f', text: '#e6e9f5', muted: '#8b93b0', accent: '#4c6ef5', accent2: '#7d97ff' },
  crimson: { bg: '#120c0d', panel: '#1b1214', panel2: '#26181b', line: '#3a2429', text: '#f2e8e9', muted: '#b09499', accent: '#e5484d', accent2: '#ff7a7f', bad: '#ff5c5c' },
  sunset: { bg: '#15100b', panel: '#1f1712', panel2: '#2c2119', line: '#413021', text: '#f5ece2', muted: '#b7a08c', accent: '#f2870d', accent2: '#ffb055', warn: '#ffc247' },
  mono: { bg: '#101010', panel: '#1a1a1a', panel2: '#242424', line: '#333333', text: '#ededed', muted: '#9a9a9a', accent: '#8a8a8a', accent2: '#bdbdbd' },
  nord: { bg: '#2e3440', panel: '#333b4a', panel2: '#3b4252', line: '#4c566a', text: '#eceff4', muted: '#a8b1c2', accent: '#88c0d0', accent2: '#81a1c1' },
  dracula: { bg: '#191a21', panel: '#21222c', panel2: '#282a36', line: '#3b3e52', text: '#f8f8f2', muted: '#a3a7c2', accent: '#bd93f9', accent2: '#8be9fd', ok: '#50fa7b', bad: '#ff5555', warn: '#f1fa8c' },
  rose: { bg: '#160f13', panel: '#1f161b', panel2: '#2c1f27', line: '#402d38', text: '#f4e9ef', muted: '#b498a6', accent: '#ec4899', accent2: '#f77fb6' },
  emerald: { bg: '#08130f', panel: '#0e1c17', panel2: '#132a22', line: '#1e3d32', text: '#e4f4ee', muted: '#8bb1a4', accent: '#10b981', accent2: '#4fd8ab' },
  coffee: { bg: '#14100c', panel: '#1d1712', panel2: '#29201a', line: '#3c2f25', text: '#f0e7dc', muted: '#b3a08c', accent: '#c08457', accent2: '#dba97f' },
  slate: { bg: '#0f141a', panel: '#171e26', panel2: '#1f2833', line: '#2e3a48', text: '#e8edf3', muted: '#93a1b0', accent: '#5b8def', accent2: '#89aef7' },
  gold: { bg: '#12100a', panel: '#1b1810', panel2: '#262117', line: '#3a3324', text: '#f3efe2', muted: '#b6ab8f', accent: '#d4af37', accent2: '#e6c860' },
  cyberpunk: { bg: '#0a0a12', panel: '#12111f', panel2: '#1a1830', line: '#2c2850', text: '#f0eeff', muted: '#9b96c4', accent: '#ff2bd6', accent2: '#22e0ff' },
  matrix: { bg: '#050805', panel: '#0b110b', panel2: '#111a11', line: '#1e2e1e', text: '#d6ffd6', muted: '#79a879', accent: '#22c55e', accent2: '#5ef08a' },
  lavender: { bg: '#12111a', panel: '#1a1826', panel2: '#242235', line: '#35314c', text: '#efecf7', muted: '#a9a3c0', accent: '#a78bfa', accent2: '#c4b1fd' },
  steel: { bg: '#0e1214', panel: '#161c1f', panel2: '#1e262a', line: '#2d383d', text: '#e7edf0', muted: '#93a0a6', accent: '#5aa0b8', accent2: '#84c3d6' },
  sakura: { bg: '#1a1416', panel: '#241a1e', panel2: '#322429', line: '#453139', text: '#f6ecef', muted: '#bd9fa9', accent: '#ff8fab', accent2: '#ffc2d1' },
};
const PRESET_LABELS = {
  default: 'стандарт', amoled: 'AMOLED', ocean: 'океан', forest: 'лес', plum: 'слива',
  midnight: 'полночь', crimson: 'багровый', sunset: 'закат', mono: 'графит', nord: 'норд',
  dracula: 'дракула', rose: 'роза', emerald: 'изумруд', coffee: 'кофе', slate: 'сланец',
  gold: 'золото', cyberpunk: 'киберпанк', matrix: 'матрица', lavender: 'лаванда', steel: 'сталь',
  sakura: 'сакура',
};
// Какой пресет соответствует текущим цветам сайта (или null — «свои цвета»).
function activePreset(colors) {
  const cur = { ...THEME_DEFAULTS, ...(colors || {}) };
  for (const [name, pr] of Object.entries(THEME_PRESETS)) {
    const eff = { ...THEME_DEFAULTS, ...pr };
    if (Object.keys(THEME_DEFAULTS).every((k) => (cur[k] || '').toLowerCase() === (eff[k] || '').toLowerCase())) return name;
  }
  return null;
}

async function panelAdmin(client, user) {
  await loadSite(true);
  const g = guildOf(client);
  const v = (k, d) => esc(SITE[k] != null && SITE[k] !== '' ? SITE[k] : (d || ''));

  const curPreset = activePreset(SITE.color);
  const colorInputs = Object.keys(THEME_DEFAULTS).map((k) => {
    const cur = (SITE.color && SITE.color[k]) || THEME_DEFAULTS[k];
    return `<label>${esc(THEME_LABELS[k])}
      <span style="display:flex;gap:8px;align-items:center">
        <input type="color" name="c_${k}" value="${esc(cur)}" oninput="this.nextElementSibling.value=this.value">
        <input name="t_${k}" value="${esc(cur)}" pattern="#[0-9a-fA-F]{6}" style="max-width:110px" oninput="if(/^#[0-9a-fA-F]{6}$/.test(this.value))this.previousElementSibling.value=this.value">
      </span></label>`;
  }).join('');

  let roleRows = '<tr><td colspan="3">бот офлайн</td></tr>';
  let botNick = '';
  if (g) {
    botNick = (g.members.me && g.members.me.nickname) || '';
    const ids = [config.ROLE_OWNER, config.ROLE_DEPUTY, config.ROLE_HR, ...(config.ROLE_IDS || []), config.ROLE_ORGANIZATION].filter(Boolean);
    for (const b of await db.all('SELECT role_id FROM badge_roles').catch(() => [])) ids.push(b.role_id);
    roleRows = [...new Set(ids)].map((rid) => {
      const r = g.roles.cache.get(rid);
      if (!r) return '';
      let hex = '#' + (r.color || 0).toString(16).padStart(6, '0');
      if (hex === '#000000') hex = '#99aab5';
      return `<tr><td>${esc(r.name)}</td><td><code>${esc(rid)}</code></td><td>
        <form method="POST" action="/admin/role" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${csrfField(user)}
          <input type="hidden" name="id" value="${esc(rid)}">
          <input name="name" value="${esc(r.name)}" maxlength="90" style="max-width:170px">
          <input type="color" name="color" value="${esc(hex)}">
          <button class="btn sm" type="submit">Сохранить</button>
        </form></td></tr>`;
    }).join('') || '<tr><td colspan="3">—</td></tr>';
  }

  return `
  <div class="card" style="border-color:${config.ENABLE_PRESENCE ? 'var(--ok)' : 'var(--warn)'}">
    <h2>Онлайн-статус участников</h2>
    ${config.ENABLE_PRESENCE
      ? '<p class="mini">Включён: зелёная точка у имени показывает, кто сейчас онлайн в Discord. Нужен привилегированный интент <b>Presence Intent</b> в Developer Portal.</p>'
      : '<p class="mini">Выключен. Чтобы у имён появилась зелёная точка «онлайн», задайте <code>ENABLE_PRESENCE: true</code> в <code>config.js</code> и включите <b>Presence Intent</b> в Discord Developer Portal → Bot → Privileged Gateway Intents, затем перезапустите бота.</p>'}
  </div>
  <div class="card"><h2>Название и тексты сайта</h2>
    <form method="POST" action="/admin/site" class="form">${csrfField(user)}
      <label>Название организации<input name="brand" value="${v('brand', config.SITE_BRAND)}" maxlength="60"></label>
      <label>Ссылка-приглашение в Discord<input name="invite" value="${v('invite', config.SITE_DISCORD_INVITE)}" maxlength="200"></label>
      <label>Заголовок на главной<input name="hero_title" value="${v('hero_title')}" maxlength="120" placeholder="Организация «${esc(config.SITE_BRAND)}»"></label>
      <label>Текст на главной<textarea name="hero_text" rows="3" maxlength="600">${v('hero_text')}</textarea></label>
      <label>Подпись в подвале<textarea name="footer" rows="2" maxlength="300">${v('footer')}</textarea></label>
      <button class="btn" type="submit">Сохранить</button>
    </form>
  </div>

  <div class="card"><h2>Цвета сайта (тёмная тема)</h2>
    <form method="POST" action="/admin/theme" class="form">${csrfField(user)}
      ${colorInputs}
      <div class="bar" style="margin-top:12px">
        <button class="btn" type="submit">Применить</button>
        <button class="btn ghost sm" formaction="/admin/theme_reset" formnovalidate type="submit">Сбросить к стандартным</button>
      </div>
    </form>
    <div class="bar" style="margin-top:8px;flex-wrap:wrap;gap:4px"><span class="mini" style="width:100%">Пресеты (${Object.keys(THEME_PRESETS).length}):</span>
      ${Object.keys(THEME_PRESETS).map((pn) => {
        const on = curPreset === pn;
        const pr = { ...THEME_DEFAULTS, ...THEME_PRESETS[pn] };
        const sw = `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;background:${pr.accent};box-shadow:0 0 0 1px ${pr.line}"></span>`;
        return `<form method="POST" action="/admin/theme_preset" style="display:inline">${csrfField(user)}<input type="hidden" name="preset" value="${pn}"><button class="btn ${on ? '' : 'ghost '}sm" type="submit"${on ? ' style="outline:2px solid var(--accent2);outline-offset:1px"' : ''}>${sw}${on ? '✓ ' : ''}${esc(PRESET_LABELS[pn])}</button></form>`;
      }).join('')}
    </div>
    <p class="mini">Сейчас: <b>${curPreset ? esc(PRESET_LABELS[curPreset]) : 'свои цвета'}</b>. Применяется на всех страницах через ~30 сек (кэш). Светлая тема остаётся стандартной.</p>
  </div>

  <div class="card"><h2>Конфигурация сайта (JSON)</h2>
    <a class="btn sm" href="/export/site-config.json">Скачать настройки</a>
    <form method="POST" action="/admin/config_import" class="form" style="margin-top:10px">${csrfField(user)}
      <label>Загрузить (вставьте JSON вида {"site":{...},"channels":{...}})<textarea name="json" rows="4"></textarea></label>
      <button class="btn sm" type="submit">Применить</button>
    </form>
  </div>

  <div class="card"><h2>Логотип и favicon</h2>
    <p class="mini">Любая картинка — сожмётся в браузере до 256px. Ставится в шапку рядом с названием и как иконка вкладки.</p>
    ${SITE.logo ? `<p><img src="${esc(SITE.logo)}" alt="" style="height:40px;border-radius:6px"></p>` : ''}
    <form method="POST" action="/admin/logo" class="form" onsubmit="return fcImgUpload(this,'file','data',256,'image/png')">${csrfField(user)}
      <label>Файл<input type="file" name="file" accept="image/*" required></label>
      <input type="hidden" name="data">
      <button class="btn sm" type="submit">Загрузить</button>
    </form>
    ${SITE.logo ? `<form method="POST" action="/admin/logo_clear" style="margin-top:8px">${csrfField(user)}<button class="btn ghost sm" type="submit">Убрать логотип</button></form>` : ''}
  </div>

  <div class="card"><h2>Пункты меню в шапке</h2>
    <p class="mini">Собери меню кнопками. «Кому»: все / участники / HR+. Пустой список = вернуть стандартное меню.</p>
    <form method="POST" action="/admin/nav" class="form" id="navForm" onsubmit="return fcNavSubmit(this)">${csrfField(user)}
      <div id="navRows"></div>
      <div class="bar">
        <button class="btn ghost sm" type="button" onclick="fcNavAdd('','',' all')">+ Пункт</button>
        <button class="btn ghost sm" type="button" onclick="fcNavReset()">Сбросить к стандартному</button>
        <button class="btn ghost sm" type="button" onclick="var t=document.getElementById('navRaw');t.style.display=t.style.display==='none'?'':'none'">Текстом</button>
      </div>
      <div class="mini" style="margin:8px 0">Предпросмотр: <span id="navPreview" class="nav" style="display:inline-flex;flex-wrap:wrap;gap:4px"></span></div>
      <textarea id="navRaw" name="nav" rows="8" maxlength="2000" style="display:none">${esc((SITE.nav && SITE.nav.trim()) ? SITE.nav : '')}</textarea>
      <button class="btn sm" type="submit">Сохранить меню</button>
    </form>
    <datalist id="navPaths">
      ${['/me', '/people', '/giveaways', '/faq', '/commands', '/dashboard', '/tickets', '/panel', '/panel?tab=apps', '/panel?tab=queues', '/panel?tab=contracts_check', '/panel?tab=members', '/panel?tab=giveaways', '/audit', '/leaderboards', '/calendar', '/search', '/notifications', '/compare', '/health', '/tools', '/rules', '/about'].map((x) => `<option value="${x}">`).join('')}
    </datalist>
    <script>
    var NAV_DEFAULT=${JSON.stringify(DEFAULT_NAV_TEXT)};
    function fcNavRow(txt,url,tier){
      var d=document.createElement('div'); d.className='bar'; d.style.margin='4px 0'; d.dataset.row='1';
      d.innerHTML='<input class="nv-t" placeholder="Название" maxlength="40" style="flex:1;min-width:120px">'
        +'<input class="nv-u" list="navPaths" placeholder="/path" maxlength="120" style="flex:1;min-width:120px">'
        +'<select class="nv-r"><option value="all">все</option><option value="member">участники</option><option value="hr">HR+</option></select>'
        +'<button class="btn ghost sm" type="button" onclick="var r=this.parentNode;r.parentNode.insertBefore(r,r.previousElementSibling);fcNavSync()">▲</button>'
        +'<button class="btn ghost sm" type="button" onclick="var r=this.parentNode,n=r.nextElementSibling;if(n)r.parentNode.insertBefore(n,r);fcNavSync()">▼</button>'
        +'<button class="btn ghost sm" type="button" style="background:var(--bad)" onclick="this.parentNode.remove();fcNavSync()">✕</button>';
      d.querySelector('.nv-t').value=txt||''; d.querySelector('.nv-u').value=url||''; d.querySelector('.nv-r').value=(tier||'all').trim()||'all';
      d.querySelectorAll('input,select').forEach(function(e){e.addEventListener('input',fcNavSync);});
      return d;
    }
    function fcNavAdd(t,u,r){document.getElementById('navRows').appendChild(fcNavRow(t,u,r));fcNavSync();}
    function fcNavFromText(txt){
      var box=document.getElementById('navRows'); box.innerHTML='';
      (txt||'').split('\\n').forEach(function(l){
        var p=l.split('|').map(function(x){return x.trim()});
        if(p[0]&&p[1])box.appendChild(fcNavRow(p[0],p[1],p[2]||'all'));
      });
      if(!box.children.length)box.appendChild(fcNavRow('','','all'));
      fcNavSync();
    }
    function fcNavSync(){
      var rows=document.querySelectorAll('#navRows [data-row]'), lines=[], prev='';
      rows.forEach(function(r){
        var t=r.querySelector('.nv-t').value.trim(), u=r.querySelector('.nv-u').value.trim(), tr=r.querySelector('.nv-r').value;
        if(t&&u){lines.push(t+' | '+u+' | '+tr); prev+='<a href="'+u.replace(/"/g,'')+'">'+t.replace(/</g,'&lt;')+'</a>';}
      });
      document.getElementById('navRaw').value=lines.join('\\n');
      document.getElementById('navPreview').innerHTML=prev||'<span class="mini">(стандартное меню)</span>';
    }
    function fcNavReset(){ if(confirm('Загрузить стандартное меню в редактор?')) fcNavFromText(NAV_DEFAULT); }
    function fcNavSubmit(f){ fcNavSync(); return true; }
    (function(){
      var raw=document.getElementById('navRaw').value.trim();
      fcNavFromText(raw || NAV_DEFAULT);
      document.getElementById('navRaw').addEventListener('change',function(){fcNavFromText(this.value);});
    })();
    </script>
  </div>

  <div class="card"><h2>Свой CSS</h2>
    <p class="mini">Добавляется в конец стилей на всех страницах. Осторожно — можно сломать вёрстку.</p>
    <form method="POST" action="/admin/css" class="form">${csrfField(user)}
      <textarea name="css" rows="8" maxlength="20000" placeholder=".card{border-radius:20px}">${esc(SITE.css || '')}</textarea>
      <button class="btn sm" type="submit">Сохранить CSS</button>
    </form>
  </div>

  <div class="card"><h2>ID каналов бота</h2>
    <form method="POST" action="/admin/channels" class="form">${csrfField(user)}
      ${Object.keys(config).filter((k) => k.startsWith('CHANNEL_')).map((k) => `<label>${esc(k.replace('CHANNEL_', ''))}<input name="ch_${esc(k)}" value="${esc(String(config[k] || ''))}" pattern="[0-9]*" maxlength="25"></label>`).join('')}
      <button class="btn" type="submit">Сохранить ID каналов</button>
    </form>
    <p class="mini">Переопределения хранятся в БД и применяются мгновенно (config_overrides).</p>
  </div>

  <div class="card"><h2>Discord — ник бота на сервере</h2>
    <form method="POST" action="/admin/bot_nick" class="form">${csrfField(user)}
      <label>Ник бота (пусто = сбросить к имени приложения)<input name="nick" value="${esc(botNick)}" maxlength="32"></label>
      <button class="btn sm" type="submit">Сохранить</button>
    </form>
  </div>

  <div class="card"><h2>Discord — роли (имя и цвет)</h2>
    <p class="mini">Роль бота должна быть в списке ролей ВЫШЕ редактируемых, иначе Discord не даст их менять.</p>
    <div class="tablewrap"><table><tr><th>Роль</th><th>ID</th><th>Изменить</th></tr>${roleRows}</table></div>
  </div>

  <div class="card"><h2>Discord — меню с кнопками</h2>
    <form method="POST" action="/admin/menus" onsubmit="return confirm('Переинициализировать меню-сообщения во всех каналах?')">${csrfField(user)}
      <button class="btn sm" type="submit">Опубликовать / обновить меню в каналах</button>
    </form>
    <p class="mini">То же, что команда /меню_создать: сообщения с кнопками «Подать заявку», «Отпуск», «Тикет» и т.д.</p>
  </div>

  <div class="card"><h2>Восстановить каналы-профили</h2>
    <form method="POST" action="/admin/profiles_restore" onsubmit="return confirm('Создать недостающие каналы-профили для всех участников?')">${csrfField(user)}
      <button class="btn sm" type="submit">Создать недостающие</button>
    </form>
    <p class="mini">То же, что /профили_восстановить: для каждого паспорта без рабочего канала создаётся новый.</p>
  </div>`;
}

// ---------- Здоровье системы (Владелец) ----------
async function healthBody(client) {
  const fs = require('fs');
  const c = (sql, p = []) => db.get(sql, p).then((r) => (r ? r.c : 0));
  const g = guildOf(client);
  const up = client && client.readyTimestamp ? Date.now() - client.readyTimestamp : 0;
  const upStr = up ? `${Math.floor(up / 86400000)}д ${Math.floor(up / 3600000) % 24}ч ${Math.floor(up / 60000) % 60}м` : '—';
  let dbSize = 0;
  try { dbSize = fs.statSync(db.dbPath).size; } catch (_) {}
  const queues = {
    'заявки': await c("SELECT COUNT(*) c FROM applications WHERE status='pending'"),
    'увольнения': await c("SELECT COUNT(*) c FROM kicks WHERE status='pending'"),
    'отпуска': await c("SELECT COUNT(*) c FROM vacations WHERE status='pending'"),
    'паспорта': await c("SELECT COUNT(*) c FROM passport_requests WHERE status='pending'"),
    'изм. данных': await c("SELECT COUNT(*) c FROM data_change_requests WHERE status='pending'"),
    'HR-заявки': await c("SELECT COUNT(*) c FROM hr_applications WHERE status='pending'"),
    'апелляции': await c("SELECT COUNT(*) c FROM appeals WHERE status='pending'"),
    'кодовые слова': await c("SELECT COUNT(*) c FROM codeword_submissions WHERE status='pending'"),
    'тикеты': await c("SELECT COUNT(*) c FROM tickets WHERE status='open'"),
  };
  let lastBackup = '—';
  try {
    if (g) {
      const ch = await g.channels.fetch(config.CHANNEL_BACKUPS);
      const msgs = await ch.messages.fetch({ limit: 1 });
      const m = msgs.first();
      if (m) lastBackup = fmt(new Date(m.createdTimestamp).toISOString());
    }
  } catch (_) {}
  const logins24 = await c('SELECT COUNT(*) c FROM web_logins WHERE at >= ?', [new Date(Date.now() - 864e5).toISOString()]);
  const stuckH = (typeof config.STUCK_CONTRACT_HOURS === 'number' ? config.STUCK_CONTRACT_HOURS : 24);
  const stuckCutoff = new Date(Date.now() - stuckH * 36e5).toISOString();
  const stuckContracts = await db.get(
    "SELECT COUNT(*) c FROM contracts WHERE (status='taken' AND taken_submitted_at <= ?) OR (status='pending' AND submitted_at <= ?)",
    [stuckCutoff, stuckCutoff],
  ).then((r) => (r ? r.c : 0)).catch(() => 0);
  let uploadBytes = 0;
  for (const t of ['contract_uploads', 'page_assets']) {
    try { const r = await db.get(`SELECT COALESCE(SUM(size),0) s FROM ${t}`); uploadBytes += r ? r.s : 0; } catch (_) {}
  }
  let diskBytes = 0;
  try {
    const ud = db.dataDir ? require('path').join(db.dataDir, 'uploads') : 'data/uploads';
    for (const f of fs.readdirSync(ud)) { try { diskBytes += fs.statSync(require('path').join(ud, f)).size; } catch (_) {} }
  } catch (_) {}
  // media_cache — временный кэш вложений из Discord (скрины контрактов,
  // картинки удалённых сообщений). Файлы стираются сразу после того, как
  // бот вложил их в своё сообщение; тут почти всегда близко к нулю.
  let cacheBytes = 0; let cacheFiles = 0;
  try {
    const mc = require('path').join(db.dataDir || 'data', 'media_cache');
    for (const f of fs.readdirSync(mc)) { try { cacheBytes += fs.statSync(require('path').join(mc, f)).size; cacheFiles++; } catch (_) {} }
  } catch (_) {}
  const err24 = _errLog.filter((e) => e.at >= _since24());
  const slow24 = _slowLog.filter((e) => e.at >= _since24());
  const tile = (n, l) => `<div class="tile"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  return `
  <h1>Здоровье системы</h1>
  <div class="card"><div class="grid">
    ${tile(upStr, 'аптайм бота')}
    ${tile((client && client.ws ? Math.round(client.ws.ping) : '—') + ' мс', 'пинг Discord')}
    ${tile((dbSize / 1048576).toFixed(2) + ' МБ', 'размер БД')}
    ${tile(lastBackup, 'последний бэкап')}
    ${tile(logins24, 'входов за 24ч')}
    ${tile(g ? g.memberCount : '—', 'участников сервера')}
    ${tile((uploadBytes / 1048576).toFixed(2) + ' МБ', 'скрины в БД (legacy)')}
    ${tile((diskBytes / 1048576).toFixed(2) + ' МБ', 'скрины с сайта на диске')}
    ${tile((cacheBytes / 1048576).toFixed(2) + ' МБ', `кэш вложений Discord (${cacheFiles} файл.)`)}
    ${tile(stuckContracts, `контрактов висит >${stuckH}ч`)}
    ${tile(err24.length, 'ошибок 5xx за 24ч')}
    ${tile(slow24.length, 'медленных запросов (>1.5с) за 24ч')}
  </div></div>
  ${err24.length ? `<div class="card"><h2>Последние ошибки веб-сервера</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Путь</th><th>Ошибка</th></tr>
      ${err24.slice(-15).reverse().map((e) => `<tr><td class="muted">${fmt(new Date(e.at).toISOString())}</td><td class="mini">${esc(e.path)}</td><td class="mini">${esc(String(e.msg).split('\n')[0].slice(0, 160))}</td></tr>`).join('')}
    </table></div></div>` : ''}
  ${slow24.length ? `<div class="card"><h2>Самые медленные запросы (за 24ч)</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>Путь</th><th>мс</th></tr>
      ${slow24.slice().sort((a, b) => b.ms - a.ms).slice(0, 15).map((e) => `<tr><td class="muted">${fmt(new Date(e.at).toISOString())}</td><td class="mini">${esc(e.path)}</td><td>${e.ms}</td></tr>`).join('')}
    </table></div></div>` : ''}
  <div class="card"><h2>Незакрытые очереди</h2><div class="grid">
    ${Object.entries(queues).map(([k, v]) => tile(v, k)).join('')}
  </div></div>
  <div class="card"><h2>Строк в таблицах</h2><div class="grid">
    ${await (async () => {
      const tbls = ['participants', 'extra_passports', 'applications', 'kicks', 'vacations', 'contracts', 'contract_uploads', 'invitations', 'blacklist', 'giveaways', 'tickets', 'audit_log', 'web_users', 'notifications'];
      const out = [];
      for (const t of tbls) { try { const r = await db.get(`SELECT COUNT(*) c FROM ${t}`); out.push(tile(r ? r.c : 0, t)); } catch (_) {} }
      return out.join('');
    })()}
  </div></div>`;
}

// ---------- Доски (визуальные схемы / оргструктуры, упрощённый аналог Miro) ----------
// Этап 1: доступ только у havirys. Данные — JSON в boards.data. Мультиплеер
// (WebSocket, курсоры) — отдельный этап 2, когда доски откроют другим.

function boardBlank(kind) {
  const nodes = kind === 'orgchart'
    ? [{ id: 'n1', x: 340, y: 40, w: 180, h: 56, text: 'Руководитель', parent: null, ref: null }]
    : [];
  return JSON.stringify({ nodes, edges: [], view: { zoom: 1, panX: 0, panY: 0 } });
}

// Безопасный разбор и нормализация модели (чужой ввод — из редактора).
function boardParse(str) {
  let o;
  try { o = JSON.parse(str || '{}'); } catch (_) { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const hex6 = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toLowerCase() : null;
  const nodes = (Array.isArray(o.nodes) ? o.nodes : []).slice(0, 800).map((n, i) => ({
    id: String((n && n.id) || ('n' + i)).slice(0, 40),
    x: Math.round(Number(n && n.x) || 0),
    y: Math.round(Number(n && n.y) || 0),
    w: Math.max(80, Math.min(1200, Math.round(Number(n && n.w) || 200))),
    h: Math.max(36, Math.min(1200, Math.round(Number(n && n.h) || 56))),
    text: String((n && n.text) || '').slice(0, 2000),
    color: hex6(n && n.color),
    fontSize: Math.max(9, Math.min(48, Math.round(Number(n && n.fontSize) || 14))),
    align: (n && n.align === 'left') ? 'left' : 'center',
    autoH: (n && n.autoH === false) ? false : true,
    parent: (n && n.parent) ? String(n.parent).slice(0, 40) : null,
    ref: (n && n.ref && n.ref.id)
      ? { type: n.ref.type === 'role' ? 'role' : 'user', id: String(n.ref.id).replace(/[^0-9]/g, '').slice(0, 25) }
      : null,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(o.edges) ? o.edges : []).slice(0, 1000).map((e, i) => ({
    id: String((e && e.id) || ('e' + i)).slice(0, 40),
    from: String((e && e.from) || '').slice(0, 40),
    to: String((e && e.to) || '').slice(0, 40),
  })).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  for (const n of nodes) if (n.parent && !ids.has(n.parent)) n.parent = null;
  const v = (o.view && typeof o.view === 'object') ? o.view : {};
  const view = {
    zoom: Math.max(0.2, Math.min(3, Number(v.zoom) || 1)),
    panX: Math.round(Number(v.panX) || 0),
    panY: Math.round(Number(v.panY) || 0),
  };
  return { nodes, edges, view };
}

// Раскладка оргструктуры сверху вниз по полю parent (простое tidy-дерево).
// Мутирует переданную модель: перезаписывает x/y/w/h узлов и edges.
function boardOrgLayout(model) {
  const nodes = model.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) { // разрываем циклы в цепочке родителей
    const chain = new Set([n.id]);
    let p = n.parent;
    while (p) {
      if (chain.has(p)) { n.parent = null; break; }
      chain.add(p);
      p = (byId.get(p) || {}).parent;
    }
  }
  const kids = new Map(nodes.map((n) => [n.id, []]));
  const roots = [];
  for (const n of nodes) {
    if (n.parent && kids.has(n.parent)) kids.get(n.parent).push(n.id);
    else roots.push(n.id);
  }
  const NW = 230, GX = 34, GY = 150, TOP = 40;
  let cursor = 40;
  const place = (id, depth) => {
    const n = byId.get(id);
    n.w = NW; n.h = Math.max(52, boardFitH(n.text, NW)); n.y = TOP + depth * GY;
    const ch = kids.get(id) || [];
    if (!ch.length) { n.x = cursor; cursor += NW + GX; return; }
    let first = null, last = null;
    for (const c of ch) { place(c, depth + 1); if (first === null) first = byId.get(c).x; last = byId.get(c).x; }
    n.x = Math.round((first + last) / 2);
  };
  for (const r of roots) { place(r, 0); cursor += GX; }
  model.edges = nodes.filter((n) => n.parent).map((n) => ({ id: 'e_' + n.parent + '_' + n.id, from: n.parent, to: n.id }));
  return model;
}

// Явный sans-стек: при рендере SVG в PNG вне страницы font-family:inherit даёт serif.
const BOARD_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,Helvetica,Arial,'Noto Sans','DejaVu Sans',sans-serif";
// Эмодзи / стрелки / пиктограммы / CJK — рендерятся примерно вдвое шире буквы.
function boardCharW(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x1F000 || (c >= 0x2190 && c <= 0x2BFF) || (c >= 0x2600 && c <= 0x27BF) || (c >= 0x3000 && c <= 0x9FFF) || c === 0x2022) return 2;
  return 1;
}
function boardStrW(s) { let w = 0; for (const ch of String(s || '')) w += boardCharW(ch); return w; }
function boardWrap(text, maxW) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const cand = line ? line + ' ' + w : w;
      if (line && boardStrW(cand) > maxW) { out.push(line); line = w; }
      else line = cand;
    }
    if (line) out.push(line);
  }
  return out.length ? out.slice(0, 16) : [''];
}
// Высота строки и «весовой лимит» строки — с учётом кегля.
function boardLineH(fs) { return Math.round((fs || 14) * 1.34); }
function boardMaxW(w, fs) { return Math.max(4, Math.floor((w - 24) / ((fs || 14) * 0.56))); }
// Нужная высота блока, чтобы весь текст поместился.
function boardFitH(text, w, fs) {
  return Math.max(Math.round((fs || 14) * 2.4), boardWrap(text, boardMaxW(w, fs)).length * boardLineH(fs) + 20);
}

// SSR-рендер доски в <svg> (страница просмотра и стартовый холст редактора).
function boardSvg(model, opts) {
  opts = opts || {};
  const m = (opts.layout && model.nodes.some((n) => n.parent))
    ? boardOrgLayout({ nodes: model.nodes.map((n) => ({ ...n })), edges: [] })
    : model;
  // высоту считаем по тексту (блок всегда вмещает содержимое), если не задана вручную
  const nodes = m.nodes.map((n) => {
    const fs = n.fontSize || 14;
    const head = /^#\s/.test(n.text || '');
    const text = head ? n.text.replace(/^#\s+/, '') : (n.text || '');
    const lines = boardWrap(text, boardMaxW(n.w, fs));
    const fitH = lines.length * boardLineH(fs) + 20;
    const _h = (n.autoH === false) ? Math.max(n.h || 40, 36) : Math.max(fitH, Math.round(fs * 2.4));
    return { ...n, _fs: fs, _head: head, _text: text, _lines: lines, _h };
  });
  const edges = m.edges;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n._h); }
  if (!nodes.length) { minX = 0; minY = 0; maxX = 480; maxY = 240; }
  const pad = 44;
  const vb = `${minX - pad} ${minY - pad} ${(maxX - minX) + pad * 2} ${(maxY - minY) + pad * 2}`;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const eEls = edges.map((e) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) return '';
    const ax = a.x + a.w / 2, ay = a.y + a._h, bx = b.x + b.w / 2, by = b.y, my = (ay + by) / 2;
    return `<path d="M${ax} ${ay} C ${ax} ${my}, ${bx} ${my}, ${bx} ${by - 8}" fill="none" stroke="var(--muted)" stroke-width="1.75" marker-end="url(#bar)"/>`;
  }).join('');
  const nEls = nodes.map((n) => {
    const lh = boardLineH(n._fs);
    const left = n.align === 'left';
    const tx = left ? n.x + 14 : n.x + n.w / 2;
    const ty = left ? n.y + 14 + n._fs : n.y + n._h / 2 - (n._lines.length - 1) * (lh / 2);
    const anchor = left ? 'start' : 'middle';
    const baseFill = n.color ? '#20242c' : 'var(--text)';
    const headFill = n.color ? '#20242c' : 'var(--accent2)';
    const tsp = n._lines.map((ln, i) => (i === 0 && n._head)
      ? `<tspan x="${tx}" dy="0" font-weight="700" fill="${headFill}">${esc(ln)}</tspan>`
      : `<tspan x="${tx}" dy="${i ? lh : 0}">${esc(ln)}</tspan>`).join('');
    const fill = n.color || 'var(--panel2)';
    const stroke = n.color ? 'rgba(0,0,0,.18)' : 'var(--line)';
    const clip = `bclip_${esc(n.id)}`;
    return `<g data-id="${esc(n.id)}">
      <clipPath id="${clip}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n._h}" rx="12"/></clipPath>
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n._h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.25" filter="url(#bsh)"/>
      ${(!n.color && !n._head) ? `<rect x="${n.x}" y="${n.y + 10}" width="4" height="${Math.max(0, n._h - 20)}" rx="2" fill="var(--accent)" fill-opacity=".65"/>` : ''}
      <text clip-path="url(#${clip})" x="${tx}" y="${ty}" text-anchor="${anchor}" ${left ? '' : 'dominant-baseline="middle"'} font-size="${n._fs}" fill="${baseFill}">${tsp}</text>
      ${n.ref ? `<circle cx="${n.x + n.w - 12}" cy="${n.y + 12}" r="3.5" fill="${n.color ? '#20242c' : 'var(--accent2)'}"></circle>` : ''}
    </g>`;
  }).join('');
  return `<svg class="bsvg" xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" font-family="${esc(BOARD_FONT)}">
    <defs>
      <marker id="bar" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker>
      <filter id="bsh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.28"/></filter>
    </defs>
    ${eEls}${nEls}
  </svg>`;
}

function boardsListBody(rows, user, showArch, bacc) {
  const canCreate = user && (user.id === OWNER_ID || (bacc && bacc.rank >= LEVELS.deputy));
  const cards = rows.map((b) => {
    const kindL = b.kind === 'orgchart' ? '🌳 оргструктура' : '🖊️ свободная';
    const ed = b._mode === 'edit';
    return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0">
      <div>
        <div style="font-weight:700;font-size:15px">${esc(b.title || 'Без названия')}${b.onboarding ? ' <span class="badge">🖼 в профиль новичку</span>' : ''}</div>
        <div class="mini">${kindL} · v${b.version || 1} · изменено ${fmt(b.updated_at)} · ${ed ? '✏️ можно редактировать' : '👁 только просмотр'}</div>
      </div>
      <div class="bar" style="margin:0">
        ${showArch ? `<form method="POST" action="/board/${b.id}/unarchive" style="display:inline">${csrfField(user)}<button class="btn ghost sm" type="submit">Вернуть из архива</button></form>` : `
        ${ed ? `<a class="btn sm" href="/board/${b.id}/edit">Открыть</a>` : ''}
        <a class="btn ghost sm" href="/board/${b.id}">Просмотр</a>
        <a class="btn ghost sm" href="/board/${b.id}/versions">Версии</a>
        ${ed ? `<a class="btn ghost sm" href="/board/${b.id}/settings">Настройки</a>` : ''}`}
      </div>
    </div>`;
  }).join('');
  return `<h1>Доски</h1>
  <p class="muted">Визуальные схемы и оргструктуры. havirys видит все и всё может; остальным доска открывается по гранту (просмотр / редактирование).</p>
  ${!showArch && canCreate ? `<div class="card"><h2>Новая доска</h2>
    <form method="POST" action="/board/create" class="form">${csrfField(user)}
      <label>Название<input name="title" maxlength="80" placeholder="Оргструктура организации" required></label>
      <label>Тип
        <select name="kind">
          <option value="freeform">Свободная доска (блоки и стрелки вручную)</option>
          <option value="orgchart">Оргструктура (дерево, автораскладка)</option>
        </select>
      </label>
      <button class="btn" type="submit">Создать</button>
    </form>
  </div>` : ''}
  ${cards || `<div class="card muted">${showArch ? 'В архиве пусто.' : 'Пока нет доступных досок.'}</div>`}
  ${user && user.id === OWNER_ID ? `<p class="mini">${showArch ? '<a href="/boards">← активные доски</a>' : '<a href="/boards?arch=1">Архив</a>'}</p>` : ''}`;
}

function boardViewBody(board, user, canEdit) {
  const model = boardParse(board.data);
  const svg = boardSvg(model, { layout: board.kind === 'orgchart' });
  return `<div class="bar" style="justify-content:space-between">
      <h1 style="margin:0">${esc(board.title || 'Доска')}</h1>
      <div class="bar" style="margin:0">
        ${canEdit ? `<a class="btn sm" href="/board/${board.id}/edit">Редактировать</a>` : ''}
        <a class="btn ghost sm" href="/board/${board.id}/export.json">Экспорт JSON</a>
        <a class="btn ghost sm" href="/boards">← к списку</a>
      </div>
    </div>
    ${board.onboarding ? '<div class="card" style="border-color:var(--accent2)"><b>🖼 Памятка новичку.</b> PNG этой доски прикладывается к сообщению при создании профиля. Обнови PNG кнопкой «Сохранить» в редакторе.</div>' : ''}
    <div class="card" style="padding:0;overflow:hidden"><div id="bview" class="bview">${svg}</div></div>
    <p class="mini">Колесо — масштаб, перетаскивание — панорама.${board.image_file ? ` · <a href="/board/${board.id}/image.png" target="_blank" rel="noopener">PNG-снимок</a>` : ''}</p>
    <script>${BOARD_VIEW_JS}</script>`;
}

function boardEditBody(board, user) {
  const model = boardParse(board.data);
  const payload = JSON.stringify({ id: board.id, kind: board.kind, version: board.version || 1, model })
    .replace(/</g, '\\u003c');
  return `<div class="beditbar">
      <a class="btn ghost sm" href="/boards">←</a>
      <b>${esc(board.title || 'Доска')}</b>
      <span class="mini">${board.kind === 'orgchart' ? 'оргструктура' : 'свободная'}</span>
      <span class="beditsp"></span>
      <button class="btn sm" type="button" data-act="add">+ блок</button>
      <button class="btn ghost sm" type="button" data-act="connect">↳ связь</button>
      <button class="btn ghost sm" type="button" data-act="undo">↶</button>
      <button class="btn ghost sm" type="button" data-act="redo">↷</button>
      <button class="btn ghost sm" type="button" data-act="fit">⤢ вписать</button>
      <span class="beditsp"></span>
      <button class="btn sm" type="button" data-act="save" id="bsave">Сохранить</button>
      <span class="mini" id="bstatus"></span>
      <span class="beditsp"></span>
      <button class="btn ghost sm" type="button" data-act="png">PNG</button>
      <a class="btn ghost sm" href="/board/${board.id}/export.json">JSON</a>
      <a class="btn ghost sm" href="/board/${board.id}/versions">версии</a>
    </div>
    <div class="beditwrap">
      <div id="bcanvas" class="bcanvas">
        <div id="bctx" class="bctx" hidden></div>
        <div id="bedit" class="bedit" contenteditable="true" spellcheck="false" hidden></div>
      </div>
      <div id="binspect" class="binspect" hidden>
        <div class="mini">Выбранный блок</div>
        <textarea id="bi_text" rows="3" placeholder="текст блока (или дв. клик по блоку)"></textarea>
        <label class="mini" id="bi_parentrow" hidden>Подчинён<select id="bi_parent"></select></label>
        <label class="mini">Ссылка на Discord — ID участника/роли<input id="bi_ref" maxlength="25" inputmode="numeric" placeholder="напр. 652927337016328212"></label>
        <label class="mini">Тип ссылки<select id="bi_reftype"><option value="user">участник</option><option value="role">роль</option></select></label>
        <div class="bar" style="margin:4px 0 0">
          <button class="btn ghost sm" type="button" id="bi_dup">Дублировать</button>
          <button class="btn ghost sm" type="button" id="bi_del" style="color:var(--bad)">Удалить</button>
        </div>
      </div>
    </div>
    <p class="mini">Двойной клик по блоку — редактировать текст. Тащить угол/край выделенного — менять размер. Плашка над блоком — цвет, кегль, выравнивание. Двойной клик по пустому месту — новый блок. «↳ связь» — соединить/разорвать. Колесо — масштаб. Del — удалить блок. Ctrl+S — сохранить.</p>
    <form method="POST" action="/board/${board.id}/save" id="bform" style="display:none">${csrfField(user)}</form>
    <script>window.__BOARD__=${payload};</script>
    <script src="/board-editor.js"></script>`;
}

const BOARD_LEVEL_LABELS = { member: 'Участники (member+)', hr: 'HR-менеджеры (hr+)', deputy: 'Заместители (deputy+)', owner: 'Владельцы (owner)' };
function boardSettingsBody(board, user, grants, isOwner) {
  const grRows = (grants || []).map((g) => {
    const who = g.subject_type === 'user' ? ('участник ' + esc(g.subject_id)) : esc(BOARD_LEVEL_LABELS[g.subject_id] || g.subject_id);
    return `<tr><td>${who}</td><td>${g.mode === 'edit' ? '✏️ редактирование' : '👁 просмотр'}</td>
      <td><form method="POST" action="/board/${board.id}/grant_del" style="display:inline">${csrfField(user)}<input type="hidden" name="grant_id" value="${g.id}"><button class="btn ghost sm" type="submit">убрать</button></form></td></tr>`;
  }).join('');
  return `<h1>Настройки доски</h1>
  <div class="card">
    <form method="POST" action="/board/${board.id}/settings" class="form">${csrfField(user)}
      <label>Название<input name="title" maxlength="80" value="${esc(board.title || '')}"></label>
      <label>Тип
        <select name="kind">
          <option value="freeform"${board.kind !== 'orgchart' ? ' selected' : ''}>Свободная доска</option>
          <option value="orgchart"${board.kind === 'orgchart' ? ' selected' : ''}>Оргструктура (автораскладка)</option>
        </select>
      </label>
      <p class="mini">В режиме «оргструктура» позиции блоков считаются автоматически по полю «Подчинён»; вручную нарисованные стрелки не показываются.</p>
      <label class="chk"><input type="checkbox" name="onboarding" value="1"${board.onboarding ? ' checked' : ''}> Отправлять PNG этой доски новичку при создании профиля</label>
      <p class="mini">Такой может быть только одна доска. PNG пересобирается ТОЛЬКО когда открываешь доску в редакторе и жмёшь «Сохранить». Пока свежего PNG нет — новичку уходит текст без картинки.</p>
      <button class="btn" type="submit">Сохранить</button>
    </form>
  </div>
  ${isOwner && BOARD_SEEDS.some((s) => s.slug === board.slug) ? `<div class="card" style="border-color:var(--warn)">
    <h2>Стандартное содержимое</h2>
    <p class="mini">Это стандартная доска (<code>${esc(board.slug)}</code>). Кнопка вернёт её содержимое к актуальному шаблону из кода и сбросит PNG-снимок — потом открой в редакторе и нажми «Сохранить», чтобы пересобрать картинку.</p>
    <form method="POST" action="/board/${board.id}/reseed" onsubmit="return confirm('Заменить всё содержимое доски стандартным шаблоном? Текущая версия сохранится в истории.')">${csrfField(user)}
      <button class="btn sm" type="submit">🔄 Восстановить стандартное содержимое</button>
    </form>
  </div>` : ''}
  ${isOwner ? `<div class="card">
    <h2>Доступ к доске</h2>
    <p class="mini">havirys всегда имеет полный доступ. Ниже — кому ещё открыта доска.</p>
    <div class="tablewrap"><table><tr><th>Кому</th><th>Режим</th><th></th></tr>${grRows || '<tr><td colspan="3">Только havirys.</td></tr>'}</table></div>
    <form method="POST" action="/board/${board.id}/grant_add" class="form" style="margin-top:12px">${csrfField(user)}
      <div class="bar">
        <select name="subject_type" onchange="var f=this.form;f.querySelector('[data-w=level]').style.display=this.value==='user'?'none':'';f.querySelector('[data-w=user]').style.display=this.value==='user'?'':'none';">
          <option value="level">Уровень доступа</option>
          <option value="user">Конкретный участник</option>
        </select>
        <span data-w="level"><select name="subject_level">
          <option value="member">Участники (member+)</option>
          <option value="hr">HR-менеджеры (hr+)</option>
          <option value="deputy">Заместители (deputy+)</option>
          <option value="owner">Владельцы (owner)</option>
        </select></span>
        <span data-w="user" style="display:none"><input name="subject_user" maxlength="25" inputmode="numeric" placeholder="Discord ID участника"></span>
        <select name="mode"><option value="view">просмотр</option><option value="edit">редактирование</option></select>
        <button class="btn sm" type="submit">Дать доступ</button>
      </div>
    </form>
  </div>` : ''}
  <div class="card"><div class="bar" style="margin:0">
    <a class="btn ghost sm" href="/board/${board.id}/edit">← в редактор</a>
    <form method="POST" action="/board/${board.id}/archive" style="display:inline">${csrfField(user)}<button class="btn ghost sm" type="submit">В архив</button></form>
    ${isOwner ? `<form method="POST" action="/board/${board.id}/delete" style="display:inline" onsubmit="return confirm('Удалить доску без возможности восстановления?')">${csrfField(user)}<button class="btn ghost sm" type="submit" style="color:var(--bad)">Удалить</button></form>` : ''}
  </div></div>`;
}

function boardVersionsBody(board, vs, user, canEdit) {
  const rows = vs.map((v) => `<tr>
    <td>v${v.version}</td>
    <td class="muted">${fmt(v.saved_at)}</td>
    <td>${canEdit ? `<form method="POST" action="/board/${board.id}/restore" style="display:inline" onsubmit="return confirm('Восстановить v${v.version}? Текущее состояние станет новой версией.')">${csrfField(user)}<input type="hidden" name="version_id" value="${v.id}"><button class="btn ghost sm" type="submit">Восстановить</button></form>` : '—'}</td>
  </tr>`).join('');
  return `<h1>Версии — ${esc(board.title || 'Доска')}</h1>
  <p><a href="/board/${board.id}${canEdit ? '/edit' : ''}">← ${canEdit ? 'в редактор' : 'к доске'}</a></p>
  <div class="card"><div class="tablewrap"><table>
    <tr><th>Версия</th><th>Сохранена</th><th></th></tr>
    ${rows || '<tr><td colspan="3">Пока одна версия.</td></tr>'}
  </table></div></div>`;
}

// Доступ пользователя к доске: 'edit' | 'view' | null. havirys — всегда 'edit'.
async function boardAccess(client, user, board) {
  if (!user || !board) return null;
  if (user.id === OWNER_ID) return 'edit';
  const grants = await db.all('SELECT subject_type, subject_id, mode FROM board_grants WHERE board_id = ?', [board.id]).catch(() => []);
  if (!grants.length) return null;
  const acc = await accessFor(client, user.id).catch(() => ({ level: 'guest' }));
  let best = null;
  for (const g of grants) {
    let hit = false;
    if (g.subject_type === 'user') {
      hit = g.subject_id === user.id
        || (user.localId && g.subject_id === user.localId)
        || (user.oauthDiscordId && g.subject_id === user.oauthDiscordId);
    } else {
      hit = (LEVELS[acc.level] || 0) >= (LEVELS[g.subject_id] || 99);
    }
    if (hit) { if (g.mode === 'edit') return 'edit'; best = 'view'; }
  }
  return best;
}

// ---- Стандартные доски: сидятся при старте (идемпотентно по slug) ----
// Это КАРТА СТРУКТУРЫ САЙТА для настройки, а не гайды для участников.
// Форматы узла:
//   'строка'            — авто-стек в один столбец (x=40, w=560);
//   [col, 'строка']     — авто-стек в столбец col (0..N), w=280;
//   [x, y, 'строка', w] — явные координаты (для схем со стрелками).
// Высота блока считается по тексту автоматически (boardFitH).
const BOARD_SEED_VERSION = 5; // ↑ при правке содержимого — нетронутые доски (version<=1) обновятся
const BOARD_SEEDS = [
  {
    slug: 'site-map', title: 'Карта сайта — страницы по уровням', kind: 'freeform',
    grants: [['level', 'member', 'view'], ['level', 'hr', 'edit']],
    nodes: [
      [0, 'ГОСТЬ — без входа'],
      [0, '/ — лендинг (заголовок, текст, кнопки)'],
      [0, '/login · /register · /forgot · /account'],
      [0, '/faq — гайды и поиск'],
      [0, '/text/rules · /text/agitation'],
      [0, '/p/<slug> — доп. страницы, если опубликованы'],
      [1, 'УЧАСТНИК (member) — есть паспорт'],
      [1, '/me — личный кабинет: паспорт, контракты, отпуск, тикеты, заявка в HR, экспорт'],
      [1, '/people · /u/<id> — участники и профили'],
      [1, '/giveaways · /g/<id> — розыгрыши'],
      [1, '/commands — команды бота по тирам'],
      [1, '/boards — доски (по гранту на доску)'],
      [1, '/notifications · /search · /calendar · /leaderboards · /compare'],
      [1, '/ticket/<id> — свой тикет'],
      [2, 'HR И ВЫШЕ (hr)'],
      [2, '/dashboard — статистика и здоровье системы'],
      [2, '/tickets — все тикеты'],
      [2, '/audit — журнал действий'],
      [2, '/panel — панель управления (вкладки в столбце справа)'],
      [2, 'Заместитель (deputy): + массовые действия в /people, создание досок'],
      [2, 'Владелец роль (owner): + все вкладки панели, черновики страниц'],
      [3, 'ПАНЕЛЬ /panel — вкладки (HR+ или точечный грант)'],
      [3, 'apps · queues · contracts_check · role_check — очереди и проверка'],
      [3, 'overview · sla · members · contracts · invites · hr_payouts — аналитика'],
      [3, 'forms · giveaways · faq_manage · texts · reasons · broadcast — контент'],
      [3, 'blacklist — чёрный список'],
      [4, 'HAVIRYS — плюс только эти вкладки панели'],
      [4, 'data — редактор БД (любые таблицы, откат правок)'],
      [4, 'accounts — локальные аккаунты и привязка к паспорту'],
      [4, 'grants — выдача вкладок панели ролям и людям'],
      [4, 'perms — тиры команд бота'],
      [4, 'admin — бренд, тексты, меню, цвета, тема'],
      [4, 'landing — блоки главной страницы'],
      [4, 'pages — доп. страницы /p/<slug>'],
      [4, 'settings — флаги функций, автобэкап, ключи'],
      [4, '/tools · откат правок БД из /audit'],
    ],
  },
  {
    slug: 'access-model', title: 'Модель доступа', kind: 'freeform',
    grants: [['level', 'member', 'view'], ['level', 'deputy', 'edit']],
    nodes: [
      'МОДЕЛЬ ДОСТУПА. Уровень вычисляет accessFor() из Discord-ролей. По возрастанию: guest, member, hr, deputy, owner, havirys.',
      'guest — публичные страницы: лендинг, вход и регистрация, FAQ, правила, опубликованные доп. страницы.',
      'member — выдаётся, если у человека есть паспорт (строка в participants). Открывает /me, /people, /giveaways, /commands, /boards, свои тикеты.',
      'hr — роль ROLE_HR. Плюс /dashboard, /tickets, /audit и вкладки панели из набора GRANTABLE_TABS.',
      'deputy — роль ROLE_DEPUTY. Плюс массовые действия в /people и создание досок.',
      'owner — роль ROLE_OWNER (или бот-доступ). Плюс весь набор вкладок панели.',
      'havirys — Discord ID 652927337016328212 = config.OWNER_USER_ID. Плюс инфраструктурные вкладки: data, accounts, grants, perms, admin, landing, pages.',
      'Точечная выдача: havirys на /panel?tab=grants даёт роли или конкретному человеку отдельные вкладки панели, можно со сроком действия.',
      'Доски: доступ отдельно, таблица board_grants — по уровню (member/hr/deputy/owner) или по человеку, режим просмотр или редактирование. Настройка на /board/<id>/settings.',
    ],
  },
  {
    slug: 'admin-controls', title: 'Где что настраивается', kind: 'freeform',
    grants: [['level', 'deputy', 'view'], ['level', 'owner', 'edit']],
    nodes: [
      'ИСТОЧНИКИ НАСТРОЕК: 1) таблица settings — правится на сайте, применяется сразу или в течение часа; 2) config.js — правится в коде, нужен перезапуск; 3) board_grants и panel_grants — доступы.',
      '/panel?tab=admin — название организации, ссылка-приглашение, заголовок и текст главной, подвал, меню сайта (SITE.nav), свой CSS.',
      '/panel?tab=admin — цвета сайта: 11 переменных и 21 готовый пресет темы. Светлая тема остаётся стандартной.',
      '/panel?tab=landing — плитки-блоки на главной странице (landing_blocks).',
      '/panel?tab=pages — произвольные страницы /p/<slug>: черновик и публикация, отложенная публикация, версии и дифф.',
      '/panel?tab=settings — переключатели функций: приём заявок (applications), приём контрактов по скринам (contracts), напоминания SLA/отпуска/HR (reminders).',
      '/panel?tab=settings — время ежедневного автобэкапа (ключ backup.time) и любые произвольные ключи settings.',
      '/panel?tab=perms — тир каждой команды бота и синхронизация видимости команд в Discord.',
      '/panel?tab=grants — кому открыты вкладки панели: роль или человек, срок действия, пресеты наборов.',
      '/panel?tab=accounts — локальные логины: привязка к паспорту, сброс пароля по заявке.',
      'config.js (перезапуск): STUCK_CONTRACT_HOURS, CONTRACT_ABANDON_DAYS, REVIEW_SLA_HOURS, VACATION_REMINDER_HOURS, HR_REMINDER_INTERVAL_DAYS.',
      'config.js: WEEKLY_PROMOTION_CONTRACT_THRESHOLD (контрактов на повышение), WEEKLY_RANK_ADJUSTMENT_DAY, CODEWORD_REFUND_AMOUNT, HR_PAYOUT_CONFIRMED, HR_PAYOUT_OTHER.',
      'config.js: ENABLE_PRESENCE (онлайн-точки, нужен привилегированный интент), BADGE_AUTO_ROLES, ROLE_* и CHANNEL_* — id ролей и каналов.',
      'Доски: /boards → «Настройки доски» — доступ (гранты) и флаг «отправлять PNG новичку в профиль».',
    ],
  },
  {
    slug: 'panel-tabs', title: 'Панель: все вкладки', kind: 'freeform',
    grants: [['level', 'hr', 'view'], ['level', 'owner', 'edit']],
    nodes: [
      [0, 'РАБОТА С ОЧЕРЕДЯМИ — HR+ или грант вкладки'],
      [0, 'apps — заявки на вступление: принять/отклонить, шаблоны причин, комментарии, массовое отклонение, добавить вручную'],
      [0, 'queues — прочие очереди: паспорта, изменение данных, отпуска, апелляции, кодовые слова, заявки в HR'],
      [0, 'contracts_check — вердикт по контрактам + список «в работе» с кнопкой снять'],
      [0, 'role_check — сверка Discord-ролей с паспортами'],
      [0, 'blacklist — чёрный список организации'],
      [1, 'АНАЛИТИКА И КОНТЕНТ — HR+ или грант вкладки'],
      [1, 'overview · sla — сводка и просроченные задачи'],
      [1, 'members · contracts · invites — списки и статистика'],
      [1, 'hr_payouts — выплаты HR за принятых участников'],
      [1, 'giveaways — создать разовый и повторяющийся розыгрыш'],
      [1, 'forms — конструктор форм и разбор поданных заявок'],
      [1, 'faq_manage · texts · reasons — гайды, тексты, причины отказа'],
      [1, 'broadcast — массовая рассылка в личные сообщения'],
      [2, 'ИНФРАСТРУКТУРА — только havirys'],
      [2, 'data — редактор БД: любые таблицы, откат правок'],
      [2, 'accounts — локальные аккаунты и привязка'],
      [2, 'grants — выдача вкладок панели'],
      [2, 'perms — тиры команд бота'],
      [2, 'admin — бренд, тексты, меню, цвета, тема'],
      [2, 'landing — блоки главной страницы'],
      [2, 'pages — доп. страницы /p/<slug>'],
      [2, 'settings — флаги функций, автобэкап, произвольные ключи'],
    ],
  },
  {
    slug: 'onboarding', title: 'Памятка новичка', kind: 'freeform', onboarding: 1,
    grants: [['level', 'member', 'view']],
    nodes: [
      'ДОБРО ПОЖАЛОВАТЬ! Это ваш профиль-канал — присылайте сюда только скриншоты контрактов.',
      'По каждому контракту нужно 2 скриншота на весь экран: 1 — когда ВЗЯЛИ контракт, 2 — когда ВЫПОЛНИЛИ или не выполнили.',
      'Можно одним сообщением, можно двумя подряд. Бот сам соберёт пару и отправит карточку руководству на проверку.',
      'Итог проверки: засчитан, не засчитан или «не контракт». Придёт уведомление, всё видно в личном кабинете на сайте — /me.',
      'Один незакрытый контракт на паспорт. Не бросайте взятый: через 2 дня он сгорит автоматически, либо его раньше снимет руководство.',
      'Личный кабинет /me — паспорт, контракты, отпуск, тикеты, уведомления.',
      'Вопросы — команда /сайт в Discord или тикет на сайте.',
    ],
  },
];

function boardSeedModel(seed) {
  const colY = {};
  let stackY = 30;
  const nodes = seed.nodes.map((a, i) => {
    let x, y, w, text;
    if (typeof a === 'string') {
      x = 40; w = 560; text = a; y = stackY;
      stackY += boardFitH(text, w) + 22;
    } else if (a.length === 2 && typeof a[0] === 'number') {
      const col = a[0]; text = a[1]; w = 280; x = 30 + col * 312;
      y = (colY[col] == null ? 30 : colY[col]);
      colY[col] = y + boardFitH(text, w) + 16;
    } else {
      x = a[0]; y = a[1]; text = a[2]; w = a[3] || 320;
    }
    return { id: 'n' + i, x, y, w, h: boardFitH(text, w), text, parent: null, ref: null };
  });
  if (seed.kind === 'orgchart' && seed.edges) {
    for (const [f, t] of seed.edges) if (nodes[t] && !nodes[t].parent) nodes[t].parent = nodes[f].id;
  }
  const edges = (seed.kind === 'orgchart' ? [] : (seed.edges || [])).map((e, i) => ({ id: 'e' + i, from: 'n' + e[0], to: 'n' + e[1] }));
  return { nodes, edges, view: { zoom: 1, panX: 0, panY: 0 } };
}

// Сидинг стандартных досок. Новые — создаёт; нетронутые (version <= 1) —
// обновляет содержимым при росте BOARD_SEED_VERSION. Отредактированные не трогает.
async function seedBoards() {
  let cur = 0;
  try { cur = parseInt((await db.getSetting('boards_seed_version')) || '0', 10) || 0; } catch (_) {}
  const refresh = cur < BOARD_SEED_VERSION;
  for (const s of BOARD_SEEDS) {
    try {
      const ex = await db.get('SELECT id, version FROM boards WHERE slug = ?', [s.slug]);
      const data = JSON.stringify(boardParse(JSON.stringify(boardSeedModel(s))));
      const now = new Date().toISOString();
      if (ex) {
        if (refresh && (ex.version || 1) <= 1) {
          await db.run('UPDATE boards SET title = ?, kind = ?, data = ?, onboarding = ?, image_file = NULL, updated_at = ? WHERE id = ?',
            [s.title, s.kind, data, s.onboarding ? 1 : 0, now, ex.id]);
          console.log(`[доски] обновлена стандартная доска «${s.title}»`);
        }
        continue;
      }
      const r = await db.run(
        "INSERT INTO boards (slug, title, kind, data, visibility, onboarding, archived, version, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, 'owner', ?, 0, 1, ?, ?, ?, ?)",
        [s.slug, s.title, s.kind, data, s.onboarding ? 1 : 0, OWNER_ID, now, OWNER_ID, now],
      );
      for (const gr of (s.grants || [])) {
        await db.run(
          'INSERT INTO board_grants (board_id, subject_type, subject_id, mode, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
          [r.lastID, gr[0], gr[1], gr[2], OWNER_ID, now],
        ).catch(() => {});
      }
      console.log(`[доски] создана стандартная доска «${s.title}»`);
    } catch (e) {
      console.error('[доски] не удалось создать/обновить доску', s.slug, e.message);
    }
  }
  if (refresh) {
    // Убираем стандартные доски прошлых версий, которых больше нет в списке
    // и которые не редактировали вручную (version <= 1).
    try {
      const keep = BOARD_SEEDS.map((s) => s.slug);
      const ph = keep.map(() => '?').join(',');
      const stale = await db.all(
        `SELECT id, slug FROM boards WHERE slug IS NOT NULL AND slug != '' AND version <= 1 AND slug NOT IN (${ph})`,
        keep,
      ).catch(() => []);
      for (const b of stale) {
        await db.run('DELETE FROM boards WHERE id = ?', [b.id]).catch(() => {});
        await db.run('DELETE FROM board_versions WHERE board_id = ?', [b.id]).catch(() => {});
        await db.run('DELETE FROM board_grants WHERE board_id = ?', [b.id]).catch(() => {});
        console.log(`[доски] удалена устаревшая стандартная доска «${b.slug}»`);
      }
    } catch (_) {}
    try { await db.setSetting('boards_seed_version', String(BOARD_SEED_VERSION)); } catch (_) {}
  }
}

// Пан/зум для страницы просмотра доски (только чтение).
const BOARD_VIEW_JS = `(function(){
  var box=document.getElementById('bview'); if(!box) return;
  var svg=box.querySelector('svg'); if(!svg) return;
  var p=(svg.getAttribute('viewBox')||'0 0 800 500').split(' ').map(Number);
  var x=p[0],y=p[1],w=p[2],h=p[3];
  function set(){ svg.setAttribute('viewBox',x+' '+y+' '+w+' '+h); }
  box.addEventListener('wheel',function(e){ e.preventDefault();
    var r=box.getBoundingClientRect(), mx=x+(e.clientX-r.left)/r.width*w, my=y+(e.clientY-r.top)/r.height*h;
    var k=e.deltaY>0?1.1:0.9; w*=k; h*=k;
    x=mx-(e.clientX-r.left)/r.width*w; y=my-(e.clientY-r.top)/r.height*h; set();
  },{passive:false});
  var drag=null;
  box.addEventListener('pointerdown',function(e){ drag={px:e.clientX,py:e.clientY,x:x,y:y}; try{box.setPointerCapture(e.pointerId);}catch(_){}});
  box.addEventListener('pointermove',function(e){ if(!drag) return; var r=box.getBoundingClientRect();
    x=drag.x-(e.clientX-drag.px)/r.width*w; y=drag.y-(e.clientY-drag.py)/r.height*h; set(); });
  box.addEventListener('pointerup',function(){ drag=null; });
  box.addEventListener('pointercancel',function(){ drag=null; });
})();`;

// Редактор досок целиком (без внешних зависимостей). Отдаётся как /board-editor.js.
// ВНИМАНИЕ: это шаблонная строка web.js — внутри нельзя использовать обратные
// кавычки и подстановки шаблонных строк; спецсимволы regex/строк удваиваем.
const BOARD_EDITOR_JS = `'use strict';
(function(){
var D=window.__BOARD__; if(!D){ return; }
var NS='http://www.w3.org/2000/svg';
var boardId=D.id, kind=D.kind, model=D.model, serverVersion=D.version;
var canvas=document.getElementById('bcanvas');
var inspect=document.getElementById('binspect');
var statusEl=document.getElementById('bstatus');
var bar=document.querySelector('.beditbar');
var bctx=document.getElementById('bctx');
var bedit=document.getElementById('bedit');
if(!canvas){ return; }

var dirty=false, mode='select', connectFrom=null, sel=null;
var undoStack=[], redoStack=[];
var view={ x:20, y:20, k:1 };
var pan=null, ndrag=null, resize=null, editing=null, editSnap=null;
var COLORS=['#fff9b1','#d5f692','#a6ccf5','#f7c6d9','#e2c3f7','#ffd8a8','#ffb3b3','#c8e6c9'];
var FONT="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,Helvetica,Arial,'Noto Sans','DejaVu Sans',sans-serif";

var svg=document.createElementNS(NS,'svg');
svg.setAttribute('class','beditsvg');
svg.setAttribute('font-family',FONT);
var defs=document.createElementNS(NS,'defs');
defs.innerHTML='<marker id="bea" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker><filter id="besh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.28"/></filter>';
var gEdges=document.createElementNS(NS,'g');
var gNodes=document.createElementNS(NS,'g');
svg.appendChild(defs); svg.appendChild(gEdges); svg.appendChild(gNodes);
canvas.appendChild(svg);

function uid(p){ return p+Math.random().toString(36).slice(2,8); }
function byId(id){ for(var i=0;i<model.nodes.length;i++){ if(model.nodes[i].id===id) return model.nodes[i]; } return null; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function oneline(s){ return String(s||'').replace(/\\s+/g,' ').trim().slice(0,40)||'(без текста)'; }
function setStatus(t){ if(statusEl) statusEl.textContent=t||''; }
function markDirty(){ dirty=true; setStatus('не сохранено'); }
function cssv(name,fb){ var v=getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v||fb; }

function screenToWorld(sx,sy){
  var r=canvas.getBoundingClientRect();
  return { x:(sx-r.left-view.x)/view.k, y:(sy-r.top-view.y)/view.k };
}
function applyView(){
  var t='translate('+view.x+','+view.y+') scale('+view.k+')';
  gEdges.setAttribute('transform',t); gNodes.setAttribute('transform',t);
  placeCtx();
}

function snapshot(){ return JSON.stringify(model); }
function pushUndo(){ undoStack.push(snapshot()); if(undoStack.length>80) undoStack.shift(); redoStack.length=0; markDirty(); }
function undo(){ if(!undoStack.length) return; commitEdit(); redoStack.push(snapshot()); model=JSON.parse(undoStack.pop()); sel=null; render(); dirty=true; setStatus('не сохранено'); }
function redo(){ if(!redoStack.length) return; commitEdit(); undoStack.push(snapshot()); model=JSON.parse(redoStack.pop()); sel=null; render(); dirty=true; setStatus('не сохранено'); }

function isDescendant(id, ancestorId){
  var n=byId(id), guard=0;
  while(n && n.parent && guard++<300){ if(n.parent===ancestorId) return true; n=byId(n.parent); }
  return false;
}

// ---- перенос строк и высота с учётом кегля ----
function chW(ch){ var c=ch.codePointAt(0); return (c>=0x1F000||(c>=0x2190&&c<=0x2BFF)||(c>=0x2600&&c<=0x27BF)||(c>=0x3000&&c<=0x9FFF)||c===0x2022)?2:1; }
function strW(s){ var w=0,a=String(s||''); for(var i=0;i<a.length;i++) w+=chW(a[i]); return w; }
function lineH(fs){ return Math.round((fs||14)*1.34); }
function maxW(w,fs){ return Math.max(4, Math.floor((w-24)/((fs||14)*0.56))); }
function wrap(text,mw){
  var out=[];
  String(text||'').split('\\n').forEach(function(raw){
    var words=raw.split(/\\s+/).filter(Boolean);
    if(!words.length){ out.push(''); return; }
    var line='';
    words.forEach(function(w){
      var cand=line?line+' '+w:w;
      if(line&&strW(cand)>mw){ out.push(line); line=w; }
      else line=cand;
    });
    if(line) out.push(line);
  });
  return out.length?out.slice(0,40):[''];
}
function fitH(text,w,fs){ return Math.max(Math.round((fs||14)*2.4), wrap(text,maxW(w,fs)).length*lineH(fs)+20); }

function orgLayout(){
  var byid={}; model.nodes.forEach(function(n){ byid[n.id]=n; });
  model.nodes.forEach(function(n){
    var chain={}; chain[n.id]=1; var p=n.parent;
    while(p){ if(chain[p]){ n.parent=null; break; } chain[p]=1; p=byid[p]?byid[p].parent:null; }
  });
  var kids={}; model.nodes.forEach(function(n){ kids[n.id]=[]; });
  var roots=[];
  model.nodes.forEach(function(n){ if(n.parent&&kids[n.parent]) kids[n.parent].push(n.id); else roots.push(n.id); });
  var NW=240,GX=34,GY=155,TOP=40, cursor=40;
  function place(id,depth){
    var n=byid[id]; n.w=NW; n.h=Math.max(54,fitH(n.text,NW,n.fontSize)); n.y=TOP+depth*GY;
    var ch=kids[id]||[];
    if(!ch.length){ n.x=cursor; cursor+=NW+GX; return; }
    var first=null,last=null;
    ch.forEach(function(c){ place(c,depth+1); if(first===null)first=byid[c].x; last=byid[c].x; });
    n.x=Math.round((first+last)/2);
  }
  roots.forEach(function(r){ place(r,0); cursor+=GX; });
  model.edges=model.nodes.filter(function(n){ return n.parent; }).map(function(n){ return { id:'e_'+n.parent+'_'+n.id, from:n.parent, to:n.id }; });
}

function measure(n){
  var fs=n.fontSize||14;
  var head=/^#\\s/.test(n.text||'');
  var txt=head?n.text.replace(/^#\\s+/,''):(n.text||'');
  var lines=wrap(txt, maxW(n.w,fs));
  var dh=(n.autoH===false)?Math.max(n.h||40,40):Math.max(lines.length*lineH(fs)+20, Math.round(fs*2.4));
  n._fs=fs; n._head=head; n._lines=lines; n._dh=dh;
}

function render(skipInspect){
  if(kind==='orgchart') orgLayout();
  model.nodes.forEach(measure);
  gEdges.textContent=''; gNodes.textContent='';
  model.edges.forEach(function(e){
    var a=byId(e.from), b=byId(e.to); if(!a||!b) return;
    var ax=a.x+a.w/2, ay=a.y+(a._dh||a.h), bx=b.x+b.w/2, by=b.y, my=(ay+by)/2;
    var d='M'+ax+' '+ay+' C '+ax+' '+my+', '+bx+' '+my+', '+bx+' '+(by-8);
    if(kind!=='orgchart'){
      var hit=document.createElementNS(NS,'path');
      hit.setAttribute('d',d); hit.setAttribute('class','beedge'); hit.style.cursor='pointer'; hit.setAttribute('data-eid',e.id);
      hit.setAttribute('fill','none'); hit.setAttribute('stroke','var(--muted)'); hit.setAttribute('stroke-opacity','0');
      hit.setAttribute('stroke-width','18'); hit.setAttribute('pointer-events','stroke');
      var vt=document.createElementNS(NS,'title'); vt.textContent='клик — удалить связь'; hit.appendChild(vt);
      var vis=document.createElementNS(NS,'path');
      vis.setAttribute('d',d); vis.setAttribute('fill','none'); vis.setAttribute('stroke','var(--muted)'); vis.setAttribute('stroke-width','1.75'); vis.setAttribute('marker-end','url(#bea)'); vis.style.pointerEvents='none';
      gEdges.appendChild(vis); gEdges.appendChild(hit);
    } else {
      var p=document.createElementNS(NS,'path');
      p.setAttribute('d',d); p.setAttribute('fill','none'); p.setAttribute('stroke','var(--muted)'); p.setAttribute('stroke-width','1.75'); p.setAttribute('marker-end','url(#bea)');
      gEdges.appendChild(p);
    }
  });
  model.nodes.forEach(function(n){
    var dh=n._dh, fs=n._fs, head=n._head, lines=n._lines, left=(n.align==='left');
    var g=document.createElementNS(NS,'g'); g.setAttribute('class','benode'+(sel===n.id?' sel':'')); g.setAttribute('data-id',n.id);
    var rect=document.createElementNS(NS,'rect');
    rect.setAttribute('x',n.x); rect.setAttribute('y',n.y); rect.setAttribute('width',n.w); rect.setAttribute('height',dh); rect.setAttribute('rx','12');
    rect.setAttribute('fill', n.color||'var(--panel2)');
    rect.setAttribute('stroke', sel===n.id?'var(--accent)':(n.color?'rgba(0,0,0,.18)':'var(--line)'));
    rect.setAttribute('stroke-width', sel===n.id?'2':'1.25');
    rect.setAttribute('filter','url(#besh)');
    g.appendChild(rect);
    if(!n.color && !head){
      var strip=document.createElementNS(NS,'rect');
      strip.setAttribute('x',n.x); strip.setAttribute('y',n.y+10); strip.setAttribute('width',4); strip.setAttribute('height',Math.max(0,dh-20));
      strip.setAttribute('rx',2); strip.setAttribute('fill','var(--accent)'); strip.setAttribute('fill-opacity','.65');
      g.appendChild(strip);
    }
    var clip=document.createElementNS(NS,'clipPath'); clip.setAttribute('id','bec_'+n.id);
    var cr=document.createElementNS(NS,'rect'); cr.setAttribute('x',n.x); cr.setAttribute('y',n.y); cr.setAttribute('width',n.w); cr.setAttribute('height',dh); cr.setAttribute('rx','12');
    clip.appendChild(cr); g.appendChild(clip);
    var tx=left?n.x+14:n.x+n.w/2;
    var lh=lineH(fs);
    var ty=left?(n.y+14+fs):(n.y+dh/2-(lines.length-1)*(lh/2));
    var t=document.createElementNS(NS,'text');
    t.setAttribute('x',tx); t.setAttribute('y',ty); t.setAttribute('text-anchor',left?'start':'middle');
    if(!left) t.setAttribute('dominant-baseline','middle');
    t.setAttribute('font-size',fs); t.setAttribute('fill', n.color?'#20242c':'var(--text)');
    t.setAttribute('clip-path','url(#bec_'+n.id+')');
    lines.forEach(function(ln,i){
      var ts=document.createElementNS(NS,'tspan'); ts.setAttribute('x',tx); ts.setAttribute('dy',i?lh:0); ts.textContent=ln;
      if(i===0&&head){ ts.setAttribute('font-weight','700'); ts.setAttribute('fill',n.color?'#20242c':'var(--accent2)'); }
      t.appendChild(ts);
    });
    g.appendChild(t);
    if(n.ref&&n.ref.id){
      var c=document.createElementNS(NS,'circle');
      c.setAttribute('cx',n.x+n.w-12); c.setAttribute('cy',n.y+12); c.setAttribute('r','3.5'); c.setAttribute('fill',n.color?'#20242c':'var(--accent2)');
      g.appendChild(c);
    }
    gNodes.appendChild(g);
  });
  if(sel && !editing && mode!=='connect'){
    var sn=byId(sel);
    if(sn){
      var hs=Math.max(6, 9/view.k), dh2=sn._dh||sn.h;
      var pts=[['nw',sn.x,sn.y],['n',sn.x+sn.w/2,sn.y],['ne',sn.x+sn.w,sn.y],['e',sn.x+sn.w,sn.y+dh2/2],['se',sn.x+sn.w,sn.y+dh2],['s',sn.x+sn.w/2,sn.y+dh2],['sw',sn.x,sn.y+dh2],['w',sn.x,sn.y+dh2/2]];
      pts.forEach(function(pt){
        var hr=document.createElementNS(NS,'rect');
        hr.setAttribute('x',pt[1]-hs/2); hr.setAttribute('y',pt[2]-hs/2); hr.setAttribute('width',hs); hr.setAttribute('height',hs);
        hr.setAttribute('rx',hs*0.25); hr.setAttribute('class','bhandle'); hr.setAttribute('data-h',pt[0]);
        gNodes.appendChild(hr);
      });
    }
  }
  applyView();
  placeCtx();
  if(!skipInspect) syncInspect();
}

// ---- плашка над блоком (цвет / кегль / выравнивание) ----
function buildCtx(){
  if(!bctx || bctx._built) return;
  var h='';
  for(var i=0;i<COLORS.length;i++) h+='<button class="sw" data-c="'+COLORS[i]+'" style="background:'+COLORS[i]+'"></button>';
  h+='<button class="sw" data-c="" style="background:var(--panel2)" title="без цвета">×</button>';
  h+='<span class="sep"></span><button data-a="fsm" title="мельче">A−</button><button data-a="fsp" title="крупнее">A+</button>';
  h+='<span class="sep"></span><button data-a="all" title="по левому краю">⯇</button><button data-a="alc" title="по центру">≡</button>';
  h+='<span class="sep"></span><button data-a="edit" title="править текст">✎</button><button data-a="dup" title="дублировать">⧉</button><button data-a="del" title="удалить" style="color:var(--bad)">🗑</button>';
  bctx.innerHTML=h; bctx._built=true;
  bctx.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
  bctx.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('button'):null; if(!b) return;
    var n=sel&&byId(sel); if(!n) return;
    if(b.hasAttribute('data-c')){ pushUndo(); n.color=b.getAttribute('data-c')||null; render(); return; }
    var a=b.getAttribute('data-a');
    if(a==='edit'){ startEdit(sel); return; }
    if(a==='dup'){ dupSel(); return; }
    if(a==='del'){ delSelected(); return; }
    pushUndo();
    if(a==='fsm') n.fontSize=Math.max(9,(n.fontSize||14)-2);
    else if(a==='fsp') n.fontSize=Math.min(48,(n.fontSize||14)+2);
    else if(a==='all') n.align='left';
    else if(a==='alc') n.align='center';
    render();
  });
}
function placeCtx(){
  if(!bctx) return;
  var n=(sel && !editing && mode!=='connect')?byId(sel):null;
  if(!n){ bctx.hidden=true; return; }
  buildCtx();
  bctx.hidden=false;
  // отметить активный цвет
  var sws=bctx.querySelectorAll('.sw');
  for(var i=0;i<sws.length;i++){ sws[i].className='sw'+((sws[i].getAttribute('data-c')||null)===(n.color||null)?' on':''); }
  var sx=n.x*view.k+view.x, sy=n.y*view.k+view.y, sw=n.w*view.k;
  var cw=bctx.offsetWidth||300, ch=bctx.offsetHeight||36;
  var r=canvas.getBoundingClientRect();
  var left=Math.max(6, Math.min(r.width-cw-6, sx+sw/2-cw/2));
  var top=sy-ch-10;
  if(top<6) top=sy+(n._dh||n.h)*view.k+10;
  bctx.style.left=left+'px'; bctx.style.top=top+'px';
}

// ---- редактирование текста прямо в блоке ----
function startEdit(id){
  var n=byId(id); if(!n) return;
  commitEdit();
  sel=id; editing=id; editSnap=snapshot();
  render(true);
  if(!bedit) return;
  var sx=n.x*view.k+view.x, sy=n.y*view.k+view.y;
  bedit.hidden=false;
  bedit.style.left=sx+'px'; bedit.style.top=sy+'px';
  bedit.style.width=(n.w*view.k)+'px';
  bedit.style.minHeight=((n._dh||n.h)*view.k)+'px';
  bedit.style.fontSize=((n.fontSize||14)*view.k)+'px';
  bedit.style.fontFamily=FONT;
  bedit.style.textAlign=(n.align==='left')?'left':'center';
  bedit.style.background=n.color||cssv('--panel2','#1e2025');
  bedit.style.color=n.color?'#20242c':cssv('--text','#e9e9ee');
  bedit.innerText=n.text||'';
  bedit.focus();
  try{ var rg=document.createRange(); rg.selectNodeContents(bedit); var s=window.getSelection(); s.removeAllRanges(); s.addRange(rg); }catch(_){}
  placeCtx();
}
function commitEdit(){
  if(!editing || !bedit) { editing=null; return; }
  var n=byId(editing);
  var v=bedit.innerText.replace(/\\r/g,'').slice(0,2000);
  if(n && v!==n.text){
    if(editSnap){ undoStack.push(editSnap); if(undoStack.length>80) undoStack.shift(); redoStack.length=0; }
    n.text=v; markDirty();
  }
  editing=null; editSnap=null; bedit.hidden=true;
  render();
}
if(bedit){
  bedit.addEventListener('blur',commitEdit);
  bedit.addEventListener('pointerdown',function(e){ e.stopPropagation(); });
  bedit.addEventListener('keydown',function(e){
    if(e.key==='Escape'){ e.preventDefault(); commitEdit(); }
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); commitEdit(); save(); }
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); commitEdit(); }
  });
}

function syncInspect(){
  var n=sel?byId(sel):null;
  if(!n || editing){ inspect.hidden=true; return; }
  inspect.hidden=false;
  var ti=document.getElementById('bi_text');
  if(document.activeElement!==ti) ti.value=n.text||'';
  var pr=document.getElementById('bi_parentrow');
  if(kind==='orgchart'){
    pr.hidden=false;
    var sc=document.getElementById('bi_parent');
    var opts='<option value="">— нет (корень) —</option>';
    model.nodes.forEach(function(m){
      if(m.id===n.id || isDescendant(m.id,n.id)) return;
      opts+='<option value="'+esc(m.id)+'"'+(n.parent===m.id?' selected':'')+'>'+esc(oneline(m.text))+'</option>';
    });
    sc.innerHTML=opts;
  } else { pr.hidden=true; }
  document.getElementById('bi_ref').value=(n.ref&&n.ref.id)||'';
  document.getElementById('bi_reftype').value=(n.ref&&n.ref.type)||'user';
}

function addNodeAt(wx,wy,edit){
  pushUndo();
  var n={ id:uid('n'), x:Math.round(wx/8)*8, y:Math.round(wy/8)*8, w:200, h:56, text:'Текст', color:null, fontSize:14, align:'center', autoH:true, parent:null, ref:null };
  model.nodes.push(n); sel=n.id; render();
  if(edit!==false) setTimeout(function(){ startEdit(n.id); },0);
}
function dupSel(){
  var n=sel&&byId(sel); if(!n) return;
  pushUndo();
  var c=JSON.parse(JSON.stringify(n)); c.id=uid('n'); c.x=(n.x||0)+24; c.y=(n.y||0)+24;
  if(kind!=='orgchart') c.parent=null;
  model.nodes.push(c); sel=c.id; render();
}
function delSelected(){
  if(!sel) return;
  commitEdit();
  pushUndo();
  model.nodes=model.nodes.filter(function(n){ return n.id!==sel; });
  model.nodes.forEach(function(n){ if(n.parent===sel) n.parent=null; });
  model.edges=model.edges.filter(function(e){ return e.from!==sel && e.to!==sel; });
  sel=null; render();
}
function addEdge(from,to){
  if(from===to) return;
  var dup=model.edges.filter(function(e){ return (e.from===from&&e.to===to)||(e.from===to&&e.to===from); });
  pushUndo();
  if(dup.length){
    model.edges=model.edges.filter(function(e){ return dup.indexOf(e)<0; });
    setStatus('связь между блоками убрана');
  } else {
    model.edges.push({ id:uid('e'), from:from, to:to });
    setStatus('связь добавлена');
  }
  render();
}
function fit(){
  var r=canvas.getBoundingClientRect(), pad=40;
  model.nodes.forEach(measure);
  if(!model.nodes.length){ view={x:pad,y:pad,k:1}; applyView(); return; }
  var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  model.nodes.forEach(function(n){ minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+n.w); maxY=Math.max(maxY,n.y+(n._dh||n.h)); });
  var bw=Math.max(1,maxX-minX), bh=Math.max(1,maxY-minY);
  var k=Math.min((r.width-pad*2)/bw,(r.height-pad*2)/bh,2);
  k=Math.max(0.15,Math.min(2,k||1));
  view.k=k;
  view.x=(r.width-bw*k)/2-minX*k;
  view.y=(r.height-bh*k)/2-minY*k;
  applyView();
}

var SAVE_ERR={ csrf:'сессия формы устарела — обновите страницу', forbidden:'нет доступа', notfound:'доска не найдена', too_big:'слишком большая доска', bad_json:'ошибка данных — не сохранено', bad_shape:'ошибка данных — не сохранено' };
function renderBoardPng(cb){
  commitEdit();
  var keepSel=sel; sel=null; render(true); // без выделения и ручек в PNG
  var bb=computeBBox(), pad=30, W=Math.max(1,bb.w+pad*2), H=Math.max(1,bb.h+pad*2);
  var clone=svg.cloneNode(true);
  sel=keepSel; render(true);
  clone.setAttribute('xmlns',NS);
  clone.setAttribute('width',W); clone.setAttribute('height',H);
  clone.setAttribute('viewBox',(bb.x-pad)+' '+(bb.y-pad)+' '+W+' '+H);
  for(var i=0;i<clone.childNodes.length;i++){ var ch=clone.childNodes[i]; if(ch.tagName==='g') ch.removeAttribute('transform'); }
  var s=new XMLSerializer().serializeToString(clone);
  s=s.replace(/var\\(--(bg|panel|panel2|line|text|muted|accent|accent2|ok|bad|warn)\\)/g,function(_m,k){ return cssv('--'+k,'#888'); });
  var src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent('<?xml version="1.0"?>'+s)));
  var img=new Image();
  img.onload=function(){
    var scl=2, cnv=document.createElement('canvas'); cnv.width=W*scl; cnv.height=H*scl;
    var cx=cnv.getContext('2d'); cx.fillStyle=cssv('--bg','#0f1013'); cx.fillRect(0,0,cnv.width,cnv.height);
    cx.drawImage(img,0,0,cnv.width,cnv.height);
    cnv.toBlob(function(blob){ cb(blob||null); });
  };
  img.onerror=function(){ cb(null); };
  img.src=src;
}
function blobToDataUrl(blob,cb){
  try{ var fr=new FileReader(); fr.onload=function(){ cb(String(fr.result||'')); }; fr.onerror=function(){ cb(''); }; fr.readAsDataURL(blob); }
  catch(e){ cb(''); }
}
function postSave(pngDataUrl){
  var btn=document.getElementById('bsave');
  var form=document.getElementById('bform');
  var csrfEl=form?form.querySelector('input[name=_csrf]'):null;
  var body='_csrf='+encodeURIComponent(csrfEl?csrfEl.value:'')+'&data='+encodeURIComponent(JSON.stringify(model));
  if(pngDataUrl && pngDataUrl.length<4000000) body+='&png='+encodeURIComponent(pngDataUrl);
  fetch('/board/'+boardId+'/save',{ method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body, credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(btn) btn.disabled=false;
      if(j&&j.ok){ dirty=false; serverVersion=j.version; setStatus('сохранено (v'+j.version+') '+new Date().toLocaleTimeString()); try{ localStorage.removeItem('fc_board_'+boardId); }catch(e){} }
      else setStatus('не сохранено: '+(SAVE_ERR[j&&j.err]||(j&&j.err)||'ошибка'));
    })
    .catch(function(){ if(btn) btn.disabled=false; setStatus('ошибка сети — не сохранено'); });
}
function save(){
  commitEdit();
  var btn=document.getElementById('bsave'); if(btn) btn.disabled=true; setStatus('сохранение…');
  if(JSON.stringify(model).length>2500000){ if(btn) btn.disabled=false; setStatus('доска слишком большая — не сохранено'); return; }
  try{
    renderBoardPng(function(blob){
      if(!blob){ postSave(null); return; }
      blobToDataUrl(blob,function(u){ postSave(u||null); });
    });
  }catch(e){ postSave(null); }
}
function computeBBox(){
  model.nodes.forEach(measure);
  var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  model.nodes.forEach(function(n){ minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+n.w); maxY=Math.max(maxY,n.y+(n._dh||n.h)); });
  if(!model.nodes.length){ minX=0;minY=0;maxX=400;maxY=200; }
  return { x:minX, y:minY, w:maxX-minX, h:maxY-minY };
}
function exportPng(){
  setStatus('готовлю PNG…');
  renderBoardPng(function(blob){
    if(!blob){ setStatus('не удалось сделать PNG'); return; }
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='board-'+boardId+'.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); },2000);
    setStatus('PNG сохранён');
  });
}

canvas.addEventListener('wheel',function(e){
  if(e.target.closest && e.target.closest('#bctx,#bedit')) return;
  e.preventDefault();
  if(editing) commitEdit();
  var r=canvas.getBoundingClientRect();
  var wx=(e.clientX-r.left-view.x)/view.k, wy=(e.clientY-r.top-view.y)/view.k;
  var k2=view.k*(e.deltaY>0?0.9:1.1); k2=Math.max(0.15,Math.min(3,k2));
  view.x=(e.clientX-r.left)-wx*k2; view.y=(e.clientY-r.top)-wy*k2; view.k=k2;
  applyView();
},{passive:false});

canvas.addEventListener('pointerdown',function(e){
  if(e.target.closest && e.target.closest('#bctx,#bedit')) return;
  var hDir=e.target.getAttribute && e.target.getAttribute('data-h');
  if(hDir && sel){
    var rn=byId(sel);
    if(rn){ pushUndo(); resize={ id:sel, dir:hDir, x0:e.clientX, y0:e.clientY, ow:rn.w, oh:(rn._dh||rn.h), ox:rn.x, oy:rn.y }; try{ canvas.setPointerCapture(e.pointerId); }catch(_){} }
    return;
  }
  if(editing) commitEdit();
  var eEl=e.target && e.target.closest ? e.target.closest('.beedge') : null;
  var edge=eEl ? eEl.getAttribute('data-eid') : (e.target && e.target.getAttribute && e.target.getAttribute('data-eid'));
  if(edge){ pushUndo(); model.edges=model.edges.filter(function(x){ return x.id!==edge; }); render(); setStatus('связь удалена (Ctrl+Z — вернуть)'); return; }
  var g=e.target.closest ? e.target.closest('.benode') : null;
  if(mode==='connect'){
    if(g){
      var id=g.getAttribute('data-id');
      if(!connectFrom){ connectFrom=id; setStatus('связь: выберите второй блок (повторно между теми же — разорвать)'); }
      else if(connectFrom!==id){ addEdge(connectFrom,id); connectFrom=null; mode='select'; }
    }
    return;
  }
  if(g){
    var n=byId(g.getAttribute('data-id')); if(!n) return;
    sel=n.id; render();
    var w0=screenToWorld(e.clientX,e.clientY);
    ndrag={ id:n.id, dx:w0.x-n.x, dy:w0.y-n.y, moved:false, org:null };
    try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
  } else {
    sel=null; render();
    pan={ px:e.clientX, py:e.clientY, x:view.x, y:view.y };
    try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
  }
});
canvas.addEventListener('pointermove',function(e){
  if(pan){ view.x=pan.x+(e.clientX-pan.px); view.y=pan.y+(e.clientY-pan.py); applyView(); return; }
  if(resize){
    var rn=byId(resize.id); if(!rn) return;
    var dx=(e.clientX-resize.x0)/view.k, dy=(e.clientY-resize.y0)/view.k, d=resize.dir;
    if(d.indexOf('e')>=0) rn.w=Math.max(90,Math.round(resize.ow+dx));
    if(d.indexOf('w')>=0){ var nw=Math.max(90,Math.round(resize.ow-dx)); rn.x=Math.round(resize.ox+(resize.ow-nw)); rn.w=nw; }
    if(d.indexOf('s')>=0){ rn.autoH=false; rn.h=Math.max(40,Math.round(resize.oh+dy)); }
    if(d==='n'||d==='nw'||d==='ne'){ rn.autoH=false; var nh=Math.max(40,Math.round(resize.oh-dy)); rn.y=Math.round(resize.oy+(resize.oh-nh)); rn.h=nh; }
    render(true);
    return;
  }
  if(ndrag){
    var n=byId(ndrag.id); if(!n) return;
    if(!ndrag.moved){ pushUndo(); ndrag.moved=true; }
    if(kind==='orgchart'){
      var el=document.elementFromPoint(e.clientX,e.clientY);
      var tg=el&&el.closest?el.closest('.benode'):null;
      ndrag.org=(tg && tg.getAttribute('data-id')!==n.id) ? tg.getAttribute('data-id') : '__root__';
      setStatus(ndrag.org==='__root__'?'отпустите — блок станет корневым':'отпустите — подчинить выбранному');
    } else {
      var w=screenToWorld(e.clientX,e.clientY);
      n.x=Math.round((w.x-ndrag.dx)/8)*8; n.y=Math.round((w.y-ndrag.dy)/8)*8;
      render(true);
    }
  }
});
function endDrag(){
  if(ndrag && kind==='orgchart' && ndrag.moved && ndrag.org){
    var n=byId(ndrag.id);
    if(n){ if(ndrag.org==='__root__') n.parent=null; else if(!isDescendant(ndrag.org, n.id)) n.parent=ndrag.org; }
    render(); setStatus('не сохранено');
  } else if((ndrag && !ndrag.moved) || resize){
    render();
  }
  pan=null; ndrag=null; resize=null;
}
canvas.addEventListener('pointerup',endDrag);
canvas.addEventListener('pointercancel',endDrag);
canvas.addEventListener('dblclick',function(e){
  if(e.target.closest && e.target.closest('#bctx,#bedit')) return;
  var g=e.target.closest?e.target.closest('.benode'):null;
  if(g){ startEdit(g.getAttribute('data-id')); return; }
  var w=screenToWorld(e.clientX,e.clientY);
  addNodeAt(w.x,w.y);
});

if(bar) bar.addEventListener('click',function(e){
  var b=e.target.closest?e.target.closest('[data-act]'):null; if(!b) return;
  var a=b.getAttribute('data-act');
  if(a==='add'){ var r=canvas.getBoundingClientRect(); var w=screenToWorld(r.left+r.width/2,r.top+r.height/2); addNodeAt(w.x,w.y); }
  else if(a==='connect'){
    if(kind==='orgchart'){ setStatus('в оргрежиме связи задаются полем «Подчинён»'); return; }
    commitEdit();
    mode=(mode==='connect')?'select':'connect'; connectFrom=null;
    setStatus(mode==='connect'?'связь: выберите два блока — соединить или разорвать':'');
    render();
  }
  else if(a==='undo'){ undo(); }
  else if(a==='redo'){ redo(); }
  else if(a==='fit'){ fit(); }
  else if(a==='save'){ save(); }
  else if(a==='png'){ exportPng(); }
});

var textTimer=null;
document.getElementById('bi_text').addEventListener('input',function(){
  var n=sel&&byId(sel); if(!n) return;
  n.text=this.value.slice(0,2000); markDirty();
  clearTimeout(textTimer); textTimer=setTimeout(function(){ render(true); },220);
});
document.getElementById('bi_parent').addEventListener('change',function(){
  var n=sel&&byId(sel); if(!n) return;
  pushUndo(); n.parent=this.value||null; render();
});
function applyRef(){
  var n=sel&&byId(sel); if(!n) return;
  var id=document.getElementById('bi_ref').value.replace(/[^0-9]/g,'').slice(0,25);
  n.ref=id?{ type:document.getElementById('bi_reftype').value==='role'?'role':'user', id:id }:null;
  markDirty(); render(true);
}
document.getElementById('bi_ref').addEventListener('change',applyRef);
document.getElementById('bi_reftype').addEventListener('change',applyRef);
document.getElementById('bi_dup').addEventListener('click',dupSel);
document.getElementById('bi_del').addEventListener('click',delSelected);

document.addEventListener('keydown',function(e){
  if(editing){
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); commitEdit(); save(); }
    return;
  }
  var tag=(e.target&&e.target.tagName)||'';
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  var k=e.key.toLowerCase();
  if((e.key==='Delete'||e.key==='Backspace')&&sel){ e.preventDefault(); delSelected(); }
  else if((e.key==='Enter'||e.key==='F2')&&sel){ e.preventDefault(); startEdit(sel); }
  else if((e.ctrlKey||e.metaKey)&&k==='z'){ e.preventDefault(); if(e.shiftKey) redo(); else undo(); }
  else if((e.ctrlKey||e.metaKey)&&k==='y'){ e.preventDefault(); redo(); }
  else if((e.ctrlKey||e.metaKey)&&k==='s'){ e.preventDefault(); save(); }
  else if((e.ctrlKey||e.metaKey)&&k==='d'&&sel){ e.preventDefault(); dupSel(); }
});
window.addEventListener('beforeunload',function(e){ if(dirty){ e.preventDefault(); e.returnValue=''; } });
setInterval(function(){
  if(!dirty) return;
  try{ localStorage.setItem('fc_board_'+boardId, JSON.stringify({ v:serverVersion, at:Date.now(), model:model })); }catch(e){}
},5000);

try{
  var raw=localStorage.getItem('fc_board_'+boardId);
  if(raw){
    var dr=JSON.parse(raw);
    if(dr && dr.model && dr.v===serverVersion && window.confirm('Есть несохранённый черновик этой доски в браузере. Восстановить его?')){
      model=dr.model; dirty=true;
    } else { localStorage.removeItem('fc_board_'+boardId); }
  }
}catch(e){}

render();
fit();
setStatus(dirty?'восстановлен черновик — не сохранён':'');
})();`;

// ---------- FAQ + реакции ----------
async function faqBody(client, acc, user) {
  const cats = acc.rank >= LEVELS.hr ? ['public', 'member', 'hr']
    : acc.rank >= LEVELS.member ? ['public', 'member']
    : ['public'];
  const catTitle = { public: 'Для всех', member: 'Для участников', hr: 'Для HR' };
  const blocks = [];
  for (const cat of cats) {
    const entries = await db.all('SELECT * FROM faq_entries WHERE category = ? ORDER BY position, id', [cat]).catch(() => []);
    const items = [];
    for (const e of entries) {
      const up = await db.get('SELECT COUNT(*) c FROM faq_feedback WHERE entry_id = ? AND helpful = 1', [e.id]);
      const down = await db.get('SELECT COUNT(*) c FROM faq_feedback WHERE entry_id = ? AND helpful = 0', [e.id]);
      const mine = user ? await db.get('SELECT helpful FROM faq_feedback WHERE entry_id = ? AND discord_id = ?', [e.id, user.id]) : null;
      items.push(`<div class="card faq-item" data-faq="${esc(((e.title || '') + ' ' + (e.content || '')).toLowerCase())}">
        <h3>${esc(e.title)}</h3>
        ${mdToHtml((e.content || '').slice(0, 4000))}
        <form method="POST" action="/faq/vote" class="bar" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="id" value="${e.id}">
          <button class="btn ghost sm" name="v" value="1" ${mine && mine.helpful === 1 ? 'disabled' : ''}>👍 ${up ? up.c : 0}</button>
          <button class="btn ghost sm" name="v" value="0" ${mine && mine.helpful === 0 ? 'disabled' : ''}>👎 ${down ? down.c : 0}</button>
          ${mine ? '<span class="mini">ваш голос учтён</span>' : ''}
        </form>
      </div>`);
    }
    blocks.push(`<h2 style="margin-top:16px" class="faq-cat">${esc(catTitle[cat])}</h2>${items.join('') || '<div class="card">Пусто.</div>'}`);
  }
  return `<h1>FAQ / Гайды</h1>
    <div class="card" style="padding:14px 16px">
      <input id="faqf" type="search" autocomplete="off" spellcheck="false" placeholder="🔍 поиск по гайдам…" oninput="fcFaqFilter(this.value)">
      <div id="faqnone" class="mini" style="margin-top:8px;display:none">Ничего не найдено — попробуйте другой запрос.</div>
    </div>
    ${blocks.join('')}`;
}

// ---------- Бейджи и стрик (расчёт вынесен в badges.js — общий с ботом) ----------
async function computeBadgesAndStreak(client, targetId) {
  try {
    return await badges.compute(targetId);
  } catch (_) {
    return { badges: [], streak: 0, fulfilled: 0, wins: 0, invConfirmed: 0, days: 0 };
  }
}
function badgesCard(bs, pinnedCsv) {
  const pinned = new Set(String(pinnedCsv || '').split(',').map((s) => s.trim()).filter(Boolean));
  const fams = [
    { name: 'Контракты', cur: bs.fulfilled || 0, steps: [10, 50, 100], unit: 'контрактов' },
    { name: 'Приглашения', cur: bs.invConfirmed || 0, steps: [5, 15], unit: 'приглашённых' },
    { name: 'Стаж', cur: bs.days || 0, steps: [30, 90, 365], unit: 'дней в организации' },
    { name: 'Победы в розыгрышах', cur: bs.wins || 0, steps: [1, 3], unit: 'побед' },
    { name: 'Недельный стрик', cur: bs.streak || 0, steps: [2, 4], unit: 'недель подряд' },
  ];
  const progress = fams.map((f) => {
    const next = f.steps.find((s) => f.cur < s);
    if (!next) return `<div style="margin:8px 0"><div class="mini">${esc(f.name)} — всё открыто ✅</div></div>`;
    const prev = [0, ...f.steps].filter((s) => s <= f.cur).pop() || 0;
    const pct = Math.min(100, Math.round(((f.cur - prev) / (next - prev)) * 100));
    return `<div style="margin:10px 0">
      <div class="mini">${esc(f.name)}: <b>${f.cur}</b> / ${next} ${esc(f.unit)} — осталось ${next - f.cur}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
  const awardedAt = bs.awardedAt || {};
  const labels = bs.LABELS || {};
  let earnedKeys = bs.has ? Object.keys(bs.has).filter((k) => bs.has[k]) : [];
  earnedKeys = earnedKeys.sort((a, b) => (pinned.has(b) ? 1 : 0) - (pinned.has(a) ? 1 : 0));
  const earned = earnedKeys.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${earnedKeys.map((k) => {
        const d = awardedAt[k] ? fmt(awardedAt[k]) : null;
        const pin = pinned.has(k);
        return `<span class="pill" style="${pin ? 'border-color:var(--warn);color:var(--warn)' : ''}" ${d ? `title="получен ${esc(d)}"` : ''}>${pin ? '★ ' : ''}${esc(labels[k] || k)}${d ? ` <span class="mini">· ${esc(d)}</span>` : ''}</span>`;
      }).join('')}</div>`
    : '<span class="muted">Пока нет — выполняй контракты и приглашай друзей.</span>';
  return `<div class="card"><h2>Бейджи${bs.streak >= 2 ? ` · 🔥 стрик ${bs.streak} нед.` : ''}</h2>
    ${earned}
    <h3 style="margin-top:12px;font-size:14px">Прогресс к следующим</h3>
    ${progress}</div>`;
}

// ---------- Розыгрыши: список и участие с сайта ----------
async function giveawaysPublicBody(client) {
  const rows = await db.all("SELECT * FROM giveaways WHERE status = 'active' ORDER BY ends_at ASC");
  const list = [];
  for (const gv of rows) {
    const cnt = await giveaways.countEntries(gv.id);
    list.push(`<div class="card">
      <h3>🎉 ${esc(gv.prize)}</h3>
      <div class="mini">Победителей: ${gv.winners_count} · Участников: ${cnt}${gv.required_role_id ? ` · роль ${roleTag(client, gv.required_role_id)}` : ''}${gv.min_role_id ? ` · ранг не ниже ${roleTag(client, gv.min_role_id)}` : ''}${gv.min_contracts_week ? ` · ≥ ${gv.min_contracts_week} контр./нед.` : ''}${gv.weight_by_contracts ? ' · 🎟️ бонус-билеты за активность' : ''}</div>
      <div class="mini">До конца: <b class="gcd" data-end="${esc(gv.ends_at)}" style="font-variant-numeric:tabular-nums">…</b></div>
      <a class="btn sm" href="/g/${gv.id}" style="margin-top:8px">Открыть</a>
    </div>`);
  }
  const cd = `<script>(function(){
    function upd(){document.querySelectorAll('.gcd').forEach(function(el){
      var d=new Date(el.dataset.end).getTime()-Date.now();
      if(d<=0){el.textContent='завершается…';return;}
      var s=Math.floor(d/1000),dd=Math.floor(s/86400),hh=Math.floor(s%86400/3600),mm=Math.floor(s%3600/60),ss=s%60;
      el.textContent=(dd?dd+'д ':'')+String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0');
    });} upd(); setInterval(upd,1000);
  })();</script>`;
  return `<h1>Активные розыгрыши</h1>${list.join('') || '<div class="card">Сейчас розыгрышей нет.</div>'}${list.length ? cd : ''}`;
}

async function giveawayPageBody(client, user, gid, acc) {
  const gv = await giveaways.getGiveaway(gid);
  if (!gv) return '<div class="card">Розыгрыш не найден.</div><p><a href="/giveaways">← ко всем</a></p>';
  const cnt = await giveaways.countEntries(gv.id);
  const canSeeList = acc && acc.rank >= LEVELS.owner;
  let listCard = '';
  if (canSeeList) {
    const ents = await giveaways.getEntries(gv.id).catch(() => []);
    listCard = `<div class="card"><h2>Участники (${ents.length})</h2>${ents.length ? ents.map((e) => personLink(client, e)).join(', ') : '<span class="muted">пока никого</span>'}</div>`;
  }
  const inside = await giveaways.hasEntry(gv.id, user.id);
  const ended = gv.status !== 'active';
  let note = '';
  const g = guildOf(client);
  if (!ended && g) {
    try {
      const m = g.members.cache.get(user.id) || await g.members.fetch(user.id);
      if (await giveaways.isBlacklisted(user.id)) note = '⛔ Вы в ЧС розыгрышей.';
      else if (gv.required_role_id && !m.roles.cache.has(gv.required_role_id)) note = `⛔ Нужна роль ${roleTag(client, gv.required_role_id)}.`;
      else if (gv.min_role_id && !giveaways.meetsMinRole(m, gv.min_role_id)) note = `⛔ Нужен ранг не ниже ${roleTag(client, gv.min_role_id)}.`;
      else if (gv.min_contracts_week) {
        const wr = contracts.getWeekRange(0);
        const cw = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status='fulfilled' AND submitted_at BETWEEN ? AND ?", [user.id, wr.start.toISOString(), wr.end.toISOString()]).then((x) => (x ? x.c : 0)).catch(() => 0);
        if (cw < gv.min_contracts_week) note = `⛔ Нужно ≥ ${gv.min_contracts_week} выполненных контрактов за эту неделю (у вас ${cw}).`;
      }
    } catch (_) { note = 'Вас нет на Discord-сервере.'; }
  }
  const canToggle = !ended && !note;

  // Рулетка для завершённого розыгрыша с победителями
  let roulette = '';
  const winnerIds = (gv.winners || '').split(',').filter(Boolean);
  if (ended && winnerIds.length) {
    const entryIds = await giveaways.getEntries(gv.id).catch(() => []);
    const nameMap = {};
    const prows = await db.all('SELECT discord_id, name FROM participants').catch(() => []);
    for (const pr of prows) nameMap[pr.discord_id] = pr.name;
    const pool = (entryIds.length ? entryIds : winnerIds).map((idn) => nameMap[idn] || ('ID ' + idn));
    const winNames = winnerIds.map((idn) => nameMap[idn] || ('ID ' + idn));
    const reel = [];
    for (let i = 0; i < 40; i++) reel.push(pool[Math.floor(Math.random() * pool.length)] || '—');
    reel.push(winNames[0] || '—');
    roulette = `
    <div class="card">
      <div style="overflow:hidden;height:44px;border:1px solid var(--line);border-radius:10px;position:relative;background:var(--panel2)">
        <div id="reel" style="position:absolute;left:0;top:0;white-space:nowrap;transition:transform 3.2s cubic-bezier(.12,.8,.15,1)">
          ${reel.map((n) => `<span style="display:inline-block;padding:10px 22px;font-weight:700;border-right:1px solid var(--line)">${esc(n)}</span>`).join('')}
        </div>
        <div style="position:absolute;left:50%;top:0;bottom:0;width:2px;background:var(--accent)"></div>
      </div>
      <button class="btn sm" type="button" style="margin-top:10px" onclick="fcSpin()">🎲 Прокрутить</button>
      <p class="mini" id="reelout" style="margin-top:6px"></p>
    </div>
    <script>
    function fcSpin(){
      var r=document.getElementById('reel'); if(!r)return;
      r.style.transition='none'; r.style.transform='translateX(0)';
      void r.offsetWidth;
      var spans=r.children, last=spans[spans.length-1];
      var target=last.offsetLeft-(r.parentElement.clientWidth/2)+(last.clientWidth/2);
      r.style.transition='transform 3.2s cubic-bezier(.12,.8,.15,1)';
      r.style.transform='translateX(-'+target+'px)';
      setTimeout(function(){document.getElementById('reelout').textContent='🏆 '+${JSON.stringify(winNames.join(', '))};},3300);
    }
    setTimeout(fcSpin,400);
    </script>`;
  }

  const tiers = giveaways.parsePrizeTiers(gv.prize_tiers);
  const tiersCard = tiers.length ? `<div class="card"><h2>Призовые места</h2>
    <div class="tablewrap"><table><tr><th>Место</th><th>Приз</th>${gv.winners ? '<th>Кто</th>' : ''}</tr>
    ${tiers.map((t) => {
      const label = t.from === t.to ? `${t.from}` : `${t.from}–${t.to}`;
      const who = gv.winners ? `<td>${winnerIds.slice(t.from - 1, t.to).map((w) => personLink(client, w)).join(', ') || '—'}</td>` : '';
      return `<tr><td>${label} место</td><td><b>${esc(t.text)}</b></td>${who}</tr>`;
    }).join('')}
    </table></div></div>` : '';
  const cdScript = !ended ? `<script>(function(){
    var el=document.getElementById('gcd'); if(!el)return;
    var end=new Date(${JSON.stringify(gv.ends_at)}).getTime();
    function tick(){
      var d=end-Date.now();
      if(d<=0){el.textContent='розыгрыш завершается…';return;}
      var s=Math.floor(d/1000),dd=Math.floor(s/86400),hh=Math.floor(s%86400/3600),mm=Math.floor(s%3600/60),ss=s%60;
      el.textContent=(dd?dd+'д ':'')+String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0');
      setTimeout(tick,1000);
    } tick();
  })();</script>` : '';
  return `
  <h1>🎉 ${esc(gv.prize)}</h1>
  <div class="card">
    <div class="mini">Победителей: ${gv.winners_count} · Участников: <b>${cnt}</b> · ${ended ? 'Завершён' : 'Закончится ' + fmt(gv.ends_at)}</div>
    ${!ended ? `<div style="font-size:30px;font-weight:800;letter-spacing:1px;margin:10px 0;font-variant-numeric:tabular-nums" id="gcd">…</div>` : ''}
    ${gv.winners ? `<p style="margin-top:8px">Победители: ${winnerIds.map((w) => personLink(client, w)).join(', ')}</p>` : ''}
    ${note ? `<p class="mini" style="color:var(--bad);margin-top:8px">${note}</p>` : ''}
    ${canToggle ? `<form method="POST" action="/g/enter" style="margin-top:10px">${csrfField(user)}<input type="hidden" name="id" value="${gv.id}">
      <button class="btn" type="submit">${inside ? '❌ Выйти из розыгрыша' : '🎉 Участвовать'}</button></form>` : ''}
  </div>
  ${tiersCard}
  ${listCard}
  ${(acc && acc.rank >= LEVELS.owner) ? `<div class="card"><h2>Выдать роль всем участникам (${cnt})</h2>
    <p class="mini">Например, роль-«билет» на будущий розыгрыш. Выдаётся с паузами, чтобы не упереться в лимиты Discord.</p>
    <form method="POST" action="/g/grant_role" class="bar" onsubmit="return confirm('Выдать роль всем ${cnt} участникам розыгрыша?')">${csrfField(user)}<input type="hidden" name="id" value="${gv.id}">
      <input name="role_id" placeholder="ID роли" pattern="[0-9]{5,25}" required style="max-width:200px">
      <button class="btn sm" type="submit">Выдать всем</button>
    </form></div>` : ''}
  ${roulette}
  ${cdScript}
  <p><a href="/giveaways">← ко всем розыгрышам</a></p>`;
}

// ---------- Тикет целиком на сайте ----------
// ---------- Список тикетов для HR ----------
async function ticketsListBody(client, sp, user) {
  const st = sp.get('st') || 'open'; // open | archived | all
  const pri = sp.get('pri') || ''; // '' | high | normal | low
  const tag = (sp.get('tag') || '').trim().toLowerCase();
  const mine = sp.get('mine') === '1';
  const cond = []; const par = [];
  if (st === 'open') cond.push("status = 'open'");
  else if (st === 'archived') cond.push("status = 'archived'");
  if (pri === 'high' || pri === 'low') { cond.push('priority = ?'); par.push(pri); }
  else if (pri === 'normal') { cond.push('(priority IS NULL OR priority = ?)'); par.push('normal'); }
  if (tag) { cond.push("(',' || COALESCE(tags,'') || ',') LIKE ?"); par.push(`%,${tag},%`); }
  if (mine) { cond.push('assigned_to = ?'); par.push(user.id); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.all(`SELECT * FROM tickets ${where} ORDER BY (status='open') DESC, CASE priority WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END, id DESC LIMIT 200`, par).catch(() => []);
  // все известные метки (для быстрых кнопок)
  const allTagRows = await db.all("SELECT tags FROM tickets WHERE tags IS NOT NULL AND tags != ''").catch(() => []);
  const tagSet = new Set();
  for (const r of allTagRows) for (const x of r.tags.split(',').map((s) => s.trim()).filter(Boolean)) tagSet.add(x);
  const PRI = { high: '<span class="badge bad">высокий</span>', low: '<span class="badge">низкий</span>' };
  const tagPills = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<a class="pill" href="/tickets?${qs({ st, tag: x })}">${esc(x)}</a>`).join(' ');
  const trs = rows.map((t) => `<tr>
    <td>#${t.id}</td>
    <td><a href="/ticket/${t.id}">${esc(t.subject || 'Тикет')}</a>${t.tags ? `<div class="mini">${tagPills(t.tags)}</div>` : ''}</td>
    <td>${esc(TICKET_CAT_RU[t.category] || t.category || '—')}</td>
    <td>${onlineDot(client, t.opener_id)}${personLink(client, t.opener_id)}</td>
    <td>${PRI[t.priority] || '<span class="badge">обычный</span>'}</td>
    <td>${t.assigned_to ? personLink(client, t.assigned_to) : '<span class="mini">—</span>'}</td>
    <td>${t.status === 'open' ? '<span class="badge ok">открыт</span>' : '<span class="badge">закрыт</span>'}</td>
    <td class="muted">${fmt(t.closed_at || t.created_at)}</td>
  </tr>`).join('');
  const seg = (name, val, cur, label) => `<a class="btn ${val === cur ? '' : 'ghost '}sm" href="/tickets?${qs({ st: name === 'st' ? val : st, pri: name === 'pri' ? val : pri, ...(tag ? { tag } : {}), ...(mine ? { mine: '1' } : {}) })}">${esc(label)}</a>`;
  return `
  <h1>Тикеты</h1>
  <div class="bar"><span class="mini">Статус:</span>${seg('st', 'open', st, 'открытые')}${seg('st', 'archived', st, 'закрытые')}${seg('st', 'all', st, 'все')}</div>
  <div class="bar"><span class="mini">Приоритет:</span>${seg('pri', '', pri, 'любой')}${seg('pri', 'high', pri, 'высокий')}${seg('pri', 'normal', pri, 'обычный')}${seg('pri', 'low', pri, 'низкий')}</div>
  ${tagSet.size ? `<div class="bar"><span class="mini">Метки:</span>
    <a class="btn ${tag ? 'ghost ' : ''}sm" href="/tickets?${qs({ st, pri })}">все</a>
    ${[...tagSet].sort().map((x) => `<a class="btn ${tag === x ? '' : 'ghost '}sm" href="/tickets?${qs({ st, pri, tag: x })}">${esc(x)}</a>`).join('')}</div>` : ''}
  <div class="bar"><a class="btn ${mine ? '' : 'ghost '}sm" href="/tickets?${qs({ st, pri, ...(tag ? { tag } : {}), ...(mine ? {} : { mine: '1' }) })}">${mine ? '✓ только мои' : 'только мои'}</a></div>
  <div class="card"><h2>Найдено: ${rows.length}${tag ? ` · метка «${esc(tag)}»` : ''}</h2>
    <div class="tablewrap"><table>
      <tr><th>#</th><th>Тема</th><th>Тип</th><th>Автор</th><th>Приоритет</th><th>Ведёт</th><th>Статус</th><th>Обновлён</th></tr>
      ${trs || '<tr><td colspan="8">—</td></tr>'}
    </table></div>
  </div>`;
}

// Выкачивает все сообщения канала тикета (страницами по 100, до ~4000).
async function fetchAllTicketMessages(ch) {
  const out = [];
  let before;
  for (let i = 0; i < 40; i++) {
    const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch || !batch.size) break;
    const arr = [...batch.values()];
    out.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Собирает автономный HTML-транскрипт переписки тикета. Картинки — ссылками.
async function buildTicketTranscriptHtml(client, t) {
  const g = guildOf(client);
  if (!g) throw new Error('бот офлайн');
  const ch = await g.channels.fetch(t.channel_id);
  const msgs = await fetchAllTicketMessages(ch);
  const rows = msgs.map((m) => {
    const who = esc(m.member ? m.member.displayName : (m.author ? m.author.username : 'неизвестно'));
    const when = esc(fmt(new Date(m.createdTimestamp).toISOString()));
    const body = renderMentions(client, esc(m.content || '')).replace(/\n/g, '<br>');
    const atts = [...m.attachments.values()].map((a) => `<div class="att"><a href="${esc(a.url)}" target="_blank" rel="noopener">📎 ${esc(a.name || 'вложение')}</a></div>`).join('');
    const emb = m.embeds && m.embeds.length ? `<div class="att muted">[вложенных эмбедов: ${m.embeds.length}]</div>` : '';
    return `<div class="msg"><div class="meta"><b>${who}</b> · ${when}</div><div class="body">${body || '<span class="muted">—</span>'}${atts}${emb}</div></div>`;
  }).join('\n');
  const title = `Транскрипт тикета #${t.id} — ${esc(t.subject || 'без темы')}`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f1013;color:#e7e7ea;margin:0;padding:24px}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:19px;margin:0 0 4px} .sub{color:#9a9aa2;margin-bottom:18px;font-size:13px}
.msg{border-left:3px solid #2a2b31;padding:6px 0 6px 12px;margin:10px 0}
.meta{color:#9a9aa2;font-size:12px;margin-bottom:2px}
.body{white-space:normal;word-wrap:break-word}
.att{margin-top:4px;font-size:13px} .muted{color:#9a9aa2}
a{color:#8ea2ff}
</style></head><body><div class="wrap">
<h1>${title}</h1>
<div class="sub">Автор: ${esc(t.opener_id)} · создан ${esc(fmt(t.created_at))}${t.closed_at ? ` · закрыт ${esc(fmt(t.closed_at))}` : ''} · сообщений: ${msgs.length} · выгружено ${esc(fmt(new Date().toISOString()))}</div>
${rows || '<div class="muted">Сообщений нет.</div>'}
</div></body></html>`;
  return { html, count: msgs.length };
}

async function ticketPageBody(client, user, acc, tid) {
  const t = await db.get('SELECT * FROM tickets WHERE id = ?', [tid]);
  if (!t) return '<div class="card">Тикет не найден.</div><p><a href="/me">← в кабинет</a></p>';
  if (t.opener_id !== user.id && acc.rank < LEVELS.hr) return '<div class="card">Это не ваш тикет.</div><p><a href="/me">← в кабинет</a></p>';
  const g = guildOf(client);
  let msgsHtml = '<span class="muted">Сообщения недоступны.</span>';
  if (g) {
    try {
      const ch = await g.channels.fetch(t.channel_id);
      const coll = await ch.messages.fetch({ limit: 50 });
      const arr = [...coll.values()].reverse();
      msgsHtml = arr.map((m) => {
        const att = [...m.attachments.values()].map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">[вложение]</a>`).join(' ');
        const bodyHtml = renderMentions(client, esc(m.content || '')) + (att ? ' ' + att : '') + (m.embeds.length ? ' <span class="mini">[embed]</span>' : '');
        return `<div style="border-left:2px solid var(--line);padding-left:10px;margin:8px 0">
          <b>${esc(m.member ? m.member.displayName : m.author.username)}</b> <span class="mini">${fmt(new Date(m.createdTimestamp).toISOString())}</span><br>
          <span style="white-space:pre-wrap">${bodyHtml || '<span class="mini">—</span>'}</span></div>`;
      }).join('') || '<span class="muted">Пока пусто.</span>';
    } catch (_) {}
  }
  const closed = t.status !== 'open';
  const isStaff = acc.rank >= LEVELS.hr;
  const tpls = await db.all('SELECT id, name, text FROM ticket_reply_templates ORDER BY name').catch(() => []);
  const tplSelect = tpls.length ? `<div class="mini" style="margin-bottom:4px">Быстрые ответы:</div>
    <div class="bar" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">
      ${tpls.map((tp) => `<button type="button" class="btn ghost sm" data-tpl="${esc(tp.text)}" onclick="var ta=this.closest('form').text;ta.value=(ta.value?ta.value+'\\n':'')+this.dataset.tpl;ta.focus()">${esc(tp.name)}</button>`).join('')}
    </div>` : '';
  const tplManage = isStaff ? `<div class="card"><h2>Шаблоны ответов</h2>
    ${tpls.map((tp) => `<div class="bar"><span class="mini"><b>${esc(tp.name)}</b>: ${esc(tp.text.slice(0, 80))}</span>
      <form method="POST" action="/ticket/tpl_del" style="display:inline">${csrfField(user)}<input type="hidden" name="tid" value="${t.id}"><input type="hidden" name="id" value="${tp.id}"><button class="btn ghost sm" type="submit">✕</button></form></div>`).join('') || '<span class="mini">пусто</span>'}
    <form method="POST" action="/ticket/tpl_add" class="form" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="tid" value="${t.id}">
      <label>Название<input name="name" required maxlength="60"></label>
      <label>Текст<textarea name="text" rows="2" required maxlength="1500"></textarea></label>
      <button class="btn sm" type="submit">Добавить шаблон</button>
    </form></div>` : '';
  const isOpener = t.opener_id === user.id;
  const PRI = { high: '<span class="badge bad">высокий</span>', low: '<span class="badge">низкий</span>', normal: '<span class="badge">обычный</span>' };
  const priBadge = PRI[t.priority] || PRI.normal;
  let staffCard = '';
  if (isStaff) {
    const reasons = await db.all('SELECT id, text FROM ticket_close_reasons ORDER BY id').catch(() => []);
    const reasonOpts = reasons.map((rr) => `<option value="${esc(rr.text)}">${esc(rr.text.slice(0, 60))}</option>`).join('');
    const assignedLine = t.assigned_to
      ? `назначен: ${personLink(client, t.assigned_to)} <form method="POST" action="/ticket/assign" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${t.id}"><input type="hidden" name="clear" value="1"><button class="btn ghost sm" type="submit">снять</button></form>`
      : `<form method="POST" action="/ticket/assign" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${t.id}"><button class="btn ghost sm" type="submit">взять на себя</button></form>`;
    staffCard = `<div class="card"><h2>Управление (HR+)</h2>
      <form method="POST" action="/ticket/meta" class="form" style="margin-bottom:8px">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
        <label>Приоритет
          <select name="priority">
            ${['normal', 'high', 'low'].map((p) => `<option value="${p}" ${(t.priority || 'normal') === p ? 'selected' : ''}>${p === 'normal' ? 'обычный' : p === 'high' ? 'высокий' : 'низкий'}</option>`).join('')}
          </select></label>
        <label>Категория
          <select name="category">
            ${Object.entries(TICKET_CAT_RU).filter(([k]) => k !== 'appeal').map(([k, v]) => `<option value="${k}" ${t.category === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select></label>
        <label>Метки (через запятую)<input name="tags" value="${esc(t.tags || '')}" maxlength="200" placeholder="оплата, срочно, баг"></label>
        <button class="btn sm" type="submit">Сохранить</button>
      </form>
      <div class="bar" style="margin-bottom:8px">${assignedLine}</div>
      ${closed
        ? `<form method="POST" action="/ticket/reopen">${csrfField(user)}<input type="hidden" name="id" value="${t.id}"><button class="btn sm" type="submit">🔓 Переоткрыть тикет</button></form>
           ${t.close_reason ? `<p class="mini" style="margin-top:6px">Причина закрытия: ${esc(t.close_reason)}</p>` : ''}`
        : `<form method="POST" action="/ticket/close" class="form">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
             ${reasons.length ? `<label>Причина из шаблона<select onchange="if(this.value)this.form.reason.value=this.value"><option value="">— выбрать —</option>${reasonOpts}</select></label>` : ''}
             <label>Причина / комментарий<textarea name="reason" rows="2" maxlength="500"></textarea></label>
             <button class="btn" style="background:var(--bad)" type="submit">🔒 Закрыть тикет</button>
           </form>`}
    </div>
    <div class="card"><h2>Шаблоны причин закрытия</h2>
      ${reasons.map((rr) => `<div class="bar"><span class="mini">${esc(rr.text.slice(0, 90))}</span>
        <form method="POST" action="/ticket/close_reason_del" style="display:inline">${csrfField(user)}<input type="hidden" name="tid" value="${t.id}"><input type="hidden" name="id" value="${rr.id}"><button class="btn ghost sm" type="submit">✕</button></form></div>`).join('') || '<span class="mini">пусто</span>'}
      <form method="POST" action="/ticket/close_reason_add" class="bar" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="tid" value="${t.id}">
        <input name="text" placeholder="новая причина" maxlength="200" style="flex:1"><button class="btn ghost sm" type="submit">Добавить</button></form>
    </div>`;
  }
  let ratingCard = '';
  if (closed && isOpener) {
    if (t.rating == null) {
      ratingCard = `<div class="card"><h2>Оцените решение тикета</h2>
        <form method="POST" action="/ticket/rate" class="bar">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
          <button class="btn" name="r" value="1" type="submit">👍 Помогли</button>
          <button class="btn ghost" name="r" value="0" type="submit">👎 Не помогли</button>
        </form></div>`;
    } else {
      ratingCard = `<div class="card"><h2>Ваша оценка</h2>${t.rating ? '👍 помогли' : '👎 не помогли'} · ${fmt(t.rated_at)}</div>`;
    }
  } else if (closed && isStaff && t.rating != null) {
    ratingCard = `<div class="card"><h2>Оценка автора</h2>${t.rating ? '👍 помогли' : '👎 не помогли'} · ${fmt(t.rated_at)}</div>`;
  }
  const tr = await db.get('SELECT msg_count, created_at, generated_by FROM ticket_transcripts WHERE ticket_id = ?', [t.id]).catch(() => null);
  const transcriptCard = `<div class="card"><h2>Транскрипт переписки</h2>
    ${tr
      ? `<p class="mini">Сохранён ${fmt(tr.created_at)}${tr.generated_by ? ' · ' + personLink(client, tr.generated_by) : ''} · ${tr.msg_count} сообщ.</p>
         <a class="btn sm" href="/ticket/${t.id}/transcript" target="_blank" rel="noopener">Открыть транскрипт</a>`
      : '<p class="mini">Ещё не создан. Соберёт всю переписку канала в HTML-файл (картинки — ссылками).</p>'}
    <form method="POST" action="/ticket/transcript" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
      <button class="btn sm ghost" type="submit">${tr ? 'Пересобрать' : 'Сохранить переписку'}</button>
    </form>
  </div>`;
  return `
  <h1>🎫 ${esc(t.subject || 'Тикет')} #${t.id}</h1>
  <div class="muted">${esc(TICKET_CAT_RU[t.category] || t.category || '')} · ${closed ? 'закрыт' : 'открыт'} · приоритет ${priBadge} · автор ${personLink(client, t.opener_id)}${t.assigned_to ? ` · ведёт ${personLink(client, t.assigned_to)}` : ''}${t.tags ? ` · ${t.tags.split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<a class="pill" href="/tickets?tag=${encodeURIComponent(x)}">${esc(x)}</a>`).join(' ')}` : ''}</div>
  <div class="card">${msgsHtml}</div>
  ${closed ? '' : `<div class="card"><form method="POST" action="/ticket/post" class="form">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
    ${tplSelect}
    <label>Ваше сообщение<textarea name="text" rows="3" required maxlength="1800"></textarea></label>
    <button class="btn" type="submit">Отправить в тикет</button></form></div>`}
  ${staffCard}
  ${ratingCard}
  ${transcriptCard}
  ${tplManage}
  <p><a href="/me">← в кабинет</a></p>
  ${closed ? '' : `<script>(function(){var st=${JSON.stringify(t.status)};function chk(){fetch('/ticket/${t.id}/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){if(d&&d.status&&d.status!==st){location.reload();}}).catch(function(){});}setInterval(chk,25000);document.addEventListener('visibilitychange',function(){if(!document.hidden)chk();});})();</script>`}`;
}

// ---------- Контракты на проверке (HR+) ----------
async function panelContractCheck(client, user, pageNum = 0, sp) {
  const flt = (sp && sp.get && (sp.get('who') || '').trim()) || '';
  const sortOld = !(sp && sp.get && sp.get('sort') === 'new');
  const totalRow = await db.get("SELECT COUNT(*) c FROM contracts WHERE status = 'pending'").catch(() => null);
  const total = totalRow ? totalRow.c : 0;
  let sql = "SELECT * FROM contracts WHERE status = 'pending'";
  const params = [];
  if (flt) { sql += ' AND discord_id = ?'; params.push(flt); }
  sql += ` ORDER BY submitted_at ${sortOld ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`;
  params.push(PAGE_SIZE, pageNum * PAGE_SIZE);
  const rows = await db.all(sql, params).catch(() => []);
  const stuckH = (typeof config.STUCK_CONTRACT_HOURS === 'number' ? config.STUCK_CONTRACT_HOURS : 24);
  const cards = [];
  for (const cn of rows) {
    const pr = await db.get('SELECT name, static FROM participants WHERE discord_id = ?', [cn.discord_id]).catch(() => null);
    const ageH = cn.submitted_at ? Math.floor((Date.now() - new Date(cn.submitted_at)) / 36e5) : 0;
    const links = [
      contractProof(cn.taken_message_url, 'скрин «взял»'),
      contractProof(cn.message_url, 'скрин «итог»'),
    ].filter(Boolean).join(' ') || '<span class="mini">пруфов нет</span>';
    cards.push(`<div class="card">
      <b>#${cn.id}</b> — <a href="/u/${esc(cn.discord_id)}">${esc(pr ? pr.name : cn.discord_id)}</a>${pr ? ` (№ ${esc(pr.static)})` : ''}
      <span class="badge ${ageH >= stuckH ? 'bad' : ''}">висит ${ageH} ч</span>
      <div class="mini">отправлен ${fmt(cn.submitted_at)} · ${links}</div>
      <div class="bar" style="margin-top:8px">
        ${['fulfilled', 'unfulfilled', 'rejected'].map((vd) => `<form method="POST" action="/panel/contract/review" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${cn.id}"><input type="hidden" name="verdict" value="${vd}"><button class="btn sm" ${vd === 'rejected' ? 'style="background:var(--bad)"' : ''} type="submit">${vd === 'fulfilled' ? '✅ Выполнен' : vd === 'unfulfilled' ? '❌ Не выполнен' : '🗑 Отклонить'}</button></form>`).join('')}
      </div>
    </div>`);
  }
  const idsOnPage = rows.map((r) => r.id).join(',');

  // В работе: «взял», но итог ещё не сдан. Руководство может снять такой контракт.
  const abandonDays = (typeof config.CONTRACT_ABANDON_DAYS === 'number' && config.CONTRACT_ABANDON_DAYS > 0) ? config.CONTRACT_ABANDON_DAYS : 2;
  const takenRows = await db.all(
    "SELECT id, discord_id, taken_submitted_at, taken_message_url FROM contracts WHERE status = 'taken' ORDER BY taken_submitted_at ASC LIMIT 60",
  ).catch(() => []);
  const takenCards = [];
  for (const tc of takenRows) {
    const pr = await db.get('SELECT name, static FROM participants WHERE discord_id = ?', [tc.discord_id]).catch(() => null);
    const ageH = tc.taken_submitted_at ? Math.floor((Date.now() - new Date(tc.taken_submitted_at)) / 36e5) : 0;
    const burns = ageH >= abandonDays * 24;
    takenCards.push(`<div class="card" style="padding:12px 16px">
      <b>#${tc.id}</b> — <a href="/u/${esc(tc.discord_id)}">${esc(pr ? pr.name : tc.discord_id)}</a>${pr ? ` (№ ${esc(pr.static)})` : ''}
      <span class="badge ${burns ? 'bad' : ''}">взят ${ageH} ч назад${burns ? ' — сгорает' : ''}</span>
      <div class="mini">${fmt(tc.taken_submitted_at)} · ${contractProof(tc.taken_message_url, 'скрин «взял»') || 'пруфа нет'}</div>
      <form method="POST" action="/panel/contract/abandon" style="margin-top:8px" onsubmit="return confirm('Снять взятый контракт #${tc.id}? Он не будет засчитан.')">${csrfField(user)}
        <input type="hidden" name="id" value="${tc.id}">
        <button class="btn sm" style="background:var(--bad)" type="submit">🚫 Снять контракт</button>
      </form>
    </div>`);
  }
  const takenBlock = `<div class="card"><h2>Контракты в работе — ${takenRows.length}${takenRows.length === 60 ? '+' : ''}</h2>
    <p class="mini">Взяты, итог не сдан. Через ${abandonDays} дн. снимаются автоматически; здесь руководство может снять раньше.</p>
    ${takenCards.join('') || '<div class="mini">Нет контрактов в работе.</div>'}</div>`;

  return `<div class="card"><h2>Контракты на проверке — всего ${total}</h2>
    <form method="GET" action="/panel" class="bar" style="margin:6px 0">
      <input type="hidden" name="tab" value="contracts_check">
      <input name="who" value="${esc(flt)}" placeholder="Discord ID участника" style="max-width:200px">
      <select name="sort"><option value="old"${sortOld ? ' selected' : ''}>сначала старые</option><option value="new"${sortOld ? '' : ' selected'}>сначала новые</option></select>
      <button class="btn ghost sm" type="submit">Показать</button>
      ${flt ? '<a class="btn ghost sm" href="/panel?tab=contracts_check">сбросить</a>' : ''}
    </form>
    ${rows.length > 1 ? `<form method="POST" action="/panel/contract/review_bulk" onsubmit="return confirm('Отметить ВСЕ ${rows.length} контрактов на этой странице как выполненные?')">${csrfField(user)}<input type="hidden" name="ids" value="${idsOnPage}"><input type="hidden" name="verdict" value="fulfilled"><button class="btn ghost sm" type="submit">✅ Все на странице — выполнены</button></form>` : ''}
    ${pager('/panel?tab=contracts_check', pageNum, total)}</div>${cards.join('') || '<div class="card">Очередь пуста.</div>'}${pager('/panel?tab=contracts_check', pageNum, total)}
    ${takenBlock}`;
}

// ---------- Управление гайдами FAQ (Владелец) ----------
async function panelFaqManage(user) {
  const cats = [['public', 'Для всех (видно и не-участникам)'], ['member', 'Для участников'], ['hr', 'Для HR']];
  const parts = [];
  for (const [cat, title] of cats) {
    const entries = await db.all('SELECT * FROM faq_entries WHERE category = ? ORDER BY position, id', [cat]).catch(() => []);
    const rows = entries.map((e, i) => `<div class="card">
      <form method="POST" action="/panel/faq/edit" class="form">${csrfField(user)}<input type="hidden" name="id" value="${e.id}">
        <label>Заголовок<input name="title" value="${esc(e.title)}" maxlength="120" required></label>
        <label>Текст<textarea name="content" data-md rows="4" maxlength="3000" required>${esc(e.content)}</textarea></label>
        <div class="bar">
          <button class="btn sm" type="submit">Сохранить</button>
          <button class="btn ghost sm" formaction="/panel/faq/move" name="dir" value="up" type="submit" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn ghost sm" formaction="/panel/faq/move" name="dir" value="down" type="submit" ${i === entries.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="btn ghost sm" formaction="/panel/faq/delete" style="background:var(--bad)" type="submit" onclick="return confirm('Удалить гайд?')">Удалить</button>
        </div>
      </form>
    </div>`).join('');
    parts.push(`<div class="card"><h2>${esc(title)} (${entries.length})</h2>
      <form method="POST" action="/panel/faq/add" class="form">${csrfField(user)}<input type="hidden" name="category" value="${cat}">
        <label>Новый заголовок<input name="title" maxlength="120" required></label>
        <label>Текст<textarea name="content" data-md rows="3" maxlength="3000" required></textarea></label>
        <button class="btn sm" type="submit">Добавить гайд</button>
      </form></div>${rows}`);
  }
  return parts.join('');
}

// ---------- Шаблоны причин отказа (Владелец) ----------
const REASON_QUEUES = [['application', 'Заявки на вступление'], ['kick', 'Заявки на увольнение'], ['vacation', 'Заявки на отпуск']];
async function panelReasons(user) {
  const parts = [];
  for (const [q, title] of REASON_QUEUES) {
    const rows = await db.all('SELECT * FROM reject_reason_templates WHERE queue = ? ORDER BY position, id', [q]).catch(() => []);
    const list = rows.map((r, i) => `<tr><td>${esc(r.text)}</td><td style="white-space:nowrap">
      <form method="POST" action="/panel/reason/move" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${r.id}"><button class="btn ghost sm" name="dir" value="up" type="submit" ${i === 0 ? 'disabled' : ''}>▲</button></form>
      <form method="POST" action="/panel/reason/move" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${r.id}"><button class="btn ghost sm" name="dir" value="down" type="submit" ${i === rows.length - 1 ? 'disabled' : ''}>▼</button></form>
      <form method="POST" action="/panel/reason/delete" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${r.id}"><button class="btn ghost sm" style="background:var(--bad)" type="submit">✕</button></form>
    </td></tr>`).join('');
    parts.push(`<div class="card"><h2>${esc(title)} (${rows.length})</h2>
      <div class="tablewrap"><table><tr><th>Причина</th><th></th></tr>${list || '<tr><td colspan="2">—</td></tr>'}</table></div>
      <form method="POST" action="/panel/reason/add" class="form" style="margin-top:10px">${csrfField(user)}<input type="hidden" name="queue" value="${q}">
        <label>Новая причина<input name="text" maxlength="300" required></label>
        <button class="btn sm" type="submit">Добавить</button>
      </form></div>`);
  }
  return parts.join('');
}

// ---------- Сверка ролей (Зам.+) ----------
async function panelRoleCheck(client, user) {
  const g = guildOf(client);
  if (!g) return '<div class="card">Бот офлайн.</div>';
  const parts = await db.all('SELECT discord_id, name FROM participants ORDER BY name');
  const rows = [];
  for (const p of parts) {
    const ident = await passportsLib.computeEffectiveIdentity(p.discord_id).catch(() => null);
    if (!ident) continue;
    const m = g.members.cache.get(p.discord_id);
    if (!m) { rows.push({ id: p.discord_id, name: p.name, issue: 'нет на сервере' }); continue; }
    const wantNick = `${ident.name} | ${ident.static}`;
    const problems = [];
    if ((m.nickname || '') !== wantNick) problems.push(`ник: «${m.nickname || m.user.username}» → «${wantNick}»`);
    if (ident.roleId) {
      const hasRight = m.roles.cache.has(ident.roleId);
      const extraRank = (config.ROLE_IDS || []).filter((r) => r !== ident.roleId && m.roles.cache.has(r));
      if (!hasRight) problems.push(`нет роли ранга ${roleName(client, ident.roleId)}`);
      if (extraRank.length) problems.push(`лишние роли ранга: ${extraRank.map((r) => roleName(client, r)).join(', ')}`);
    }
    if (config.ROLE_ORGANIZATION && !m.roles.cache.has(config.ROLE_ORGANIZATION)) problems.push('нет роли организации');
    if (problems.length) rows.push({ id: p.discord_id, name: p.name, issue: problems.join('; ') });
  }
  const list = rows.map((r) => `<tr>
    <td>${personLink(client, r.id)}</td>
    <td class="mini">${esc(r.issue)}</td>
    <td><form method="POST" action="/panel/rolecheck/fix" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${esc(r.id)}"><button class="btn ghost sm" type="submit">Починить</button></form></td>
  </tr>`).join('');
  return `<div class="card"><h2>Расхождения ролей / ников (${rows.length})</h2>
    ${rows.length ? `<form method="POST" action="/panel/rolecheck/fixall" style="margin-bottom:10px" onsubmit="return confirm('Пересинхронизировать всех перечисленных?')">${csrfField(user)}<button class="btn sm" type="submit">Починить всех</button></form>
    <div class="tablewrap"><table><tr><th>Участник</th><th>Проблема</th><th></th></tr>${list}</table></div>` : '<p class="mini">Все ники и роли совпадают с эффективной личностью 👍</p>'}
  </div>`;
}

// ---------- Выплаты HR (Владелец) ----------
async function panelHrPayouts(client) {
  const range = contracts.getWeekRange(0);
  const rows = await db.all(
    `SELECT staff_discord_id, applicant_discord_id, applicant_name, status FROM acceptances
     WHERE status IN ('confirmed','disqualified') AND joined_at BETWEEN ? AND ?`,
    [range.start.toISOString(), range.end.toISOString()],
  ).catch(() => []);
  const byStaff = new Map();
  for (const r of rows) {
    if (!byStaff.has(r.staff_discord_id)) byStaff.set(r.staff_discord_id, { confirmed: 0, disq: 0 });
    const o = byStaff.get(r.staff_discord_id);
    if (r.status === 'confirmed') o.confirmed++; else o.disq++;
  }
  const g = guildOf(client);
  const hrRole = config.ROLE_HR;
  let total = 0;
  const list = [...byStaff.entries()].map(([sid, o]) => {
    const isHr = g && g.members.cache.get(sid) && g.members.cache.get(sid).roles.cache.has(hrRole);
    const rate = isHr ? (config.HR_PAYOUT_CONFIRMED || 25000) : (config.HR_PAYOUT_OTHER || 10000);
    const pay = o.confirmed * rate;
    total += pay;
    return `<tr><td>${personLink(client, sid)}</td><td>${o.confirmed}</td><td>${o.disq}</td><td>${rate.toLocaleString('ru')} $</td><td><b>${pay.toLocaleString('ru')} $</b></td></tr>`;
  }).join('');
  return `<div class="card"><h2>Выплаты HR за ${esc(contracts.formatWeekLabel(range))}</h2>
    <p class="mini">Выплата = принятые, кто досидел 3+ дня × ставку (HR-Менеджер — ${(config.HR_PAYOUT_CONFIRMED || 25000).toLocaleString('ru')} $, иначе ${(config.HR_PAYOUT_OTHER || 10000).toLocaleString('ru')} $).</p>
    <div class="tablewrap"><table><tr><th>Сотрудник</th><th>Досидело</th><th>Отсеялось</th><th>Ставка</th><th>К выплате</th></tr>${list || '<tr><td colspan="5">—</td></tr>'}</table></div>
    <p style="margin-top:8px">Итого за неделю: <b>${total.toLocaleString('ru')} $</b></p>
  </div>`;
}

// ---------- Отчёт по отзывам FAQ (Владелец) ----------
async function faqFeedbackReport() {
  const rows = await db.all(`
    SELECT e.id, e.title, e.category,
      SUM(CASE WHEN f.helpful = 1 THEN 1 ELSE 0 END) up,
      SUM(CASE WHEN f.helpful = 0 THEN 1 ELSE 0 END) down
    FROM faq_entries e LEFT JOIN faq_feedback f ON f.entry_id = e.id
    GROUP BY e.id ORDER BY e.category, e.position, e.id`).catch(() => []);
  const list = rows.map((r) => {
    const u = r.up || 0; const d = r.down || 0; const tot = u + d;
    const pct = tot ? Math.round((u / tot) * 100) : null;
    return `<tr><td>${esc(r.title)}</td><td>${r.category === 'hr' ? 'HR' : 'участники'}</td><td>👍 ${u}</td><td>👎 ${d}</td><td>${pct == null ? '—' : pct + '% полезно'}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Отзывы по гайдам</h2>
    <div class="tablewrap"><table><tr><th>Гайд</th><th>Раздел</th><th>👍</th><th>👎</th><th>Оценка</th></tr>${list || '<tr><td colspan="5">—</td></tr>'}</table></div>
  </div>`;
}

// ---------- История розыгрышей ----------
async function giveawayHistoryBody(client) {
  const rows = await db.all("SELECT * FROM giveaways WHERE status IN ('ended','cancelled') ORDER BY id DESC LIMIT 100").catch(() => []);
  const list = [];
  for (const gv of rows) {
    const cnt = await giveaways.countEntries(gv.id).catch(() => 0);
    list.push(`<tr>
      <td>#${gv.id} ${esc(gv.prize)}</td>
      <td><span class="badge ${gv.status === 'ended' ? 'ok' : 'bad'}">${gv.status === 'ended' ? 'завершён' : 'отменён'}</span></td>
      <td class="muted">${fmt(gv.created_at)}</td>
      <td>${cnt}</td>
      <td>${gv.winners ? gv.winners.split(',').filter(Boolean).map((w) => personLink(client, w)).join(', ') : '—'}</td>
    </tr>`);
  }
  return `<h1>История розыгрышей</h1>
  <div class="card"><div class="tablewrap"><table><tr><th>Розыгрыш</th><th>Статус</th><th>Дата</th><th>Уч.</th><th>Победители</th></tr>${list.join('') || '<tr><td colspan="5">—</td></tr>'}</table></div></div>
  <p><a href="/giveaways">← активные</a></p>`;
}

// ---------- Публичная витрина (без входа) ----------
async function boardBody(client) {
  const st = await orgStats();
  const g = guildOf(client);
  let ranksHtml = '';
  const byRank = new Map();
  const parts = await db.all('SELECT discord_id, name, role_id FROM participants ORDER BY name');
  for (const p of parts) {
    const k = roleName(client, p.role_id);
    if (!byRank.has(k)) byRank.set(k, []);
    byRank.get(k).push(p.name);
  }
  const order = (config.ROLE_IDS || []).map((r) => roleName(client, r));
  const sortedRanks = [...byRank.keys()].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  ranksHtml = sortedRanks.map((rk) => `<div class="card"><h2>${esc(rk)} (${byRank.get(rk).length})</h2>
    ${byRank.get(rk).map((n) => `<span class="pill">${esc(n)}</span>`).join('')}</div>`).join('');
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const wr = await giveaways.getEndedWinnersSince(since).catch(() => []);
  const wc = new Map();
  for (const r of wr) for (const w of (r.winners || '').split(',').filter(Boolean)) wc.set(w, (wc.get(w) || 0) + 1);
  const wall = [...wc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([w, n]) => `<span class="pill">${esc(nickOf(client, w) || ('ID ' + String(w).slice(-6)))} ×${n}</span>`).join(' ');
  return `
  <h1>Организация «${esc(siteBrand())}»</h1>
  <div class="card"><div class="grid">
    <div class="tile"><div class="n">${st.accounts}</div><div class="l">участников</div></div>
    <div class="tile"><div class="n">${st.passports}</div><div class="l">паспортов</div></div>
    <div class="tile"><div class="n">${st.fulfilled} / ${st.unfulfilled}</div><div class="l">контракты за неделю</div></div>
    <div class="tile"><div class="n">${st.endedGiveaways}</div><div class="l">завершённых розыгрышей</div></div>
  </div></div>
  ${ranksHtml}
  <div class="card"><h2>🏆 Чаще всех выигрывали (180 дней)</h2>${wall || '<span class="muted">пока пусто</span>'}</div>
  <p><a class="btn" href="/apply">Подать заявку</a> <a class="btn ghost" href="/">На главную</a></p>`;
}

// ---------- Уведомления ----------
const NOTIF_ICONS = {
  ticket: '🎫', kick: '⚠️', passport: '🪪', appeal: '⚖️', vacation: '🏖️',
  giveaway: '🎉', apply: '📩', contract: '📄', data_change: '✏️',
  thanks: '🙏', guestbook: '✍️', security: '🔐', info: '🔔',
};
const NOTIF_KINDS = [
  ['ticket', 'Тикеты'], ['giveaway', 'Розыгрыши'], ['vacation', 'Отпуска'],
  ['apply', 'Заявки'], ['passport', 'Паспорта'], ['appeal', 'Апелляции'],
  ['kick', 'Увольнения'], ['contract', 'Контракты'],
  ['thanks', 'Благодарности'], ['guestbook', 'Гостевая книга'], ['security', 'Безопасность (входы)'],
  ['weekly_digest', 'Еженедельный отчёт в ЛС'], ['info', 'Прочее'],
];
async function notificationsBody(user, sp) {
  const showSnoozed = sp && sp.get('snoozed') === '1';
  const nowIso = new Date().toISOString();
  const rows = await db.all('SELECT * FROM notifications WHERE discord_id = ? ORDER BY id DESC LIMIT 150', [user.id]).catch(() => []);
  const visible = rows.filter((n) => showSnoozed || !n.snooze_until || n.snooze_until <= nowIso);
  const prefRow = await db.get('SELECT muted FROM notif_prefs WHERE discord_id = ?', [user.id]).catch(() => null);
  const muted = new Set((prefRow && prefRow.muted ? prefRow.muted : '').split(',').map((s) => s.trim()).filter(Boolean));
  const list = visible.map((n) => {
    const snoozed = n.snooze_until && n.snooze_until > nowIso;
    return `<div class="card" style="display:flex;gap:12px;align-items:flex-start;${n.read_at ? 'opacity:.55' : ''}">
    <div style="font-size:20px;flex:0 0 auto">${NOTIF_ICONS[n.kind] || '🔔'}</div>
    <div style="flex:1">
      <div>${esc(n.text)}</div>
      <div class="mini">${fmt(n.created_at)}${n.link ? ` · <a href="/n/${n.id}">открыть</a>` : ''}${snoozed ? ` · <span class="badge warn">отложено до ${fmt(n.snooze_until)}</span>` : ''}</div>
    </div>
    <div class="bar" style="flex:0 0 auto;margin:0">
      ${n.read_at ? '' : `<form method="POST" action="/notifications/read_one" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${n.id}"><button class="btn ghost sm" type="submit">прочитано</button></form>`}
      ${snoozed ? '' : `<form method="POST" action="/notifications/snooze" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${n.id}"><button class="btn ghost sm" type="submit" title="скрыть на 3 дня">отложить</button></form>`}
    </div>
  </div>`;
  }).join('');
  const prefs = `<div class="card"><h2>Настройки колокольчика</h2>
    <p class="mini">Снятые типы не будут создавать уведомления.</p>
    <form method="POST" action="/notifications/prefs" class="form">${csrfField(user)}
      ${NOTIF_KINDS.map(([k, lbl]) => `<label class="chk"><input type="checkbox" name="on" value="${k}" ${muted.has(k) ? '' : 'checked'}><span>${esc(lbl)}</span></label>`).join('')}
      <button class="btn sm" type="submit">Сохранить</button>
    </form></div>`;
  return `<div class="bar"><h1 style="margin:0">Уведомления</h1>
    <form method="POST" action="/notifications/read_all">${csrfField(user)}<button class="btn sm" type="submit">Отметить все прочитанными</button></form>
    <a class="btn ghost sm" href="/notifications${showSnoozed ? '' : '?snoozed=1'}">${showSnoozed ? 'скрыть отложенные' : 'показать отложенные'}</a></div>
    ${list || '<div class="card">Пусто.</div>'}
    ${prefs}`;
}

// ---------- Карточка участника (печать / картинка) ----------
// Карточка участника как настоящий SVG (текстовые элементы, без foreignObject) —
// надёжный фолбэк, когда клиентский рендер PNG на мобиле не срабатывает (#58).
async function profileCardSvg(client, targetId) {
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [targetId]).catch(() => null);
  if (!p) return null;
  const ident = await passportsLib.computeEffectiveIdentity(targetId).catch(() => null);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(targetId, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
  const bs = await computeBadgesAndStreak(client, targetId);
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [targetId]).catch(() => null);
  const passports = await passportsLib.getAllPassports(targetId).catch(() => []);
  const name = ident ? `${ident.name} | ${ident.static}` : p.name;
  const rank = roleName(client, (ident && ident.roleId) || p.role_id);
  const av = await avatarDataUri(client, targetId, 128);
  const rows = [
    ['Вступил', fmt(p.joined_at)],
    ['Паспорта', passports.map((pp) => `${pp.name} № ${pp.static}`).join(', ') || '—'],
    ['Контракты за неделю', `+${week.fulfilled.length} / -${week.unfulfilled.length}`],
    ['Всего выполнено', String(bs.fulfilled)],
    ['Приглашений', String(invRow ? invRow.c : 0)],
  ];
  const W = 460; const AV = 74; const H = 150 + rows.length * 34 + 46;
  const t = (x, y, s, extra = '') => `<text x="${x}" y="${y}" ${extra}>${esc(String(s).slice(0, 60))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Ubuntu,Helvetica,Arial,'Noto Sans','DejaVu Sans',sans-serif">
    <defs><clipPath id="pcAv"><circle cx="${W / 2}" cy="64" r="${AV / 2}"/></clipPath></defs>
    <rect width="${W}" height="${H}" rx="18" fill="#15161a"/>
    <rect width="${W}" height="64" rx="18" fill="#5b6cff"/>
    <rect y="46" width="${W}" height="18" fill="#5b6cff"/>
    <circle cx="${W / 2}" cy="64" r="${AV / 2 + 4}" fill="#15161a"/>
    ${av ? `<image href="${esc(av)}" x="${W / 2 - AV / 2}" y="${64 - AV / 2}" width="${AV}" height="${AV}" clip-path="url(#pcAv)" preserveAspectRatio="xMidYMid slice"/>` : `<circle cx="${W / 2}" cy="64" r="${AV / 2}" fill="#2a2b31"/>`}
    ${t(W / 2, 126, name, 'text-anchor="middle" fill="#fff" font-size="21" font-weight="700"')}
    ${t(W / 2, 148, rank, 'text-anchor="middle" fill="#9a9aa2" font-size="13"')}
    ${rows.map(([k, v], i) => {
      const y = 186 + i * 34;
      return `<line x1="24" y1="${y - 22}" x2="${W - 24}" y2="${y - 22}" stroke="#2a2b31"/>${t(24, y, k, 'fill="#9a9aa2" font-size="14"')}${t(W - 24, y, v, 'text-anchor="end" fill="#e7e7ea" font-size="14" font-weight="700"')}`;
    }).join('')}
    ${t(24, H - 18, (bs.badges || []).slice(0, 4).join(' · ') || 'бейджей пока нет', 'fill="#8ea2ff" font-size="12"')}
  </svg>`;
}

async function profileCardBody(client, targetId) {
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [targetId]).catch(() => null);
  if (!p) return '<div class="card">Участник не найден.</div>';
  const av = await avatarDataUri(client, targetId, 256);
  const passports = await passportsLib.getAllPassports(targetId).catch(() => []);
  const ident = await passportsLib.computeEffectiveIdentity(targetId).catch(() => null);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(targetId, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
  const bs = await computeBadgesAndStreak(client, targetId);
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [targetId]).catch(() => null);
  const chk = (id, label) => `<label class="chk"><input type="checkbox" checked onchange="var d=document.querySelector('.pcard [data-sec=&quot;${id}&quot;]');if(d)d.style.display=this.checked?'':'none'"><span>${esc(label)}</span></label>`;
  return `
  <style>
    @media print{.noprint{display:none!important} body{background:#fff}}
    .pcardwrap{display:flex;justify-content:center;margin:16px 0}
    .pcard{width:420px;max-width:100%;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:var(--panel);box-shadow:0 14px 40px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,Helvetica,Arial,sans-serif}
    .pcard *{font-family:inherit}
    .pcard .band{height:80px;background:linear-gradient(120deg,var(--accent),var(--accent2))}
    .pcard .pc-av{width:96px;height:96px;border-radius:50%;border:4px solid var(--panel);object-fit:cover;display:block;margin:-52px auto 0;background:var(--panel2)}
    .pcard .pc-name{text-align:center;font-size:20px;font-weight:800;margin-top:10px;color:var(--text)}
    .pcard .pc-rank{text-align:center;color:var(--muted);font-size:13px;margin-bottom:10px}
    .pcard .pc-body{padding:2px 22px 22px}
    .pcard .pc-row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid var(--line);font-size:14px}
    .pcard .pc-row .k{color:var(--muted)}
    .pcard .pc-row .v{font-weight:700;text-align:right;color:var(--text)}
    .pcard .pc-badges{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:0 18px 20px}
  </style>
  <h1>Карточка участника</h1>
  <div class="card noprint">
    <p class="mini">Снимите галочки с ненужного, затем «Печать» или «Скачать PNG».</p>
    <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-bottom:10px">
      ${chk('badges', 'Бейджи')}${chk('week', 'Контракты за неделю')}${chk('total', 'Всего контрактов')}${chk('inv', 'Приглашения')}${chk('passports', 'Паспорта')}${chk('joined', 'Дата вступления')}
    </div>
    <div class="bar">
      <button class="btn sm" type="button" onclick="fcCardPng(this)">🖼️ Скачать PNG</button>
      <a class="btn ghost sm" href="/u/${esc(targetId)}/card.svg">🖼️ Скачать SVG</a>
      <button class="btn ghost sm" type="button" onclick="window.print()">🖨️ Печать / PDF</button>
    </div>
  </div>
  <div class="pcardwrap"><div class="pcard">
    <div class="band"></div>
    <img class="pc-av" src="${esc(av)}" alt="">
    <div class="pc-name">${esc(ident ? ident.name + ' | ' + ident.static : p.name)}</div>
    <div class="pc-rank">${esc(roleName(client, (ident && ident.roleId) || p.role_id))}</div>
    <div class="pc-body">
      <div class="pc-row" data-sec="joined"><span class="k">Вступил</span><span class="v">${fmt(p.joined_at)}</span></div>
      <div class="pc-row" data-sec="passports"><span class="k">Паспорта</span><span class="v">${passports.map((pp) => esc(pp.name) + ' № ' + esc(pp.static)).join('<br>') || '—'}</span></div>
      <div class="pc-row" data-sec="week"><span class="k">Контракты за неделю</span><span class="v">✅ ${week.fulfilled.length} / ❌ ${week.unfulfilled.length}</span></div>
      <div class="pc-row" data-sec="total"><span class="k">Всего выполнено</span><span class="v">${bs.fulfilled}</span></div>
      <div class="pc-row" data-sec="inv"><span class="k">Приглашений</span><span class="v">${invRow ? invRow.c : 0}</span></div>
    </div>
    <div class="pc-badges" data-sec="badges">${bs.badges.length ? bs.badges.map((b) => `<span class="pill">${esc(b)}</span>`).join('') : '<span class="mini">бейджей пока нет</span>'}</div>
  </div></div>
  <script>
  function fcCardPng(btn){
    var node=document.querySelector('.pcard'); if(!node)return;
    var old=btn.textContent; btn.textContent='рендерю…'; btn.disabled=true;
    try{
      var r=node.getBoundingClientRect(), w=Math.ceil(r.width), h=Math.ceil(node.scrollHeight);
      var css=''; for(var i=0;i<document.styleSheets.length;i++){try{var rl=document.styleSheets[i].cssRules;for(var j=0;j<rl.length;j++)css+=rl[j].cssText+'\\n';}catch(e){}}
      css=css.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      var clone=node.cloneNode(true); clone.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
      var html=new XMLSerializer().serializeToString(clone);
      var bg=getComputedStyle(document.body).backgroundColor||'#0f1013';
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><style>'+css+' foreignObject *{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,Helvetica,Arial,sans-serif}</style><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="background:'+bg+';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">'+html+'</div></foreignObject></svg>';
      var img=new Image();
      img.onload=function(){
        var c=document.createElement('canvas'); c.width=w*2; c.height=h*2;
        var ctx=c.getContext('2d'); ctx.scale(2,2); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h); ctx.drawImage(img,0,0);
        c.toBlob(function(b){
          if(!b){btn.textContent='не вышло — Печать';setTimeout(function(){btn.textContent=old;btn.disabled=false},2500);return;}
          var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='card-${esc(targetId)}.png'; a.click();
          setTimeout(function(){URL.revokeObjectURL(a.href)},4000); btn.textContent=old; btn.disabled=false;
        },'image/png');
      };
      img.onerror=function(){btn.textContent='не вышло — Печать';setTimeout(function(){btn.textContent=old;btn.disabled=false},2500);};
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    }catch(e){btn.textContent='ошибка';setTimeout(function(){btn.textContent=old;btn.disabled=false},2000);}
  }
  </script>
  <p class="noprint"><a href="/u/${esc(targetId)}">← к профилю</a></p>`;
}

// ---------- «Мой прогресс» (блок в /me) ----------
async function myProgressCard(client, did, p) {
  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const r = contracts.getWeekRange(w);
    const row = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status = 'fulfilled' AND submitted_at BETWEEN ? AND ?", [did, r.start.toISOString(), r.end.toISOString()]).catch(() => null);
    weeks.push({ label: dates.formatDateOnly(r.start).slice(0, 5), value: row ? row.c : 0 });
  }
  const norm = config.WEEKLY_PROMOTION_CONTRACT_THRESHOLD || 3;
  const thisWeek = weeks[weeks.length - 1].value;
  const isTrainee = p && p.role_id === config.ROLE_APPLY;
  const pct = Math.min(100, Math.round((thisWeek / norm) * 100));
  const bar = isTrainee
    ? `<div style="margin-top:8px"><div class="mini">До авто-повышения: ${thisWeek}/${norm} контрактов на этой неделе</div>
       <div style="height:10px;background:var(--panel2);border-radius:6px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent2))"></div></div></div>`
    : `<div class="mini" style="margin-top:8px">На этой неделе: ${thisWeek} выполнено${thisWeek >= norm ? ' — норма выполнена ✅' : ''}</div>`;
  return `<div class="card"><h2>Мой прогресс</h2>${barChart(weeks)}${bar}</div>`;
}

// ---------- Команды: помощь / команды человека ----------
const TIER_MIN_RANK = { everyone: 0, hr: LEVELS.hr, deputy: LEVELS.deputy, admin: LEVELS.owner, owner: LEVELS.owner, owner_account_only: 99 };
function commandsAllowed(rank, isHavirys) {
  const tiers = HOOKS.commandDefaultTiers || {};
  const out = {};
  for (const [name, tier] of Object.entries(tiers)) {
    const min = TIER_MIN_RANK[tier] == null ? LEVELS.owner : TIER_MIN_RANK[tier];
    const ok = tier === 'owner_account_only' ? isHavirys : rank >= min;
    (out[tier] = out[tier] || []).push({ name, ok });
  }
  return out;
}
function commandsBody(acc, user) {
  const labels = HOOKS.tierLabels || {};
  const descs = HOOKS.commandDescriptions || {};
  const grouped = commandsAllowed(acc.rank, user && user.id === OWNER_ID);
  const order = ['everyone', 'hr', 'deputy', 'owner', 'admin', 'owner_account_only'];
  const seen = new Set();
  const secs = [];
  let total = 0;
  for (const t of [...order, ...Object.keys(grouped)]) {
    if (seen.has(t) || !grouped[t]) continue;
    seen.add(t);
    const avail = grouped[t].filter((c) => c.ok).sort((a, b) => a.name.localeCompare(b.name));
    if (!avail.length) continue;
    total += avail.length;
    const rows = avail.map((c) => `<tr>
      <td style="white-space:nowrap"><code>/${esc(c.name)}</code></td>
      <td>${esc(descs[c.name] || '—')}</td>
    </tr>`).join('');
    secs.push(`<div class="card"><h2>${esc(labels[t] || t)} (${avail.length})</h2>
      <div class="tablewrap"><table><tr><th>Команда</th><th>Что делает</th></tr>${rows}</table></div></div>`);
  }
  const help = acc.rank >= LEVELS.hr ? `<div class="card"><h2>Как что делать (шпаргалка HR)</h2>
    <ul style="margin-left:18px;line-height:1.9">
      <li><b>Заявки на вступление</b> — вкладка «Заявки» (или пункт в шапке): принять/отклонить, комментарии, «беру на рассмотрение».</li>
      <li><b>Контракты</b> — «Контракты — проверка»: ✅ выполнен / ❌ невыполнен / 🚫 не контракт. Оба скрина видно в карточке.</li>
      <li><b>Очереди</b> (паспорта, изменение данных, апелляции ЧС, HR-заявки, кодовые слова) — вкладка «Очереди», одобрить/отклонить с причиной.</li>
      <li><b>Отпуск / AFK</b> — на профиле участника (<code>/u/&lt;id&gt;</code>) блок «Действия»: выдать/снять по паспорту или всем.</li>
      <li><b>Ранги</b> — там же «Ранг паспорта»: повысить/понизить. Массово — «Сверка ролей» / «Пересчитать ранги».</li>
      <li><b>Тикеты</b> — вкладка «Тикеты»: приоритет, метки, «взять на себя», закрыть с причиной, переоткрыть.</li>
      <li><b>Розыгрыши</b> — вкладка «Розыгрыши»: создать/запланировать/повторяющийся, реролл, участники, ЧС, шаблоны.</li>
      <li><b>Тексты</b> (правила/агитация/вакансия) — вкладка «Тексты», там же «разослать» / «опубликовать в канал».</li>
      <li><b>Аудит</b> — вкладка «Панель» → «Аудит» или пункт в шапке: фильтры, пресеты, экспорт CSV, откат действий (5 мин).</li>
      <li><b>Аналитика</b> — «Дашборд»: воронка найма, статистика HR, нагрузка HR, retention, тепловая карта, сравнение недель.</li>
    </ul></div>` : '';
  return `<h1>Команды бота</h1>
    <p class="mini">Показаны только доступные вам команды (${total}). Описание — как в Discord.</p>
    ${help}
    ${secs.join('') || '<div class="card">Доступных команд нет.</div>'}`;
}
async function personCommandsCard(client, targetId) {
  const a = await accessFor(client, targetId).catch(() => ({ rank: 0 }));
  const grouped = commandsAllowed(a.rank, targetId === OWNER_ID);
  const all = [];
  for (const arr of Object.values(grouped)) for (const c of arr) if (c.ok) all.push(c.name);
  all.sort();
  return `<div class="card"><h2>Команды, доступные этому участнику (${all.length})</h2>
    <div class="mini">${all.map((n) => `<span class="pill">/${esc(n)}</span>`).join(' ') || '—'}</div></div>`;
}

// Разбор одного скрина из формы: data-URI (сжатый в браузере) ИЛИ http-ссылка.
function resolveShot(body, dataField, urlField) {
  const data = (body.get(dataField) || '').trim();
  const url = (body.get(urlField) || '').trim();
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(data);
  if (m) {
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch (_) { return { err: 'Файл не читается.' }; }
    if (buf.length > 1400 * 1024) return { err: 'Скриншот слишком большой.' };
    if (buf.length < 8) return { err: 'Пустой файл.' };
    // Проверка сигнатуры файла — заявленный image/* должен быть настоящим PNG/JPEG/WebP.
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (!isPng && !isJpeg && !isWebp) return { err: 'Файл не похож на картинку (PNG/JPEG/WebP).' };
    const realMime = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : 'image/webp';
    return { buf, mime: realMime };
  }
  if (/^https?:\/\//i.test(url)) return { url: url.slice(0, 400) };
  return {};
}
// ---------- Файлы загрузок на диске (data/uploads/) ----------
const _fsMod = require('fs');
const _pathMod = require('path');
function uploadsDir() {
  const d = db.dataDir ? _pathMod.join(db.dataDir, 'uploads') : _pathMod.join(process.cwd(), 'data', 'uploads');
  try { _fsMod.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function uploadExt(mime) {
  return (mime || '').includes('png') ? 'png' : (mime || '').includes('webp') ? 'webp' : 'jpg';
}
async function saveUploadFile(prefix, mime, buf) {
  const name = `${String(prefix).replace(/[^a-z0-9_-]/gi, '')}_${crypto.randomBytes(6).toString('hex')}.${uploadExt(mime)}`;
  await _fsMod.promises.writeFile(_pathMod.join(uploadsDir(), name), buf);
  return name;
}
async function readUploadFile(name) {
  if (!name) return null;
  try { return await _fsMod.promises.readFile(_pathMod.join(uploadsDir(), _pathMod.basename(name))); } catch (_) { return null; }
}
async function deleteUploadFile(name) {
  if (!name) return;
  try { await _fsMod.promises.unlink(_pathMod.join(uploadsDir(), _pathMod.basename(name))); } catch (_) {}
}
// Отдаёт байты записи-загрузки: с диска (file) или из legacy-BLOB (data),
// лениво перенося BLOB на диск при первом обращении.
async function loadUploadBytes(table, row) {
  if (row && row.file) { const b = await readUploadFile(row.file); if (b) return b; }
  if (row && row.data) {
    try {
      const fn = await saveUploadFile((table === 'page_assets' ? 'a' : 'c') + row.id, row.mime, row.data);
      await db.run(`UPDATE ${table} SET file = ?, data = NULL WHERE id = ?`, [fn, row.id]);
    } catch (_) {}
    return row.data;
  }
  return null;
}

async function shotStore(ownerId, contractId, slot, s) {
  if (s.buf) {
    const fname = await saveUploadFile(`c${contractId || 0}${slot}`, s.mime, s.buf);
    const r = await db.run(
      'INSERT INTO contract_uploads (contract_id, owner_id, slot, mime, file, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [contractId || null, ownerId, slot, s.mime, fname, s.buf.length, new Date().toISOString()],
    );
    return { url: baseUrl() + '/cimg/' + r.lastID, buf: s.buf, mime: s.mime, id: r.lastID };
  }
  return { url: s.url };
}

// ---------- Обработка POST ----------
async function handlePost(client, pathName, user, body, acc, cookieHeader) {
  if (!user) return '/login';
  if (!csrfOk(user, body.get('_csrf'))) return '/me?' + qs({ err: 'Сессия формы устарела — откройте форму заново.' });
  const g = guildOf(client);
  const uname = user.username || user.id;

  // Отдельные лимиты на «дорогие» действия (помимо общего rate-limit).
  const ACT_LIMITS = {
    '/apply': [3, 3600e3], '/me/codeword': [8, 3600e3], '/me/hr_apply': [3, 24 * 3600e3],
    '/form/submit': [10, 3600e3], '/me/ticket': [5, 3600e3], '/me/data_change': [5, 3600e3],
    '/me/vacation': [5, 3600e3], '/me/appeal': [3, 24 * 3600e3], '/u/thank': [20, 3600e3],
    '/u/guestbook_add': [15, 3600e3],
  };
  if (ACT_LIMITS[pathName]) {
    const [lim, win] = ACT_LIMITS[pathName];
    if (!rateOk('act:' + pathName + ':' + user.id, lim, win)) {
      const back = pathName === '/apply' ? '/apply?' : pathName.startsWith('/u/') ? '/people?' : '/me?';
      return back + qs({ err: 'Слишком часто — попробуйте позже.' });
    }
  }

  // ===== доски (только havirys) =====
  if (pathName === '/board/create') {
    if (user.id !== OWNER_ID && (acc.rank || 0) < LEVELS.deputy) return '/boards?' + qs({ err: 'Создавать доски может заместитель+ или havirys.' });
    const title = (body.get('title') || '').trim().slice(0, 80) || 'Без названия';
    const kindB = body.get('kind') === 'orgchart' ? 'orgchart' : 'freeform';
    const now = new Date().toISOString();
    const r = await db.run(
      "INSERT INTO boards (title, kind, data, visibility, archived, version, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, 'owner', 0, 1, ?, ?, ?, ?)",
      [title, kindB, boardBlank(kindB), user.id, now, user.id, now],
    );
    // автор создаваемой доски получает право редактирования (если не havirys)
    if (user.id !== OWNER_ID) {
      await db.run('INSERT INTO board_grants (board_id, subject_type, subject_id, mode, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
        [r.lastID, 'user', user.id, 'edit', user.id, now]).catch(() => {});
    }
    return '/board/' + r.lastID + '/edit';
  }
  {
    const bm = pathName.match(/^\/board\/(\d+)\/(settings|archive|unarchive|delete|restore|grant_add|grant_del|reseed)$/);
    if (bm) {
      const bid = parseInt(bm[1], 10) || 0;
      const op = bm[2];
      const board = await db.get('SELECT * FROM boards WHERE id = ?', [bid]).catch(() => null);
      if (!board) return '/boards?' + qs({ err: 'Доска не найдена.' });
      const isOwner = user.id === OWNER_ID;
      const bmode = await boardAccess(client, user, board);
      // выдача/снятие грантов, удаление, сброс к шаблону — только havirys
      if ((op === 'grant_add' || op === 'grant_del' || op === 'delete' || op === 'reseed') && !isOwner) {
        return '/board/' + bid + '/settings?' + qs({ err: 'Это может только havirys.' });
      }
      if (op === 'reseed') {
        const seed = BOARD_SEEDS.find((s) => s.slug === board.slug);
        if (!seed) return '/board/' + bid + '/settings?' + qs({ err: 'Это не стандартная доска.' });
        const data = JSON.stringify(boardParse(JSON.stringify(boardSeedModel(seed))));
        const now = new Date().toISOString();
        const nv = (board.version || 1) + 1;
        await db.run('INSERT INTO board_versions (board_id, version, data, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)', [bid, board.version || 1, board.data, user.id, now]).catch(() => {});
        await db.run('UPDATE boards SET title = ?, kind = ?, data = ?, onboarding = ?, image_file = NULL, version = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          [seed.title, seed.kind, data, seed.onboarding ? 1 : 0, nv, user.id, now, bid]);
        return '/board/' + bid + '/edit?' + qs({ ok: 'Содержимое сброшено к шаблону. Нажми «Сохранить», чтобы пересобрать PNG.' });
      }
      // остальное — нужен режим редактирования
      if (op !== 'grant_add' && op !== 'grant_del' && op !== 'delete' && bmode !== 'edit') {
        return '/board/' + bid + '?' + qs({ err: 'Нет прав на изменение этой доски.' });
      }
      if (op === 'settings') {
        const title = (body.get('title') || '').trim().slice(0, 80) || 'Без названия';
        const kindB = body.get('kind') === 'orgchart' ? 'orgchart' : 'freeform';
        const onb = body.get('onboarding') === '1' ? 1 : 0;
        await db.run('UPDATE boards SET title = ?, kind = ? WHERE id = ?', [title, kindB, bid]);
        if (isOwner) {
          if (onb) await db.run('UPDATE boards SET onboarding = CASE WHEN id = ? THEN 1 ELSE 0 END', [bid]);
          else await db.run('UPDATE boards SET onboarding = 0 WHERE id = ?', [bid]);
        }
        return '/board/' + bid + '/settings?' + qs({ ok: 'Сохранено.' });
      }
      if (op === 'grant_add') {
        const st = body.get('subject_type') === 'user' ? 'user' : 'level';
        const mode = body.get('mode') === 'edit' ? 'edit' : 'view';
        let sid = st === 'user'
          ? (body.get('subject_user') || '').replace(/[^0-9]/g, '').slice(0, 25)
          : (['member', 'hr', 'deputy', 'owner'].includes(body.get('subject_level')) ? body.get('subject_level') : '');
        if (!sid) return '/board/' + bid + '/settings?' + qs({ err: 'Укажите, кому выдать доступ.' });
        await db.run('DELETE FROM board_grants WHERE board_id = ? AND subject_type = ? AND subject_id = ?', [bid, st, sid]).catch(() => {});
        await db.run('INSERT INTO board_grants (board_id, subject_type, subject_id, mode, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
          [bid, st, sid, mode, user.id, new Date().toISOString()]);
        return '/board/' + bid + '/settings?' + qs({ ok: 'Доступ выдан.' });
      }
      if (op === 'grant_del') {
        const gidn = parseInt(body.get('grant_id'), 10) || 0;
        await db.run('DELETE FROM board_grants WHERE id = ? AND board_id = ?', [gidn, bid]).catch(() => {});
        return '/board/' + bid + '/settings?' + qs({ ok: 'Доступ убран.' });
      }
      if (op === 'delete') {
        await db.run('DELETE FROM boards WHERE id = ?', [bid]);
        await db.run('DELETE FROM board_versions WHERE board_id = ?', [bid]).catch(() => {});
        await db.run('DELETE FROM board_grants WHERE board_id = ?', [bid]).catch(() => {});
        return '/boards?' + qs({ ok: 'Доска удалена.' });
      }
      if (op === 'restore') {
        const vid = parseInt(body.get('version_id'), 10) || 0;
        const v = await db.get('SELECT data FROM board_versions WHERE id = ? AND board_id = ?', [vid, bid]).catch(() => null);
        if (!v) return '/board/' + bid + '/versions?' + qs({ err: 'Версия не найдена.' });
        const nv = ((board.version) || 1) + 1;
        const now = new Date().toISOString();
        await db.run('UPDATE boards SET data = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?', [v.data, nv, user.id, now, bid]);
        await db.run('INSERT INTO board_versions (board_id, version, data, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)', [bid, nv, v.data, user.id, now]).catch(() => {});
        return '/board/' + bid + '/edit?' + qs({ ok: 'Версия восстановлена.' });
      }
      await db.run('UPDATE boards SET archived = ? WHERE id = ?', [op === 'archive' ? 1 : 0, bid]);
      return '/boards?' + qs({ ok: op === 'archive' ? 'Доска в архиве.' : 'Доска восстановлена.' });
    }
  }

  // ===== заявка на вступление =====
  if (pathName === '/apply') {
    if ((body.get('website') || '').trim()) return '/me?' + qs({ ok: 'Заявка отправлена на рассмотрение.' }); // honeypot — тихо игнорируем
    // Подать заявку можно только с Discord, который сейчас на сервере.
    const applicantId = (user.local && String(user.id).startsWith('local:')) ? (user.oauthDiscordId || '') : user.id;
    if (!applicantId || !(await memberOfGuild(client, applicantId))) {
      return '/apply?' + qs({ err: user.local ? 'Привяжите Discord к аккаунту — и он должен быть на сервере организации.' : 'Ваш Discord не найден на сервере организации.' });
    }
    if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [applicantId])) return '/me?' + qs({ err: 'Вы уже участник организации.' });
    if (await db.get('SELECT id FROM blacklist WHERE discord_id = ?', [applicantId])) return '/apply?' + qs({ err: 'Вы в чёрном списке организации.' });
    const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
    const stat = (body.get('static') || '').trim();
    const lvl = parseInt(body.get('lvl'), 10) || 0;
    const skills = (body.get('skills') || '').trim();
    const refId = getCookie(cookieHeader, 'fc_ref');
    const invited = (body.get('invited_by') || '').trim() || refId || '';
    if (!name || !/^[0-9]+$/.test(stat) || lvl < 1) return '/apply?' + qs({ err: 'Проверьте поля: имя, № паспорта (только цифры), LVL.' });
    if (await db.get("SELECT id FROM applications WHERE discord_id = ? AND status='pending'", [applicantId])) return '/me?' + qs({ err: 'У вас уже есть заявка на рассмотрении.' });
    // Кулдаун переподачи после отказа — 7 дней.
    const rej = await db.get("SELECT COALESCE(reviewed_at, created_at) t FROM applications WHERE discord_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1", [applicantId]).catch(() => null);
    if (rej && rej.t && Date.now() - new Date(rej.t).getTime() < 7 * 864e5) {
      const daysLeft = Math.ceil((7 * 864e5 - (Date.now() - new Date(rej.t).getTime())) / 864e5);
      return '/apply?' + qs({ err: `После отказа новую заявку можно подать через ${daysLeft} дн.` });
    }
    const created = new Date().toISOString();
    const r = await db.run(
      `INSERT INTO applications (discord_id, discord_tag, name, static, lvl, skills, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [applicantId, uname, name, stat, lvl, skills, invited, created],
    );
    const app = { id: r.lastID, discord_id: applicantId, discord_tag: uname, name, static: stat, lvl, skills, invited_by: invited, status: 'pending', created_at: created };
    const sent = await postTo(client, config.CHANNEL_APPLY_REVIEW, {
      content: REVIEW_MENTION() + ' — заявка подана через сайт',
      embeds: [webApplyEmbed(app)], components: webApplyComponents(app), ...REVIEW_MENTION_OPTS,
    });
    if (sent) await db.run('UPDATE applications SET message_id = ? WHERE id = ?', [sent.id, app.id]);
    if (refId) await db.run('UPDATE invite_links SET signups = signups + 1 WHERE creator_id = ?', [refId]).catch(() => {});
    await webAudit(client, user, 'Заявка на вступление (сайт)', `#${app.id} — ${name}, № ${stat}, LVL ${lvl}${refId ? ' (по ссылке ' + refId + ')' : ''}`);
    return '/me?' + qs({ ok: 'Заявка отправлена на рассмотрение.' });
  }

  // ===== локальный аккаунт: смена пароля =====
  if (pathName === '/account/password') {
    if (!user.local) return '/me?' + qs({ err: 'Только для локальных аккаунтов.' });
    const row = await db.get('SELECT pass_hash, pass_salt FROM web_users WHERE discord_id = ?', [user.localId]).catch(() => null);
    if (!row || !pwVerify(body.get('old') || '', row.pass_salt, row.pass_hash)) return '/account?' + qs({ err: 'Текущий пароль неверный.' });
    const np = body.get('new') || '';
    if (String(np).length < 8) return '/account?' + qs({ err: 'Новый пароль — минимум 8 символов.' });
    if (np !== (body.get('new2') || '')) return '/account?' + qs({ err: 'Пароли не совпадают.' });
    const rec = pwMake(np);
    await db.run('UPDATE web_users SET pass_hash = ?, pass_salt = ?, sess_ver = COALESCE(sess_ver,0) + 1 WHERE discord_id = ?', [rec.hash, rec.salt, user.localId]);
    _sessVerCache.delete(user.localId);
    return '/login/local?' + qs({ ok: 'Пароль изменён — войдите заново.' });
  }
  if (pathName === '/account/discord_unlink') {
    if (!user.local) return '/me?' + qs({ err: 'Только для локальных аккаунтов.' });
    await db.run('UPDATE web_users SET oauth_discord_id = NULL WHERE discord_id = ?', [user.localId]);
    return '/account?' + qs({ ok: 'Discord отвязан.' });
  }

  // ===== сброс ссылки-подписки на календарь отпусков =====
  if (pathName === '/me/ical_reset') {
    const token = crypto.randomBytes(18).toString('base64url');
    await db.run('UPDATE web_users SET ical_token = ? WHERE discord_id = ?', [token, user.id]).catch(() => {});
    return '/me?' + qs({ ok: 'Ссылка-подписка обновлена. Старая больше не работает.' });
  }

  // ===== выйти со всех устройств =====
  if (pathName === '/me/logout_all') {
    await db.run('UPDATE web_users SET sess_ver = COALESCE(sess_ver, 0) + 1 WHERE discord_id = ?', [user.id]);
    await db.run('UPDATE web_sessions SET revoked_at = ? WHERE discord_id = ? AND revoked_at IS NULL', [new Date().toISOString(), user.id]).catch(() => {});
    _sessVerCache.delete(user.id); // чтобы другие устройства разлогинились сразу
    await webAudit(client, user, 'Выход со всех устройств (сайт)', '');
    return '/login';
  }

  // ===== завершить конкретную сессию =====
  if (pathName === '/me/session_revoke') {
    const sid = (body.get('sid') || '').trim();
    if (sid && sid !== user.sid) {
      await db.run('UPDATE web_sessions SET revoked_at = ? WHERE sid = ? AND discord_id = ?', [new Date().toISOString(), sid, user.id]).catch(() => {});
      _sessVerCache.delete('sid:' + sid);
      await webAudit(client, user, 'Завершена сессия (сайт)', sid.slice(0, 8));
    }
    return '/me?' + qs({ ok: 'Сессия завершена.' });
  }

  if (pathName === '/me/session_label') {
    const sid = (body.get('sid') || '').trim();
    const label = (body.get('label') || '').trim().slice(0, 40);
    if (sid) await db.run('UPDATE web_sessions SET label = ? WHERE sid = ? AND discord_id = ?', [label || null, sid, user.id]).catch(() => {});
    return '/me?' + qs({ ok: 'Имя устройства сохранено.' });
  }

  // ===== «Обо мне» на публичном профиле =====
  if (pathName === '/me/about') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    await db.run('UPDATE participants SET about = ?, about_private = ?, contracts_private = ?, badges_private = ? WHERE discord_id = ?', [
      (body.get('about') || '').slice(0, 1000),
      body.get('about_private') === '1' ? 1 : 0,
      body.get('contracts_private') === '1' ? 1 : 0,
      body.get('badges_private') === '1' ? 1 : 0,
      user.id,
    ]);
    return '/me?' + qs({ ok: 'Сохранено.' });
  }

  if (pathName === '/me/pin_badges') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    const picked = body.getAll('b').filter((k) => /^[a-z0-9]{2,20}$/i.test(k)).slice(0, 12);
    await db.run('UPDATE participants SET pinned_badges = ? WHERE discord_id = ?', [picked.join(','), user.id]);
    return '/me?' + qs({ ok: 'Закреплённые бейджи обновлены.' });
  }

  // ===== создать свою ссылку-приглашение =====
  if (pathName === '/me/invite') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    const existing = await db.get('SELECT code FROM invite_links WHERE creator_id = ?', [user.id]);
    if (!existing) {
      await db.run('INSERT INTO invite_links (code, creator_id, created_at) VALUES (?, ?, ?)', [crypto.randomBytes(6).toString('hex'), user.id, new Date().toISOString()]);
    }
    return '/me?' + qs({ ok: 'Ссылка-приглашение готова.' });
  }

  // ===== комментарий к заявке (HR+) =====
  if (pathName === '/panel/app/comment') {
    if (!(await panelActionAllowed(client, user, acc, 'apps'))) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    const appId = parseInt(body.get('id'), 10) || 0;
    const text = (body.get('text') || '').trim().slice(0, 1000);
    if (!text || !(await db.get('SELECT id FROM applications WHERE id = ?', [appId]))) return '/panel?tab=apps&' + qs({ err: 'Пусто или заявка не найдена.' });
    await db.run('INSERT INTO application_comments (application_id, author_id, author_name, text, at) VALUES (?, ?, ?, ?, ?)', [appId, user.id, uname, text, new Date().toISOString()]);
    try { await hook('appMirrorComment')(appId, uname, text); } catch (_) {}
    return '/panel?tab=apps&' + qs({ ok: 'Комментарий добавлен (виден и в Discord).' });
  }

  const storeShot = (contractId, slot, s) => shotStore(user.id, contractId, slot, s);

  // ===== контракт: этап 1 — «взял» =====
  if (pathName === '/me/contract_take') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    const stat = (body.get('static') || '').trim();
    const pps = await passportsLib.getAllPassports(user.id).catch(() => []);
    const pp = pps.find((x) => x.static === stat);
    if (!pp) return '/me?' + qs({ err: 'Выберите паспорт из списка.' });
    const openCnt = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status IN ('taken','pending')", [user.id]).catch(() => null);
    if (openCnt && openCnt.c >= 15) return '/me?' + qs({ err: 'Слишком много незакрытых контрактов — сдайте итоги.' });
    if (pp.profile_thread_id) {
      const perPass = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND thread_id = ? AND status = 'taken'", [user.id, pp.profile_thread_id]).catch(() => null);
      if (perPass && perPass.c >= 1) return '/me?' + qs({ err: `По паспорту № ${stat} уже есть взятый контракт — сдайте по нему итог.` });
    }
    const shot = resolveShot(body, 'taken_data', 'taken_url');
    if (shot.err) return '/me?' + qs({ err: shot.err });
    if (!shot.buf && !shot.url) return '/me?' + qs({ err: 'Приложите скрин «взял» (файл или ссылку).' });
    const now = new Date().toISOString();
    const r = await db.run("INSERT INTO contracts (discord_id, thread_id, taken_submitted_at, status) VALUES (?, ?, ?, 'taken')",
      [user.id, pp.profile_thread_id || null, now]);
    const st = await storeShot(r.lastID, 'taken', shot);
    await db.run('UPDATE contracts SET taken_message_url = ? WHERE id = ?', [st.url, r.lastID]);
    await webAudit(client, user, 'Контракт взят (сайт)', `#${r.lastID} № ${stat}`);
    return '/me?' + qs({ ok: 'Контракт взят. Когда выполните — сдайте итог.' });
  }

  // ===== контракт: этап 2 — «итог» → на проверку =====
  if (pathName === '/me/contract_finish') {
    const cid = parseInt(body.get('id'), 10) || 0;
    const c = await db.get("SELECT * FROM contracts WHERE id = ? AND discord_id = ? AND status = 'taken'", [cid, user.id]);
    if (!c) return '/me?' + qs({ err: 'Контракт не найден или уже сдан.' });
    const shot = resolveShot(body, 'result_data', 'result_url');
    if (shot.err) return '/me?' + qs({ err: shot.err });
    if (!shot.buf && !shot.url) return '/me?' + qs({ err: 'Приложите скрин «итог».' });
    const now = new Date().toISOString();
    const st = await storeShot(cid, 'result', shot);
    await db.run("UPDATE contracts SET message_url = ?, submitted_at = ?, status = 'pending', stuck_reminder_sent = 0 WHERE id = ?", [st.url, now, cid]);
    // карточка на проверку в канал-профиль (кнопки бота contract_fulfilled/... сработают как обычно).
    // Нет канала-профиля — постим в общий канал статистики контрактов, чтобы HR увидели.
    if (g) {
      try {
        await hook('postContractReviewCardWeb')(g, cid, user.id, c.thread_id || config.CHANNEL_CONTRACTS_STATS);
      } catch (e) { console.error('[web] contract review card:', e.message); }
    }
    await webAudit(client, user, 'Контракт сдан на проверку (сайт)', `#${cid}`);
    return '/me?' + qs({ ok: 'Итог отправлен на проверку HR.' });
  }

  // ===== контракт: отмена взятого (до сдачи итога) =====
  if (pathName === '/me/contract_cancel') {
    const cid = parseInt(body.get('id'), 10) || 0;
    const c = await db.get("SELECT id FROM contracts WHERE id = ? AND discord_id = ? AND status = 'taken'", [cid, user.id]);
    if (!c) return '/me?' + qs({ err: 'Контракт не найден или уже сдан — отменить нельзя.' });
    for (const up of await db.all('SELECT file FROM contract_uploads WHERE contract_id = ?', [cid]).catch(() => [])) {
      if (up.file) await deleteUploadFile(up.file);
    }
    await db.run('DELETE FROM contract_uploads WHERE contract_id = ?', [cid]).catch(() => {});
    await db.run("DELETE FROM contracts WHERE id = ? AND discord_id = ? AND status = 'taken'", [cid, user.id]);
    await webAudit(client, user, 'Взятый контракт отменён (сайт)', `#${cid}`);
    return '/me?' + qs({ ok: 'Контракт снят с работы.' });
  }

  // ===== кодовое слово =====
  if (pathName === '/me/codeword') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    const stat = (body.get('static') || '').trim();
    const pps = await passportsLib.getAllPassports(user.id).catch(() => []);
    const pp = pps.find((x) => x.static === stat);
    if (!pp) return '/me?' + qs({ err: 'Выберите паспорт.' });
    if (await db.get("SELECT id FROM codeword_submissions WHERE discord_id = ? AND status = 'pending' AND static = ?", [user.id, stat])) {
      return '/me?' + qs({ err: 'По этому паспорту уже есть кодовое слово на проверке.' });
    }
    const shot = resolveShot(body, 'cw_data', 'cw_url');
    if (shot.err) return '/me?' + qs({ err: shot.err });
    if (!shot.buf && !shot.url) return '/me?' + qs({ err: 'Приложите скрин отправки.' });
    const st = await storeShot(null, 'codeword', shot);
    const now = new Date().toISOString();
    const r = await db.run(
      "INSERT INTO codeword_submissions (discord_id, discord_tag, name, static, screenshot_url, status, submitted_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      [user.id, uname, pp.name, stat, st.url, now],
    );
    if (g) {
      try {
        const sent = await postTo(client, config.CHANNEL_CODEWORD, {
          content: `📰 Кодовое слово через сайт — <@${user.id}> (${esc(pp.name)}, № ${stat})\n${signedCimgUrl(st.url)}`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`codeword_ok:${r.lastID}`).setLabel('✅ Подтвердить').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`codeword_no:${r.lastID}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
          )],
        });
        if (sent) await db.run('UPDATE codeword_submissions SET review_message_id = ? WHERE id = ?', [sent.id, r.lastID]);
      } catch (e) { console.error('[web] codeword post:', e.message); }
    }
    await webAudit(client, user, 'Кодовое слово отправлено (сайт)', `#${r.lastID} № ${stat}`);
    return '/me?' + qs({ ok: 'Кодовое слово отправлено на подтверждение.' });
  }

  // ===== заявка на HR =====
  if (pathName === '/me/hr_apply') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    if (acc.rank >= LEVELS.hr) return '/me?' + qs({ err: 'Вы уже HR или выше.' });
    if (await db.get("SELECT id FROM hr_applications WHERE discord_id = ? AND status = 'pending'", [user.id])) return '/me?' + qs({ err: 'Ваша заявка уже на рассмотрении.' });
    const hrs = (body.get('hours_per_week') || '').trim().slice(0, 60);
    const train = (body.get('training_ready') || '').trim().slice(0, 120);
    if (!hrs || !train) return '/me?' + qs({ err: 'Заполните оба поля.' });
    const now = new Date().toISOString();
    const r = await db.run(
      'INSERT INTO hr_applications (discord_id, discord_tag, hours_per_week, training_ready, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, uname, hrs, train, 'pending', now],
    );
    try { await hook('notifyHrApplication')(g, r.lastID); } catch (_) {}
    await webAudit(client, user, 'Заявка на HR (сайт)', `#${r.lastID}`);
    return '/me?' + qs({ ok: 'Заявка на HR отправлена. Смотрите ответ в «Очередях» / ЛС.' });
  }

  // ===== возврат из AFK (запрос, подтверждает руководство) =====
  if (pathName === '/me/afk_return') {
    const stat = (body.get('static') || '').trim();
    const pps = await passportsLib.getAllPassports(user.id).catch(() => []);
    const pp = pps.find((x) => x.static === stat);
    if (!pp || !pp.afk_since) return '/me?' + qs({ err: 'По этому паспорту AFK не отмечен.' });
    const key = `${user.id}:${stat}`;
    if (await db.get('SELECT key FROM afk_return_requests WHERE key = ?', [key]).catch(() => null)) return '/me?' + qs({ ok: 'Запрос уже отправлен.' });
    await db.run(
      'INSERT INTO afk_return_requests (key, discord_id, static, afk_since, requested_at) VALUES (?, ?, ?, ?, ?)',
      [key, user.id, stat, pp.afk_since, new Date().toISOString()],
    );
    if (g) {
      try {
        await postTo(client, config.CHANNEL_AFK_RETURN, {
          content: `🔔 Возврат из AFK через сайт — <@${user.id}> (${esc(pp.name)}, № ${stat}), был AFK с ${esc(pp.afk_since)}`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`afk_return_confirm:${user.id}:${stat}`).setLabel('✅ Снять AFK').setStyle(ButtonStyle.Success),
          )],
        });
      } catch (e) { console.error('[web] afk return post:', e.message); }
    }
    await webAudit(client, user, 'Запрос возврата из AFK (сайт)', `№ ${stat}`);
    return '/me?' + qs({ ok: 'Запрос отправлен — руководство подтвердит.' });
  }

  // ===== отпуск =====
  if (pathName === '/me/vacation') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Доступно только участникам организации.' });
    const deadline = dates.parseDeadline(body.get('deadline') || '');
    if (!deadline) return '/me?' + qs({ err: 'Неверная дата. Формат ДД.ММ.ГГГГ или число+d (например 7d).' });
    if (await db.get("SELECT id FROM vacations WHERE discord_id = ? AND status='pending'", [user.id])) return '/me?' + qs({ err: 'У вас уже есть заявка на отпуск на рассмотрении.' });
    const reason = (body.get('reason') || '').trim();
    const r = await db.run(
      'INSERT INTO vacations (discord_id, discord_tag, until, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, uname, deadline.toISOString(), reason, 'pending', new Date().toISOString()],
    );
    const v = { id: r.lastID, discord_id: user.id, discord_tag: uname, until: deadline.toISOString(), reason, status: 'pending' };
    const sent = await postTo(client, config.CHANNEL_VACATION_REVIEW, {
      content: REVIEW_MENTION() + ' — отпуск подан через сайт',
      embeds: [webVacationEmbed(v)], components: webVacationComponents(v), ...REVIEW_MENTION_OPTS,
    });
    if (sent) await db.run('UPDATE vacations SET message_id = ? WHERE id = ?', [sent.id, v.id]);
    await webAudit(client, user, 'Заявка на отпуск (сайт)', `#${v.id} до ${dates.formatDateTime(deadline)}`);
    return '/me?' + qs({ ok: 'Заявка на отпуск отправлена.' });
  }

  // ===== тикет =====
  if (pathName === '/me/ticket') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Доступно только участникам организации.' });
    const CATS = { question: 'Вопрос', complaint: 'Жалоба', other: 'Другое', bug: 'Баг на сайте', bug_discord: 'Баг Discord' };
    const cat = body.get('category');
    const isBug = cat === 'bug' || cat === 'bug_discord';
    const backTo = body.get('from') === 'bug' ? '/bug?' : '/me?';
    const backErr = (m) => backTo + qs({ err: m });
    if (!CATS[cat]) return backErr('Неизвестный тип тикета.');
    if (!g) return backErr('Бот сейчас недоступен, попробуйте позже.');
    const subject = ((body.get('subject') || '').trim() || (isBug ? CATS[cat] : 'Без темы')).slice(0, 100);
    let desc = (body.get('description') || '').trim();
    if (isBug) {
      const where = (body.get('page') || '').trim().slice(0, 300);
      desc = (where ? `Где: ${where}\n\n` : '') + desc;
    }
    if (await db.get("SELECT channel_id FROM tickets WHERE opener_id = ? AND status='open' AND (category IS NULL OR category != 'appeal')", [user.id])) {
      return backErr('У вас уже есть открытый тикет в Discord — опишите баг прямо в нём.');
    }
    const overwrites = [
      { id: g.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: g.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: config.OWNER_USER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    for (const roleId of config.ROLES_REVIEW_ALLOWED) {
      overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    let channel;
    try {
      channel = await g.channels.create({
        name: (`${CATS[cat].toLowerCase()}-${uname}`).toLowerCase().replace(/[^a-zа-яё0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || `ticket-${Date.now()}`,
        type: ChannelType.GuildText,
        parent: config.CHANNEL_TICKETS_ACTIVE_CATEGORY,
        permissionOverwrites: overwrites,
        topic: `[${CATS[cat]}] ${subject}`.slice(0, 1000),
      });
    } catch (e) {
      return backErr('Не удалось создать канал тикета: ' + e.message);
    }
    const r = await db.run(
      "INSERT INTO tickets (channel_id, opener_id, subject, category, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
      [channel.id, user.id, subject, cat, new Date().toISOString()],
    );
    await channel.send({
      content: `${REVIEW_MENTION()} — новый тикет от <@${user.id}> (через сайт)`,
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🎫 ${subject}`).setDescription(desc || '_(без описания)_').addFields(
        { name: 'Автор', value: `<@${user.id}>`, inline: true },
        { name: 'Тип', value: CATS[cat], inline: true },
        { name: 'Открыт', value: dates.formatDateTime(new Date()), inline: true },
      )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_claim:${r.lastID}`).setLabel('🙋 Беру').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`ticket_close:${r.lastID}`).setLabel('🔒 Закрыть тикет').setStyle(ButtonStyle.Danger),
      )],
      ...REVIEW_MENTION_OPTS,
    });
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription('👋 Спасибо за обращение! Опишите вопрос как можно подробнее — руководство ответит в течение суток. Если 5 дней не будет активности, тикет закроется автоматически.')] }).catch(() => {});
    await db.run('UPDATE tickets SET last_activity = ? WHERE id = ?', [new Date().toISOString(), r.lastID]).catch(() => {});
    await webAudit(client, user, 'Открыт тикет (сайт)', `#${r.lastID} ${CATS[cat]}: ${subject}`);
    return backTo + qs({ ok: isBug ? 'Спасибо! Баг-репорт создан — руководство ответит в тикете.' : 'Тикет создан в Discord.' });
  }

  // ===== розыгрыши (owner) =====
  if (pathName === '/panel/giveaway/create' || pathName === '/panel/giveaway/end' || pathName === '/panel/giveaway/cancel') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    if (pathName === '/panel/giveaway/create') {
      const prize = (body.get('prize') || '').trim().slice(0, 200);
      const winners = parseInt(body.get('winners'), 10) || 0;
      const durMs = giveaways.parseDuration((body.get('duration') || '').trim());
      const channelId = (body.get('channel_id') || '').trim();
      const roleId = (body.get('role_id') || '').trim() || null;
      const minRoleId = (body.get('min_role_id') || '').trim() || null;
      const prizeTiersRaw = (body.get('prize_tiers') || '').trim().slice(0, 800);
      const prizeTiers = giveaways.parsePrizeTiers(prizeTiersRaw).length ? prizeTiersRaw : null;
      if (!prize || winners < 1 || !durMs || !/^[0-9]+$/.test(channelId)) return '/panel?tab=giveaways&' + qs({ err: 'Проверьте поля формы (приз, победители, длительность, ID канала).' });
      const minCw = Math.max(0, parseInt(body.get('min_contracts_week'), 10) || 0);
      const weightByC = body.get('weight_by_contracts') === '1' ? 1 : 0;
      const endsAt = new Date(Date.now() + durMs);
      const gid = await giveaways.createGiveaway(channelId, prize, winners, user.id, endsAt.toISOString(), roleId, null, minRoleId, prizeTiers);
      if (minCw > 0 || weightByC) await db.run('UPDATE giveaways SET min_contracts_week = ?, weight_by_contracts = ? WHERE id = ?', [minCw || null, weightByC || null, gid]).catch(() => {});
      const tiersDesc = giveaways.parsePrizeTiers(prizeTiers).map((t) => `\n${t.from === t.to ? t.from : t.from + '–' + t.to} место — **${t.text}**`).join('');
      const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`🎉 ${prize}`)
        .setDescription(`Нажмите на кнопку ниже, чтобы участвовать!\nОрганизатор: <@${user.id}>${roleId ? `\nУсловие: только роль <@&${roleId}>` : ''}${minRoleId ? `\nУсловие: роль <@&${minRoleId}> и выше` : ''}${minCw ? `\nУсловие: ≥ ${minCw} выполненных контрактов за эту неделю` : ''}${weightByC ? `\n🎟️ Бонус-билеты: шанс победы растёт с числом контрактов за неделю` : ''}${tiersDesc}`)
        .addFields(
          { name: 'Победителей', value: String(winners), inline: true },
          { name: 'Участников', value: '0', inline: true },
          { name: 'Закончится', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true },
        );
      const sent = await postTo(client, channelId, {
        content: '🎉 **РОЗЫГРЫШ** 🎉',
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`giveaway_enter:${gid}`).setLabel('🎉 Участвовать').setStyle(ButtonStyle.Success),
        )],
      });
      if (!sent) return '/panel?tab=giveaways&' + qs({ err: 'Розыгрыш создан в БД, но опубликовать в канал не удалось — проверьте ID канала.' });
      await giveaways.setMessageId(gid, sent.id);
      await webAudit(client, user, 'Создан розыгрыш (сайт)', `#${gid} «${prize}», победителей ${winners}, до ${dates.formatDateTime(endsAt)}`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Розыгрыш создан и опубликован.' });
    }
    const gid = parseInt(body.get('id'), 10) || 0;
    const gv = await giveaways.getGiveaway(gid);
    if (!gv || gv.status !== 'active') return '/panel?tab=giveaways&' + qs({ err: 'Розыгрыш не найден или уже завершён.' });
    if (pathName === '/panel/giveaway/end') {
      await db.run('UPDATE giveaways SET ends_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), gid]);
      await webAudit(client, user, 'Досрочное завершение розыгрыша (сайт)', `#${gid} «${gv.prize}» — итоги подведёт бот в течение минуты`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Розыгрыш будет завершён в течение минуты.' });
    }
    if (pathName === '/panel/giveaway/cancel') {
      await giveaways.setStatus(gid, 'cancelled');
      if (gv.message_id && g) {
        try {
          const ch = await g.channels.fetch(gv.channel_id);
          const msg = await ch.messages.fetch(gv.message_id);
          await msg.edit({
            embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`🎉 ${gv.prize}`).setDescription('❌ Розыгрыш отменён.')],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`giveaway_enter:${gid}`).setLabel('🎉 Участвовать').setStyle(ButtonStyle.Success).setDisabled(true),
            )],
          });
          await ch.send(`❌ Розыгрыш «${gv.prize}» отменён.`);
        } catch (_) {}
      }
      await webAudit(client, user, 'Розыгрыш отменён (сайт)', `#${gid} «${gv.prize}»`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Розыгрыш отменён.' });
    }
    return '/panel?tab=giveaways';
  }

  // ===== чёрный список (deputy+) =====
  if (pathName.startsWith('/panel/blacklist/')) {
    if (acc.rank < LEVELS.deputy) return '/panel?tab=blacklist&' + qs({ err: 'Недостаточно прав.' });
    if (pathName === '/panel/blacklist/add') {
      const did = (body.get('discord_id') || '').trim();
      const stat = (body.get('static') || '').trim();
      const reason = (body.get('reason') || '').trim().slice(0, 300);
      if ((!did && !stat) || !reason) return '/panel?tab=blacklist&' + qs({ err: 'Укажите Discord ID или паспорт и причину.' });
      let untilIso = null;
      const untilRaw = (body.get('until') || '').trim();
      if (untilRaw) {
        const d = dates.parseDeadline(untilRaw);
        if (!d) return '/panel?tab=blacklist&' + qs({ err: 'Неверный формат даты «до».' });
        untilIso = d.toISOString();
      }
      await db.run(
        'INSERT INTO blacklist (discord_id, discord_tag, static, reason, added_by, created_at, until, appeal_blocked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        [did || null, null, stat || null, reason, user.id, new Date().toISOString(), untilIso],
      );
      await webAudit(client, user, 'Внесение в ЧС (сайт)', `${did ? 'ID ' + did : ''}${stat ? ' № ' + stat : ''} — ${reason}${untilIso ? ' (до ' + dates.formatDateTime(new Date(untilIso)) + ')' : ''}`);
      return '/panel?tab=blacklist&' + qs({ ok: 'Запись добавлена в чёрный список.' });
    }
    if (pathName === '/panel/blacklist/remove') {
      const id = parseInt(body.get('id'), 10) || 0;
      const row = await db.get('SELECT * FROM blacklist WHERE id = ?', [id]);
      if (!row) return '/panel?tab=blacklist&' + qs({ err: 'Запись не найдена.' });
      await db.run('DELETE FROM blacklist WHERE id = ?', [id]);
      await webAudit(client, user, 'Удаление из ЧС (сайт)', `#${id} ${row.discord_id ? 'ID ' + row.discord_id : ''} ${row.static ? '№ ' + row.static : ''}`);
      return '/panel?tab=blacklist&' + qs({ ok: 'Запись удалена из чёрного списка.' });
    }
    return '/panel?tab=blacklist';
  }

  // ===== редактор БД (только havirys) =====
  if (pathName.startsWith('/panel/row/')) {
    if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Редактор БД доступен только владельцу (havirys).' });
    const table = body.get('table');
    if (!DATA_TABLES[table]) return '/panel?tab=data&' + qs({ err: 'Неизвестная таблица.' });
    const info = await tableInfo(table);
    const snapshotRow = async (kind) => {
      try {
        const old = await db.get(`SELECT * FROM ${table} WHERE rowid = ?`, [body.get('pk')]);
        if (old) {
          await db.run(
            'INSERT INTO undo_actions (kind, actor_id, target_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            ['dbrow', user.id, `${table}#${body.get('pk')}`, JSON.stringify({ op: kind, table, pk: body.get('pk'), row: old }),
             new Date().toISOString(), new Date(Date.now() + 5 * 60000).toISOString()],
          );
        }
      } catch (_) {}
    };
    if (pathName === '/panel/row/save') {
      const pk = body.get('pk');
      const setCols = info.filter((ci) => !ci.pk);
      if (!setCols.length) return '/panel?tab=data&table=' + encodeURIComponent(table) + '&' + qs({ err: 'Нет изменяемых столбцов.' });
      const before = await db.get(`SELECT * FROM ${table} WHERE rowid = ?`, [pk]).catch(() => null);
      await snapshotRow('update');
      const sets = setCols.map((ci) => `${ci.name} = ?`).join(', ');
      const vals = setCols.map((ci) => {
        const raw = body.get('f_' + ci.name);
        return raw === '' || raw == null ? null : raw;
      });
      await db.run(`UPDATE ${table} SET ${sets} WHERE rowid = ?`, [...vals, pk]);
      // Что реально изменилось: столбец: было → стало (для аудита).
      const changes = [];
      setCols.forEach((ci, i) => {
        const oldV = before ? before[ci.name] : undefined;
        const newV = vals[i];
        const oS = oldV == null ? '∅' : String(oldV).slice(0, 60);
        const nS = newV == null ? '∅' : String(newV).slice(0, 60);
        if (oS !== nS) changes.push(`${ci.name}: «${oS}» → «${nS}»`);
      });
      await webAuditMeta(client, user, 'Правка БД (сайт)', `${table} rowid=${pk}: ${changes.join('; ') || 'без изменений'}`);
      return '/panel/row?' + qs({ table, pk, ok: 'Строка сохранена. Откат — на странице «Аудит» в течение 5 мин.' });
    }
    if (pathName === '/panel/row/delete') {
      const pk = body.get('pk');
      await snapshotRow('delete');
      await db.run(`DELETE FROM ${table} WHERE rowid = ?`, [pk]);
      await webAuditMeta(client, user, 'Удаление строки БД (сайт)', `${table} rowid=${pk}`);
      return '/panel?tab=data&table=' + encodeURIComponent(table) + '&' + qs({ ok: 'Строка удалена. Откат — на «Аудит» в течение 5 мин.' });
    }
    if (pathName === '/panel/row/add') {
      const addCols = info.filter((ci) => !(ci.pk && /INT/i.test(ci.type)));
      const present = addCols.filter((ci) => (body.get('f_' + ci.name) || '') !== '');
      if (!present.length) return '/panel/row/new?' + qs({ table, err: 'Заполните хотя бы одно поле.' });
      const placeholders = present.map(() => '?').join(', ');
      await db.run(
        `INSERT INTO ${table} (${present.map((c) => c.name).join(', ')}) VALUES (${placeholders})`,
        present.map((c) => body.get('f_' + c.name)),
      );
      await webAuditMeta(client, user, 'Добавление строки БД (сайт)', `${table}: ${present.map((c) => c.name).join(', ')}`);
      return '/panel?tab=data&table=' + encodeURIComponent(table) + '&' + qs({ ok: 'Строка добавлена.' });
    }
    return '/panel?tab=data&table=' + encodeURIComponent(table);
  }

  // ===== действия над профилем участника =====
  // ===== staff-заметки о участнике (HR+) — до общего /u/ блока =====
  if (pathName === '/u/note_add' || pathName === '/u/note_del') {
    if (acc.rank < LEVELS.hr) return '/people?' + qs({ err: 'Недостаточно прав.' });
    const target = (body.get('target') || '').trim();
    const back = '/u/' + target;
    if (pathName === '/u/note_add') {
      const text = (body.get('text') || '').trim().slice(0, 1000);
      if (!/^\d{5,25}$/.test(target) || !text) return back + '?' + qs({ err: 'Пустая заметка.' });
      await db.run('INSERT INTO staff_notes (target_id, author_id, author_name, text, at) VALUES (?, ?, ?, ?, ?)', [target, user.id, uname, text, new Date().toISOString()]);
      await webAudit(client, user, 'Staff-заметка добавлена (сайт)', `<@${target}>`);
      return back + '?' + qs({ ok: 'Заметка добавлена.' });
    }
    await db.run('DELETE FROM staff_notes WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
    return back + '?' + qs({ ok: 'Заметка удалена.' });
  }

  // ===== гостевая книга профиля — до общего /u/ блока =====
  if (pathName === '/u/guestbook_add' || pathName === '/u/guestbook_del') {
    const target = (body.get('target') || '').trim();
    const back = '/u/' + target;
    if (acc.rank < LEVELS.member) return back + '?' + qs({ err: 'Только для участников организации.' });
    if (!/^\d{5,25}$/.test(target)) return '/people?' + qs({ err: 'Неверный ID.' });
    if (pathName === '/u/guestbook_del') {
      const gid = parseInt(body.get('id'), 10) || 0;
      const row = await db.get('SELECT * FROM guestbook WHERE id = ?', [gid]);
      if (row && (row.author_id === user.id || row.profile_id === user.id || acc.rank >= LEVELS.hr)) {
        await db.run('DELETE FROM guestbook WHERE id = ?', [gid]);
      }
      return back + '?' + qs({ ok: 'Удалено.' });
    }
    const text = (body.get('text') || '').trim().slice(0, 500);
    if (!text) return back + '?' + qs({ err: 'Пустая запись.' });
    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    const cnt = await db.get('SELECT COUNT(*) c FROM guestbook WHERE author_id = ? AND created_at > ?', [user.id, dayAgo]);
    if (cnt && cnt.c >= 15) return back + '?' + qs({ err: 'Слишком много записей за сутки.' });
    await db.run('INSERT INTO guestbook (profile_id, author_id, text, created_at) VALUES (?, ?, ?, ?)', [target, user.id, text, new Date().toISOString()]);
    if (target !== user.id) await pushNotify(target, 'guestbook', `✍️ ${uname} оставил запись в вашей гостевой книге`, `/u/${target}`).catch(() => {});
    return back + '?' + qs({ ok: 'Запись добавлена.' });
  }

  // ===== благодарность участнику (любой участник) — до общего /u/ блока =====
  if (pathName === '/u/thank') {
    const target = (body.get('target') || '').trim();
    const back = '/u/' + target;
    if (acc.rank < LEVELS.member) return back + '?' + qs({ err: 'Только для участников организации.' });
    if (!/^\d{5,25}$/.test(target) || target === user.id) return back + '?' + qs({ err: 'Нельзя.' });
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [target]))) return back + '?' + qs({ err: 'Участник не найден.' });
    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    const dup = await db.get('SELECT id FROM thanks WHERE from_id = ? AND to_id = ? AND created_at > ?', [user.id, target, dayAgo]);
    if (dup) return back + '?' + qs({ err: 'Вы уже благодарили этого участника за последние сутки.' });
    const cntRow = await db.get('SELECT COUNT(*) c FROM thanks WHERE from_id = ? AND created_at > ?', [user.id, dayAgo]);
    if (cntRow && cntRow.c >= 5) return back + '?' + qs({ err: 'Лимит: не больше 5 благодарностей в сутки.' });
    const note = (body.get('note') || '').trim().slice(0, 200);
    await db.run('INSERT INTO thanks (from_id, to_id, note, created_at) VALUES (?, ?, ?, ?)', [user.id, target, note || null, new Date().toISOString()]);
    await pushNotify(target, 'thanks', `🙏 ${uname} поблагодарил вас${note ? `: ${note}` : ''}`, `/u/${target}`).catch(() => {});
    return back + '?' + qs({ ok: 'Спасибо! Благодарность отправлена.' });
  }

  if (pathName.startsWith('/u/')) {
    const target = (body.get('target') || '').trim();
    if (!/^\d{5,25}$/.test(target)) return '/people?' + qs({ err: 'Неверный ID.' });
    const back = '/u/' + target;
    if (!g) return back + '?' + qs({ err: 'Бот сейчас недоступен.' });
    if (acc.rank < LEVELS.hr) return back + '?' + qs({ err: 'Недостаточно прав.' });
    const part = await db.get('SELECT * FROM participants WHERE discord_id = ?', [target]);
    if (!part) return back + '?' + qs({ err: 'Пользователь не состоит в организации.' });

    if (pathName === '/u/rank') {
      if (acc.rank < LEVELS.deputy) return back + '?' + qs({ err: 'Ранги меняет Зам. Владелец и выше.' });
      const stat = (body.get('static') || '').trim();
      const dir = body.get('dir');
      const passports = await passportsLib.getAllPassports(target);
      const pp = passports.find((x) => x.static === stat);
      if (!pp) return back + '?' + qs({ err: 'Паспорт не найден.' });
      const cur = config.ROLE_IDS.indexOf(pp.role_id);
      const idx = cur === -1 ? config.ROLE_IDS.length - 1 : cur;
      const next = dir === 'up' ? Math.max(0, idx - 1) : Math.min(config.ROLE_IDS.length - 1, idx + 1);
      if (next === idx) return back + '?' + qs({ err: 'Дальше по иерархии некуда.' });
      const newRole = config.ROLE_IDS[next];
      await passportsLib.updatePassportFields(target, stat, { role_id: newRole });
      await hook('syncEffectiveIdentity')(g, target);
      await hook('syncProfileChannelName')(g, target, stat);
      await hook('safeUpdateMembersList')(g);
      await db.run('INSERT INTO undo_actions (kind, actor_id, target_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['rank', user.id, target, JSON.stringify({ static: stat, prevRoleId: pp.role_id }), new Date().toISOString(), new Date(Date.now() + 5 * 60000).toISOString()]).catch(() => {});
      await pushNotify(target, 'rank', dir === 'up' ? `Вас повысили: ${roleName(client, newRole)}` : `Изменён ранг: ${roleName(client, newRole)}`, '/me').catch(() => {});
      await webAudit(client, user, (dir === 'up' ? 'Повышение (сайт)' : 'Понижение (сайт)'), `<@${target}> № ${stat}: ${roleName(client, pp.role_id)} → ${roleName(client, newRole)}`);
      return back + '?' + qs({ ok: 'Ранг обновлён.' });
    }
    if (pathName === '/u/rename') {
      if (acc.rank < LEVELS.deputy) return back + '?' + qs({ err: 'Недостаточно прав.' });
      const stat = (body.get('static') || '').trim();
      const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
      if (!name) return back + '?' + qs({ err: 'Пустое имя.' });
      await passportsLib.updatePassportFields(target, stat, { name });
      await hook('syncEffectiveIdentity')(g, target);
      await hook('syncProfileChannelName')(g, target, stat);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'Переименование паспорта (сайт)', `<@${target}> № ${stat} → ${name}`);
      return back + '?' + qs({ ok: 'Имя обновлено.' });
    }
    if (pathName === '/u/passport_add') {
      if (acc.rank < LEVELS.deputy) return back + '?' + qs({ err: 'Недостаточно прав.' });
      const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
      const stat = (body.get('static') || '').trim();
      if (!name || !/^[0-9]+$/.test(stat)) return back + '?' + qs({ err: 'Проверьте имя и № паспорта.' });
      if (await passportsLib.isStaticTaken(stat)) return back + '?' + qs({ err: 'Такой № паспорта уже занят.' });
      try {
        await passportsLib.addExtraPassport(target, name, stat, user.id);
      } catch (e) { return back + '?' + qs({ err: e.message }); }
      await hook('syncEffectiveIdentity')(g, target);
      await hook('createProfileThread')(g, target, name, stat);
      await hook('safeUpdateMembersList')(g);
      await pushNotify(target, 'passport', `Добавлен паспорт: ${name} (№ ${stat})`, '/me').catch(() => {});
      await webAudit(client, user, 'Добавлен паспорт (сайт)', `<@${target}>: ${name} № ${stat}`);
      return back + '?' + qs({ ok: 'Паспорт добавлен.' });
    }
    if (pathName === '/u/passport_remove') {
      if (acc.rank < LEVELS.deputy) return back + '?' + qs({ err: 'Недостаточно прав.' });
      const stat = (body.get('static') || '').trim();
      try {
        await passportsLib.removePassportKeepAccount(target, stat);
      } catch (e) { return back + '?' + qs({ err: e.message }); }
      await hook('syncEffectiveIdentity')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'Удалён паспорт (сайт)', `<@${target}> № ${stat}`);
      return back + '?' + qs({ ok: 'Паспорт удалён.' });
    }
    // Выбор паспорта: пусто = все паспорта участника, иначе только указанный.
    const pickPassports = async (all) => {
      const sel = (body.get('static') || '').trim();
      if (!sel) return { list: all, one: false };
      const only = all.filter((pp) => pp.static === sel);
      return { list: only, one: true };
    };
    if (pathName === '/u/vacation') {
      const deadline = dates.parseDeadline(body.get('deadline') || '');
      if (!deadline) return back + '?' + qs({ err: 'Неверная дата.' });
      const reason = (body.get('reason') || '').trim();
      const { list: passports, one } = await pickPassports(await passportsLib.getAllPassports(target));
      if (!passports.length) return back + '?' + qs({ err: 'Паспорт не найден.' });
      for (const pp of passports) {
        await passportsLib.updatePassportFields(target, pp.static, { vacation_until: deadline.toISOString() });
        await history.logStatusGranted('vacation', target, pp.static, pp.name, reason, deadline.toISOString(), user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await pushNotify(target, 'vacation', `Вам выдан отпуск до ${dates.formatDateTime(deadline)}${one ? ` (паспорт № ${passports[0].static})` : ''}`, '/me').catch(() => {});
      await webAudit(client, user, 'Отпуск выдан (сайт)', `<@${target}>${one ? ` № ${passports[0].static}` : ' (все паспорта)'} до ${dates.formatDateTime(deadline)}${reason ? ' — ' + reason : ''}`);
      return back + '?' + qs({ ok: 'Отпуск выдан.' });
    }
    if (pathName === '/u/vacation_revoke') {
      const { list: passports, one } = await pickPassports(await passportsLib.getAllPassports(target));
      for (const pp of passports) {
        if (!pp.vacation_until) continue;
        await passportsLib.updatePassportFields(target, pp.static, { vacation_until: null });
        await history.logStatusRevoked('vacation', target, pp.static, pp.name, user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'Отпуск снят (сайт)', `<@${target}>${one && passports[0] ? ` № ${passports[0].static}` : ' (все паспорта)'}`);
      return back + '?' + qs({ ok: 'Отпуск снят.' });
    }
    if (pathName === '/u/afk') {
      const date = dates.parseDateOnly(body.get('date') || '');
      if (!date) return back + '?' + qs({ err: 'Неверная дата (ДД.ММ.ГГГГ).' });
      const reason = (body.get('reason') || '').trim();
      const { list: passports, one } = await pickPassports(await passportsLib.getAllPassports(target));
      if (!passports.length) return back + '?' + qs({ err: 'Паспорт не найден.' });
      for (const pp of passports) {
        await passportsLib.updatePassportFields(target, pp.static, { afk_since: dates.formatDateOnly(date) });
        await history.logStatusGranted('afk', target, pp.static, pp.name, reason, null, user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'AFK отмечен (сайт)', `<@${target}>${one ? ` № ${passports[0].static}` : ' (все паспорта)'} с ${dates.formatDateOnly(date)}${reason ? ' — ' + reason : ''}`);
      return back + '?' + qs({ ok: 'AFK отмечен.' });
    }
    if (pathName === '/u/afk_clear') {
      const { list: passports, one } = await pickPassports(await passportsLib.getAllPassports(target));
      for (const pp of passports) {
        if (!pp.afk_since) continue;
        await passportsLib.updatePassportFields(target, pp.static, { afk_since: null });
        await history.logStatusRevoked('afk', target, pp.static, pp.name, user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'AFK снят (сайт)', `<@${target}>${one && passports[0] ? ` № ${passports[0].static}` : ' (все паспорта)'}`);
      return back + '?' + qs({ ok: 'AFK снят.' });
    }
    if (pathName === '/u/contract') {
      const link = (body.get('link') || '').trim();
      const st = body.get('status') === 'unfulfilled' ? 'unfulfilled' : 'fulfilled';
      const stat = (body.get('static') || '').trim();
      if (!/^https?:\/\//i.test(link)) return back + '?' + qs({ err: 'Ссылка должна начинаться с http.' });
      let threadId = null;
      if (stat) {
        const passports = await passportsLib.getAllPassports(target);
        const pp = passports.find((x) => x.static === stat);
        threadId = pp ? pp.profile_thread_id : null;
      }
      await contracts.recordManualContract(target, link, new Date().toISOString(), st, user.id, threadId);
      try { await contractsDisplay.safeUpdateContractsStats(g); } catch (_) {}
      await webAudit(client, user, 'Контракт записан (сайт)', `<@${target}> ${st === 'fulfilled' ? '✅' : '❌'}${stat ? ' № ' + stat : ''}`);
      return back + '?' + qs({ ok: 'Контракт записан.' });
    }
    if (pathName === '/u/kick') {
      if (acc.rank < LEVELS.deputy) return back + '?' + qs({ err: 'Увольняет Зам. Владелец и выше.' });
      const reason = (body.get('reason') || '').trim() || 'Уволен через сайт';
      await hook('removeParticipant')(g, part, reason);
      await webAudit(client, user, 'Увольнение (сайт)', `<@${target}> — ${reason}`);
      return '/people?' + qs({ ok: 'Участник уволен.' });
    }
    if (pathName === '/u/freeze') {
      const on = body.get('on') === '1';
      const reason = (body.get('reason') || '').trim().slice(0, 200);
      await db.run('UPDATE participants SET frozen = ?, frozen_reason = ? WHERE discord_id = ?', [on ? 1 : 0, on ? (reason || null) : null, target]);
      if (on) await db.run('UPDATE web_users SET sess_ver = COALESCE(sess_ver, 0) + 1 WHERE discord_id = ?', [target]).catch(() => {});
      _sessVerCache.delete(target);
      _frozenCache.delete(target);
      await webAudit(client, user, on ? 'Заморозка доступа (сайт)' : 'Разморозка доступа (сайт)', `<@${target}>${on && reason ? ' — ' + reason : ''}`);
      return back + '?' + qs({ ok: on ? 'Доступ заморожен.' : 'Доступ разморожен.' });
    }
    return back;
  }

  // ===== приём/отказ заявки на вступление (HR+) =====
  if (pathName === '/panel/member/add_direct') {
    if (!(await panelActionAllowed(client, user, acc, 'apps'))) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=apps&' + qs({ err: 'Бот недоступен.' });
    const did = (body.get('discord_id') || '').trim();
    const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
    const stat = (body.get('static') || '').trim();
    const lvl = parseInt(body.get('lvl'), 10) || 1;
    if (!/^[0-9]{5,25}$/.test(did) || !name || !/^[0-9]+$/.test(stat)) return '/panel?tab=apps&' + qs({ err: 'Проверьте поля.' });
    if (!(await memberOfGuild(client, did))) return '/panel?tab=apps&' + qs({ err: 'Этого Discord нет на сервере.' });
    if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [did])) return '/panel?tab=apps&' + qs({ err: 'Уже участник.' });
    if (await db.get('SELECT id FROM blacklist WHERE discord_id = ? OR static = ?', [did, stat])) return '/panel?tab=apps&' + qs({ err: 'Discord или паспорт в ЧС.' });
    if (await passportsLib.isStaticTaken(stat)) return '/panel?tab=apps&' + qs({ err: 'Такой № паспорта занят.' });
    const gm = g.members.cache.get(did);
    const tag = gm ? gm.user.tag : did;
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at) VALUES (?, ?, ?, ?, ?, '', '', ?, ?)`,
      [did, tag, name, stat, lvl, config.ROLE_APPLY, now],
    );
    try { await acceptances.recordAcceptance(user.id, did, name, stat, now); } catch (_) {}
    try { await hook('addParticipantDirect')(did, name, stat, lvl, user.id); } catch (e) { console.error('[web] addParticipantDirect:', e.message); }
    await webAudit(client, user, 'Участник добавлен напрямую (сайт)', `<@${did}> — ${name} № ${stat}`);
    return '/panel?tab=apps&' + qs({ ok: 'Участник добавлен.' });
  }

  if (pathName === '/panel/app/reject_bulk') {
    if (!(await panelActionAllowed(client, user, acc, 'apps'))) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    const reason = (body.get('preset') || '').trim() || (body.get('reason') || '').trim() || 'Без указания причины';
    const ids = body.getAll('ids').map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 100);
    let done = 0;
    for (const id of ids) {
      const app = await db.get('SELECT * FROM applications WHERE id = ?', [id]).catch(() => null);
      if (!app || app.status !== 'pending') continue;
      await db.run("UPDATE applications SET status='rejected', rejected_by=?, reject_reason=?, reviewed_at=? WHERE id=?", [user.id, reason, new Date().toISOString(), id]);
      try { await hook('appMirrorRejected')(id, user.id); } catch (_) {}
      done++;
    }
    await webAudit(client, user, 'Массовый отказ по заявкам (сайт)', `${done} шт — ${reason}`);
    return '/panel?tab=apps&' + qs({ ok: `Отклонено: ${done}.` });
  }

  if (pathName === '/panel/app/accept' || pathName === '/panel/app/reject') {
    if (!(await panelActionAllowed(client, user, acc, 'apps'))) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    const id = parseInt(body.get('id'), 10) || 0;
    const app = await db.get('SELECT * FROM applications WHERE id = ?', [id]);
    if (!app || app.status !== 'pending') return '/panel?tab=apps&' + qs({ err: 'Заявка уже обработана.' });

    if (pathName === '/panel/app/reject') {
      const reason = (body.get('preset') || '').trim() || (body.get('reason') || '').trim() || 'Без указания причины';
      await db.run("UPDATE applications SET status='rejected', rejected_by=?, reject_reason=?, reviewed_at=? WHERE id=?", [user.id, reason, new Date().toISOString(), id]);
      // полная синхронизация Discord-стороны (карточка «Отклонено», ЛС, аудит)
      try { await hook('appMirrorRejected')(id, user.id); } catch (_) {}
      await webAudit(client, user, 'Заявка отклонена (сайт)', `#${id} <@${app.discord_id}> — ${reason}`);
      return '/panel?tab=apps&' + qs({ ok: 'Заявка отклонена.' });
    }

    if (!g) return '/panel?tab=apps&' + qs({ err: 'Бот недоступен.' });
    const name = (body.get('name') || app.name || '').trim().replace(/[_\s]+/g, ' ').trim();
    const stat = (body.get('static') || app.static || '').trim();
    const lvl = parseInt(body.get('lvl'), 10) || app.lvl || 1;
    if (!/^[0-9]+$/.test(stat)) return '/panel?tab=apps&' + qs({ err: '№ паспорта — только цифры.' });
    if (await db.get('SELECT id FROM blacklist WHERE discord_id = ? OR static = ?', [app.discord_id, stat])) return '/panel?tab=apps&' + qs({ err: 'Заявитель или паспорт в ЧС.' });
    if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [app.discord_id])) return '/panel?tab=apps&' + qs({ err: 'Уже в списке участников.' });
    if (await passportsLib.isStaticTaken(stat)) return '/panel?tab=apps&' + qs({ err: 'Такой № паспорта занят.' });

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
      [app.discord_id, app.discord_tag, name, stat, lvl, app.skills || '', config.ROLE_APPLY, now],
    );
    // финальные значения — обратно в заявку, чтобы карточка в Discord их показала
    await db.run("UPDATE applications SET status='accepted', accepted_by=?, reviewed_at=?, name=?, static=?, lvl=? WHERE id=?", [user.id, now, name, stat, lvl, id]);
    try { await acceptances.recordAcceptance(user.id, app.discord_id, name, stat, now); } catch (_) {}
    try {
      const m = await g.members.fetch(app.discord_id);
      await m.roles.add([config.ROLE_APPLY, config.ROLE_ORGANIZATION].filter(Boolean));
    } catch (_) {}
    await hook('syncEffectiveIdentity')(g, app.discord_id);
    try { await history.logJoined(app.discord_id, stat, name, `Принята заявка #${id} (сайт)`); } catch (_) {}
    let channelUrl = null;
    try { channelUrl = await hook('createProfileThread')(g, app.discord_id, name, stat); } catch (_) {}
    if (app.invited_by && !(await invitations.hasExistingInvitationRecord(app.discord_id))) {
      const inv = await invitations.resolveInviter(app.invited_by);
      if (inv) await invitations.recordInvitation(inv.discord_id, app.discord_id, name, stat, now).catch(() => {});
    }
    await hook('safeUpdateMembersList')(g);
    // полная синхронизация Discord-стороны: карточка «Принято», все ЛС (правила,
    // инструкция по профилю), запись в аудит Discord — как при принятии в Discord
    try { await hook('appMirrorAccepted')(id, user.id, channelUrl); } catch (_) {}
    await webAudit(client, user, 'Заявка принята (сайт)', `#${id} <@${app.discord_id}> — ${name} № ${stat}`);
    return '/panel?tab=apps&' + qs({ ok: 'Участник принят.' });
  }

  // ===== очереди рассмотрения (одобрить/отклонить) =====
  if (pathName === '/panel/queue/approve' || pathName === '/panel/queue/reject') {
    if (!(await panelActionAllowed(client, user, acc, 'queues'))) return '/panel?tab=queues&' + qs({ err: 'Недостаточно прав.' });
    const qkey = body.get('q');
    const def = QUEUE_DEFS[qkey];
    if (!def) return '/panel?tab=queues&' + qs({ err: 'Неизвестная очередь.' });
    const [table] = def;
    const id = parseInt(body.get('id'), 10) || 0;
    const rec = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!rec || rec.status !== 'pending') return '/panel?tab=queues&' + qs({ err: 'Уже обработано.' });
    if ((qkey === 'appeal' || qkey === 'codeword' || qkey === 'hr_app') && acc.rank < LEVELS.deputy) {
      return '/panel?tab=queues&' + qs({ err: 'Эту очередь ведёт Зам. Владелец и выше.' });
    }

    if (pathName === '/panel/queue/reject') {
      const reason = (body.get('preset') || '').trim() || (body.get('reason') || '').trim() || 'Без указания причины';
      const col = qkey === 'codeword' ? "status='rejected', reviewed_by=?, reviewed_at=?" : "status='rejected', reject_reason=?";
      if (qkey === 'codeword') await db.run(`UPDATE ${table} SET status='rejected', reviewed_by=?, reviewed_at=? WHERE id=?`, [user.id, new Date().toISOString(), id]);
      else await db.run(`UPDATE ${table} SET status='rejected', reject_reason=? WHERE id=?`, [reason, id]);
      await dmTo(client, rec.discord_id, `❌ Ваша заявка (${def[1]}) отклонена. Причина: ${reason}`);
      await pushNotify(rec.discord_id, qkey, `«${def[1]}» — отказ. Причина: ${reason}`, '/me').catch(() => {});
      await webAudit(client, user, `Очередь «${def[1]}» — отказ (сайт)`, `#${id} <@${rec.discord_id}> — ${reason}`);
      return '/panel?tab=queues&' + qs({ ok: 'Отклонено.' });
    }

    // approve
    if (!g) return '/panel?tab=queues&' + qs({ err: 'Бот недоступен.' });
    if (qkey === 'passport') {
      if (await passportsLib.isStaticTaken(rec.static)) return '/panel?tab=queues&' + qs({ err: 'Такой № паспорта занят.' });
      try { await passportsLib.addExtraPassport(rec.discord_id, rec.name, rec.static, user.id); }
      catch (e) { return '/panel?tab=queues&' + qs({ err: e.message }); }
      await db.run("UPDATE passport_requests SET status='accepted', accepted_by=? WHERE id=?", [user.id, id]);
      await hook('syncEffectiveIdentity')(g, rec.discord_id);
      try { await hook('createProfileThread')(g, rec.discord_id, rec.name, rec.static); } catch (_) {}
      await hook('safeUpdateMembersList')(g);
      await dmTo(client, rec.discord_id, `✅ Ваш новый паспорт ${rec.name} (№ ${rec.static}) добавлен.`);
    } else if (qkey === 'data_change') {
      await passportsLib.updatePassportFields(rec.discord_id, rec.target_static, { name: rec.new_name });
      await db.run("UPDATE data_change_requests SET status='accepted' WHERE id=?", [id]);
      await hook('syncEffectiveIdentity')(g, rec.discord_id);
      await hook('syncProfileChannelName')(g, rec.discord_id, rec.target_static);
      await hook('safeUpdateMembersList')(g);
      await dmTo(client, rec.discord_id, `✅ Имя по паспорту № ${rec.target_static} изменено на «${rec.new_name}».`);
    } else if (qkey === 'hr_app') {
      try { const m = await g.members.fetch(rec.discord_id); await m.roles.add(config.ROLE_HR); } catch (_) {}
      await db.run("UPDATE hr_applications SET status='accepted' WHERE id=?", [id]);
      await dmTo(client, rec.discord_id, '✅ Ваша заявка в HR одобрена — выдана роль HR-Менеджера.');
    } else if (qkey === 'appeal') {
      await db.run('DELETE FROM blacklist WHERE discord_id = ?', [rec.discord_id]);
      await db.run("UPDATE appeals SET status='accepted', resolved_by=?, resolved_at=? WHERE id=?", [user.id, new Date().toISOString(), id]);
      await dmTo(client, rec.discord_id, '✅ Ваша апелляция одобрена — вы исключены из чёрного списка.');
    } else if (qkey === 'codeword') {
      await db.run("UPDATE codeword_submissions SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?", [user.id, new Date().toISOString(), id]);
      await dmTo(client, rec.discord_id, '✅ Кодовое слово засчитано.');
    }
    await pushNotify(rec.discord_id, qkey, `«${def[1]}» — ваша заявка одобрена`, '/me').catch(() => {});
    await webAudit(client, user, `Очередь «${def[1]}» — одобрено (сайт)`, `#${id} <@${rec.discord_id}>`);
    return '/panel?tab=queues&' + qs({ ok: 'Одобрено.' });
  }

  // ===== тексты (Владелец) =====
  if (pathName === '/panel/text/save') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=texts&' + qs({ err: 'Недостаточно прав.' });
    const key = body.get('key');
    if (!['rules', 'agitation', 'hr_info'].includes(key)) return '/panel?tab=texts&' + qs({ err: 'Неизвестный ключ.' });
    const contentText = (body.get('content') || '').trim();
    if (!contentText) return '/panel?tab=texts&' + qs({ err: 'Пустой текст.' });
    await contentVersions.saveVersion(key, contentText, user.id);
    await webAuditMeta(client, user, 'Текст обновлён (сайт)', `${key} (${contentText.length} симв.)`);
    return '/panel?tab=texts&' + qs({ ok: 'Сохранена новая версия.' });
  }

  // ===== конструктор форм: сохранение/удаление/переключение (Владелец) =====
  if (pathName === '/panel/forms/save') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=forms&' + qs({ err: 'Формы может менять только Владелец.' });
    const fid = parseInt(body.get('id'), 10) || 0;
    const name = (body.get('name') || '').trim().slice(0, 80);
    const slug = (body.get('slug') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    const description = (body.get('description') || '').trim().slice(0, 500);
    const channelId = (body.get('channel_id') || '').trim();
    if (!name || !slug) return '/panel?tab=forms&' + qs({ err: 'Нужны название и адрес (slug).' });
    if (channelId && !/^[0-9]{5,25}$/.test(channelId)) return '/panel?tab=forms&' + qs({ err: 'ID канала — только цифры.' });
    const fields = sanitizeFormFields(body.get('fields'));
    if (!fields || !fields.length) return '/panel?tab=forms&' + qs({ err: 'Добавьте хотя бы одно корректное поле (у «выбор» нужны варианты).' });
    const dupe = await db.get('SELECT id FROM forms WHERE slug = ? AND id != ?', [slug, fid]).catch(() => null);
    if (dupe) return '/panel?tab=forms&' + qs({ err: 'Форма с таким адресом уже есть.' });
    const now = new Date().toISOString();
    if (fid) {
      await db.run('UPDATE forms SET name = ?, slug = ?, description = ?, fields = ?, channel_id = ? WHERE id = ?',
        [name, slug, description, JSON.stringify(fields), channelId || null, fid]);
    } else {
      await db.run('INSERT INTO forms (slug, name, description, fields, channel_id, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        [slug, name, description, JSON.stringify(fields), channelId || null, user.id, now]);
    }
    await webAuditMeta(client, user, 'Форма сохранена (сайт)', `${slug} — ${fields.length} полей`);
    return '/panel?tab=forms&' + qs({ ok: 'Форма сохранена.' });
  }
  if (pathName === '/panel/forms/delete') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=forms&' + qs({ err: 'Только Владелец.' });
    const fid = parseInt(body.get('id'), 10) || 0;
    await db.run('DELETE FROM form_submissions WHERE form_id = ?', [fid]).catch(() => {});
    await db.run('DELETE FROM forms WHERE id = ?', [fid]);
    await webAuditMeta(client, user, 'Форма удалена (сайт)', `#${fid}`);
    return '/panel?tab=forms&' + qs({ ok: 'Форма удалена.' });
  }
  if (pathName === '/panel/forms/toggle') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=forms&' + qs({ err: 'Только Владелец.' });
    const fid = parseInt(body.get('id'), 10) || 0;
    await db.run('UPDATE forms SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?', [fid]);
    return '/panel?tab=forms&' + qs({ ok: 'Готово.' });
  }
  // ===== разбор поданных заявок по формам (HR+) =====
  if (pathName === '/panel/forms/review') {
    if (acc.rank < LEVELS.hr) return '/panel?tab=forms&' + qs({ err: 'Недостаточно прав.' });
    const sid = parseInt(body.get('id'), 10) || 0;
    const act = body.get('act') === 'approve' ? 'approved' : 'rejected';
    const note = (body.get('note') || '').trim().slice(0, 300);
    const s = await db.get('SELECT * FROM form_submissions WHERE id = ?', [sid]);
    if (!s) return '/panel?tab=forms&' + qs({ err: 'Заявка не найдена.' });
    if (s.status !== 'pending') return '/panel?tab=forms&' + qs({ err: 'Заявка уже обработана.' });
    const f = await db.get('SELECT name, channel_id FROM forms WHERE id = ?', [s.form_id]).catch(() => null);
    await db.run('UPDATE form_submissions SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?',
      [act, user.id, note || null, new Date().toISOString(), sid]);
    try {
      await pushNotify(s.discord_id, 'form',
        act === 'approved'
          ? `Ваша заявка по форме «${(f && f.name) || 'форма'}» принята.`
          : `Ваша заявка по форме «${(f && f.name) || 'форма'}» отклонена${note ? ': ' + note : '.'}`,
        '/me');
    } catch (_) {}
    if (f && f.channel_id && s.message_id && g) {
      try {
        const ch = await g.channels.fetch(f.channel_id);
        const msg = await ch.messages.fetch(s.message_id);
        await msg.reply({ content: `${act === 'approved' ? '✅ Принято' : '❌ Отклонено'} — <@${user.id}>${note ? `\n> ${note}` : ''}`, allowedMentions: { parse: [] } });
        await msg.edit({ components: [] }).catch(() => {});
      } catch (_) {}
    }
    await webAudit(client, user, 'Заявка по форме рассмотрена (сайт)', `#${sid} «${(f && f.name) || ''}» → ${act === 'approved' ? 'принято' : 'отклонено'}`);
    return '/panel?tab=forms&' + qs({ ok: act === 'approved' ? 'Принято.' : 'Отклонено.' });
  }

  // ===== подача заявки по форме конструктора (любой вошедший) =====
  if (pathName === '/form/submit') {
    const slug = (body.get('slug') || '').trim().toLowerCase();
    const f = await db.get('SELECT * FROM forms WHERE slug = ?', [slug]).catch(() => null);
    if (!f || !f.active) return '/me?' + qs({ err: 'Форма недоступна.' });
    const back = '/form/' + encodeURIComponent(slug) + '?';
    let fields = [];
    try { fields = JSON.parse(f.fields || '[]'); } catch (_) {}
    const data = {};
    for (const fl of fields) {
      let v;
      if (fl.type === 'checkbox') {
        v = body.get('f_' + fl.key) === '1' ? 'да' : 'нет';
        if (fl.required && v !== 'да') return back + qs({ err: `Отметьте: ${fl.label}` });
      } else {
        v = (body.get('f_' + fl.key) || '').trim().slice(0, 4000);
        if (fl.type === 'select' && v && Array.isArray(fl.options) && !fl.options.includes(v)) v = '';
        if (fl.required && !v) return back + qs({ err: `Заполните поле: ${fl.label}` });
      }
      data[fl.key] = v;
    }
    if (await db.get("SELECT id FROM form_submissions WHERE form_id = ? AND discord_id = ? AND status = 'pending'", [f.id, user.id])) {
      return back + qs({ err: 'У вас уже есть заявка по этой форме на рассмотрении.' });
    }
    const now = new Date().toISOString();
    const r = await db.run(
      "INSERT INTO form_submissions (form_id, discord_id, discord_tag, data, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      [f.id, user.id, uname, JSON.stringify(data), now],
    );
    if (g && f.channel_id) {
      try {
        const emb = new EmbedBuilder().setColor(0x5865f2).setTitle(`📋 Форма: ${String(f.name).slice(0, 200)}`)
          .setDescription(`Заявка #${r.lastID} — <@${user.id}>`)
          .addFields(fields.slice(0, 25).map((fl) => ({
            name: String(fl.label).slice(0, 256),
            value: (String(data[fl.key] == null || data[fl.key] === '' ? '—' : data[fl.key])).slice(0, 1024),
          })));
        const sent = await postTo(client, f.channel_id, {
          embeds: [emb],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`formsub_ok:${r.lastID}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`formsub_no:${r.lastID}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
          )],
        });
        if (sent) await db.run('UPDATE form_submissions SET message_id = ? WHERE id = ?', [sent.id, r.lastID]);
      } catch (e) { console.error('[web] форма → канал:', e.message); }
    }
    await webAudit(client, user, 'Заявка по форме подана (сайт)', `#${r.lastID} «${f.name}»`);
    return back + qs({ ok: 'Заявка отправлена на рассмотрение.' });
  }

  // ===== локальные аккаунты (только havirys) =====
  if (pathName.startsWith('/panel/accounts/')) {
    if (user.id !== OWNER_ID) return '/panel?tab=accounts&' + qs({ err: 'Только havirys.' });
    const lid = (body.get('id') || '').trim();
    if (pathName === '/panel/accounts/link') {
      const p = (body.get('participant') || '').trim();
      let pid = null;
      if (/^[0-9]{5,25}$/.test(p)) pid = p;
      else if (p) { const row = await db.get('SELECT discord_id FROM participants WHERE static = ? UNION SELECT discord_id FROM extra_passports WHERE static = ? LIMIT 1', [p, p]).catch(() => null); pid = row && row.discord_id; }
      if (!pid) return '/panel?tab=accounts&' + qs({ err: 'Участник не найден (Discord ID или № паспорта).' });
      await db.run('UPDATE web_users SET linked_discord_id = ?, sess_ver = COALESCE(sess_ver,0)+1 WHERE discord_id = ? AND is_local = 1', [pid, lid]);
      _sessVerCache.delete(lid); accessCache.delete(lid);
      await webAuditMeta(client, user, 'Локальный аккаунт привязан к участнику', `${lid} → ${pid}`);
      return '/panel?tab=accounts&' + qs({ ok: 'Привязано. Пользователю нужно войти заново.' });
    }
    if (pathName === '/panel/accounts/unlink') {
      await db.run('UPDATE web_users SET linked_discord_id = NULL, sess_ver = COALESCE(sess_ver,0)+1 WHERE discord_id = ? AND is_local = 1', [lid]);
      _sessVerCache.delete(lid);
      await webAuditMeta(client, user, 'Локальный аккаунт отвязан', lid);
      return '/panel?tab=accounts&' + qs({ ok: 'Отвязано.' });
    }
    if (pathName === '/panel/accounts/reset_pw') {
      const temp = crypto.randomBytes(6).toString('base64url');
      const rec = pwMake(temp);
      await db.run('UPDATE web_users SET pass_hash = ?, pass_salt = ?, sess_ver = COALESCE(sess_ver,0)+1 WHERE discord_id = ? AND is_local = 1', [rec.hash, rec.salt, lid]);
      _sessVerCache.delete(lid);
      await webAuditMeta(client, user, 'Сброшен пароль локального аккаунта', lid);
      return '/panel?tab=accounts&' + qs({ ok: `Временный пароль: ${temp} — передайте пользователю, пусть сменит.` });
    }
    if (pathName === '/panel/accounts/reset_done') {
      await db.run("UPDATE password_reset_requests SET status = 'done', resolved_by = ?, resolved_at = ? WHERE id = ?", [user.id, new Date().toISOString(), parseInt(body.get('id'), 10) || 0]);
      return '/panel?tab=accounts&' + qs({ ok: 'Заявка закрыта.' });
    }
    return '/panel?tab=accounts';
  }

  // ===== рассылка (Владелец) =====
  if (pathName === '/panel/broadcast') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=broadcast&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=broadcast&' + qs({ err: 'Бот недоступен.' });
    const text = (body.get('text') || '').trim();
    if (!text) return '/panel?tab=broadcast&' + qs({ err: 'Пустой текст.' });
    const mode = body.get('mode');
    if (mode === 'channel') {
      const cid = (body.get('channel_id') || '').trim();
      if (!/^[0-9]+$/.test(cid)) return '/panel?tab=broadcast&' + qs({ err: 'Укажите ID канала.' });
      const sent = await postTo(client, cid, { content: text });
      if (!sent) return '/panel?tab=broadcast&' + qs({ err: 'Не удалось отправить (проверьте ID).' });
      await webAudit(client, user, 'Рассылка в канал (сайт)', `<#${cid}>: ${text.slice(0, 200)}`);
      return '/panel?tab=broadcast&' + qs({ ok: 'Отправлено.' });
    }
    const people = await db.all('SELECT discord_id, name, static, role_id FROM participants');
    const hasPlaceholders = /\{(имя|паспорт|ранг)\}/.test(text);
    (async () => {
      let ok = 0;
      for (const pr of people) {
        const msg = hasPlaceholders
          ? text.replace(/\{имя\}/g, pr.name || '').replace(/\{паспорт\}/g, pr.static || '').replace(/\{ранг\}/g, roleName(client, pr.role_id))
          : text;
        if (await dmTo(client, pr.discord_id, { content: msg })) ok++;
        await new Promise((r) => setTimeout(r, 1200));
      }
      await webAudit(client, user, 'Рассылка в ЛС (сайт)', `доставлено ${ok}/${people.length}: ${text.slice(0, 150)}`).catch(() => {});
    })();
    return '/panel?tab=broadcast&' + qs({ ok: `Рассылка запущена для ${people.length} участников (идёт в фоне).` });
  }

  // ===== переключатели фич (Владелец) =====
  if (pathName === '/panel/feature/toggle') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=settings&' + qs({ err: 'Недостаточно прав.' });
    const key = (body.get('key') || '').trim();
    if (!FEATURE_FLAGS.some(([k]) => k === key)) return '/panel?tab=settings&' + qs({ err: 'Неизвестный переключатель.' });
    await db.setSetting(`feature_${key}_enabled`, body.get('on') === '1' ? 'true' : 'false');
    await webAuditMeta(client, user, 'Переключатель фичи (сайт)', `${key} → ${body.get('on') === '1' ? 'вкл' : 'выкл'}`);
    return '/panel?tab=settings&' + qs({ ok: 'Готово.' });
  }

  // ===== настройки (Владелец) =====
  if (pathName === '/panel/setting/save') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=settings&' + qs({ err: 'Недостаточно прав.' });
    const key = (body.get('key') || '').trim();
    if (!key) return '/panel?tab=settings&' + qs({ err: 'Пустой ключ.' });
    await db.setSetting(key, (body.get('value') || '').trim());
    await webAuditMeta(client, user, 'Настройка изменена (сайт)', `${key} = ${(body.get('value') || '').slice(0, 100)}`);
    return '/panel?tab=settings&' + qs({ ok: 'Сохранено.' });
  }

  // ===== права команд (только havirys) =====
  if (pathName === '/panel/perm/save' || pathName === '/panel/perm/reset') {
    if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только для владельца-аккаунта.' });
    const name = body.get('name');
    if (!name || !(HOOKS.commandDefaultTiers || {})[name]) return '/panel?tab=perms&' + qs({ err: 'Неизвестная команда.' });
    if (pathName === '/panel/perm/reset') {
      await db.run('DELETE FROM command_permission_overrides WHERE command_name = ?', [name]);
      await webAuditMeta(client, user, 'Право команды сброшено (сайт)', `/${name}`);
      return '/panel?tab=perms&' + qs({ ok: 'Сброшено к значению по умолчанию.' });
    }
    const tier = body.get('tier');
    if (!(HOOKS.tierLabels || {})[tier]) return '/panel?tab=perms&' + qs({ err: 'Неизвестный тир.' });
    await db.run(
      `INSERT INTO command_permission_overrides (command_name, tier) VALUES (?, ?)
       ON CONFLICT(command_name) DO UPDATE SET tier = excluded.tier`,
      [name, tier],
    );
    await webAuditMeta(client, user, 'Право команды изменено (сайт)', `/${name} → ${tier}`);
    return '/panel?tab=perms&' + qs({ ok: 'Тир обновлён.' });
  }

  // ===== розыгрыши: расширенное (Владелец) =====
  if (pathName === '/panel/giveaway/reroll' || pathName === '/panel/giveaway/entry_add' || pathName === '/panel/giveaway/entry_remove') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    const gid = parseInt(body.get('id'), 10) || 0;
    const gv = await giveaways.getGiveaway(gid);
    if (!gv) return '/panel?tab=giveaways&' + qs({ err: 'Розыгрыш не найден.' });
    if (pathName === '/panel/giveaway/entry_add') {
      const did = (body.get('did') || '').trim();
      if (!/^[0-9]+$/.test(did)) return '/panel?tab=giveaways&' + qs({ err: 'Неверный ID.' });
      await giveaways.addEntry(gid, did);
      await webAudit(client, user, 'Розыгрыш: добавлен участник (сайт)', `#${gid} <@${did}>`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Участник добавлен.' });
    }
    if (pathName === '/panel/giveaway/entry_remove') {
      const did = (body.get('did') || '').trim();
      await giveaways.removeEntry(gid, did);
      await webAudit(client, user, 'Розыгрыш: удалён участник (сайт)', `#${gid} <@${did}>`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Участник удалён.' });
    }
    // reroll
    if (gv.status !== 'ended') return '/panel?tab=giveaways&' + qs({ err: 'Реролл только для завершённого розыгрыша.' });
    const entries = await giveaways.getEntries(gid);
    const prev = new Set((gv.winners || '').split(',').filter(Boolean));
    const pool = entries.filter((e) => !prev.has(e));
    const fresh = giveaways.pickWinners(pool.length ? pool : entries, gv.winners_count);
    await giveaways.setWinners(gid, fresh.join(','));
    if (g && gv.channel_id) {
      await postTo(client, gv.channel_id, { content: `🎲 Реролл розыгрыша «${gv.prize}» — новые победители: ${fresh.map((w) => `<@${w}>`).join(', ') || 'никого'}` });
    }
    await webAudit(client, user, 'Розыгрыш: реролл (сайт)', `#${gid} → ${fresh.join(', ') || '—'}`);
    return '/panel?tab=giveaways&' + qs({ ok: 'Победители перевыбраны.' });
  }
  if (pathName === '/panel/gwbl/add' || pathName === '/panel/gwbl/remove') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    const did = (body.get('did') || '').trim();
    if (!/^[0-9]+$/.test(did)) return '/panel?tab=giveaways&' + qs({ err: 'Неверный ID.' });
    if (pathName === '/panel/gwbl/add') {
      await giveaways.addToBlacklist(did, (body.get('reason') || '').trim(), user.id);
      await webAudit(client, user, 'ЧС розыгрышей + (сайт)', `<@${did}>`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Добавлен в ЧС розыгрышей.' });
    }
    await giveaways.removeFromBlacklist(did);
    await webAudit(client, user, 'ЧС розыгрышей − (сайт)', `<@${did}>`);
    return '/panel?tab=giveaways&' + qs({ ok: 'Убран из ЧС розыгрышей.' });
  }

  // ===== массовые действия над участниками (Зам.+) =====
  if (pathName === '/people/bulk') {
    if (acc.rank < LEVELS.deputy) return '/people?' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/people?' + qs({ err: 'Бот недоступен.' });
    const ids = body.getAll('ids').filter((x) => /^\d{5,25}$/.test(x));
    const act = body.get('act');
    if (!ids.length) return '/people?' + qs({ err: 'Никто не выбран.' });
    if (act === 'rank_recalc') {
      await hook('runWeeklyRankAdjustment')(g, true);
      await webAudit(client, user, 'Пересчёт рангов (сайт)', `инициировано, выбрано ${ids.length}`);
      return '/people?' + qs({ ok: 'Пересчёт рангов запущен.' });
    }
    if (act === 'vacation') {
      const deadline = dates.parseDeadline(body.get('deadline') || '');
      if (!deadline) return '/people?' + qs({ err: 'Неверная дата отпуска.' });
      for (const did of ids) {
        const ps = await passportsLib.getAllPassports(did);
        for (const pp of ps) {
          await passportsLib.updatePassportFields(did, pp.static, { vacation_until: deadline.toISOString() });
          await history.logStatusGranted('vacation', did, pp.static, pp.name, 'массовая выдача', deadline.toISOString(), user.id).catch(() => {});
        }
        await hook('syncStatusRoles')(g, did);
      }
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'Массовый отпуск (сайт)', `${ids.length} чел. до ${dates.formatDateTime(deadline)}`);
      return '/people?' + qs({ ok: `Отпуск выдан ${ids.length} участникам.` });
    }
    if (act === 'dm') {
      const text = (body.get('text') || '').trim();
      if (!text) return '/people?' + qs({ err: 'Пустой текст.' });
      (async () => {
        let ok = 0;
        for (const did of ids) { if (await dmTo(client, did, { content: text })) ok++; await new Promise((r) => setTimeout(r, 1000)); }
        await webAudit(client, user, 'Массовая ЛС-рассылка (сайт)', `${ok}/${ids.length}: ${text.slice(0, 150)}`).catch(() => {});
      })();
      return '/people?' + qs({ ok: `Рассылка запущена для ${ids.length} участников.` });
    }
    return '/people?' + qs({ err: 'Неизвестное действие.' });
  }

  // ===== голос за гайд FAQ =====
  if (pathName === '/faq/vote') {
    const eid = parseInt(body.get('id'), 10) || 0;
    const v = body.get('v') === '1' ? 1 : 0;
    if (!(await db.get('SELECT id FROM faq_entries WHERE id = ?', [eid]))) return '/faq?' + qs({ err: 'Гайд не найден.' });
    await db.run('DELETE FROM faq_feedback WHERE entry_id = ? AND discord_id = ?', [eid, user.id]);
    await db.run('INSERT INTO faq_feedback (entry_id, discord_id, helpful, at) VALUES (?, ?, ?, ?)', [eid, user.id, v, new Date().toISOString()]);
    return '/faq?' + qs({ ok: 'Спасибо за оценку.' });
  }

  // ===== участие в розыгрыше с сайта =====
  if (pathName === '/g/grant_role') {
    if (acc.rank < LEVELS.owner) return '/giveaways?' + qs({ err: 'Только Владелец.' });
    const gid = parseInt(body.get('id'), 10) || 0;
    const roleId = (body.get('role_id') || '').trim();
    if (!/^[0-9]{5,25}$/.test(roleId)) return `/g/${gid}?` + qs({ err: 'Укажите ID роли.' });
    if (!g || !g.roles.cache.get(roleId)) return `/g/${gid}?` + qs({ err: 'Роль не найдена на сервере.' });
    const ents = await giveaways.getEntries(gid).catch(() => []);
    (async () => {
      let ok = 0;
      for (const uid of ents) {
        try { const m = await g.members.fetch(uid); await m.roles.add(roleId); ok++; } catch (_) {}
        await new Promise((r) => setTimeout(r, 350));
      }
      await webAudit(client, user, 'Выдача роли участникам розыгрыша (сайт)', `#${gid} → роль ${roleId}: ${ok}/${ents.length}`).catch(() => {});
    })();
    return `/g/${gid}?` + qs({ ok: `Выдача роли запущена для ${ents.length} участников (идёт в фоне).` });
  }

  if (pathName === '/g/enter') {
    if (acc.rank < LEVELS.member) return '/me?' + qs({ err: 'Участвовать в розыгрышах могут только участники организации.' });
    const gid = parseInt(body.get('id'), 10) || 0;
    const gv = await giveaways.getGiveaway(gid);
    if (!gv || gv.status !== 'active') return '/giveaways?' + qs({ err: 'Розыгрыш недоступен.' });
    if (!g) return `/g/${gid}?` + qs({ err: 'Бот недоступен.' });
    const already = await giveaways.hasEntry(gid, user.id);
    if (!already) {
      if (await giveaways.isBlacklisted(user.id)) return `/g/${gid}?` + qs({ err: 'Вы в ЧС розыгрышей.' });
      let m;
      try { m = await g.members.fetch(user.id); } catch (_) { return `/g/${gid}?` + qs({ err: 'Вас нет на Discord-сервере.' }); }
      if (gv.required_role_id && !m.roles.cache.has(gv.required_role_id)) return `/g/${gid}?` + qs({ err: 'Нужна нужная роль.' });
      if (gv.min_role_id && !giveaways.meetsMinRole(m, gv.min_role_id)) return `/g/${gid}?` + qs({ err: 'Ранг ниже минимального.' });
      if (gv.min_contracts_week) {
        const r = contracts.getWeekRange(0);
        const cw = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status='fulfilled' AND submitted_at BETWEEN ? AND ?", [user.id, r.start.toISOString(), r.end.toISOString()]).then((x) => (x ? x.c : 0)).catch(() => 0);
        if (cw < gv.min_contracts_week) return `/g/${gid}?` + qs({ err: `Нужно ≥ ${gv.min_contracts_week} выполненных контрактов за эту неделю (у вас ${cw}).` });
      }
      await giveaways.addEntry(gid, user.id);
    } else {
      await giveaways.removeEntry(gid, user.id);
    }
    const cnt = await giveaways.countEntries(gid);
    if (gv.message_id) {
      try {
        const ch = await g.channels.fetch(gv.channel_id);
        const msg = await ch.messages.fetch(gv.message_id);
        const emb = msg.embeds[0];
        if (emb) {
          const eb = EmbedBuilder.from(emb);
          const fields = (emb.fields || []).map((f) => (/участник/i.test(f.name) ? { ...f, value: String(cnt) } : f));
          eb.setFields(fields);
          await msg.edit({ embeds: [eb] });
        }
      } catch (_) {}
    }
    await webAudit(client, user, already ? 'Выход из розыгрыша (сайт)' : 'Участие в розыгрыше (сайт)', `#${gid} «${gv.prize}»`);
    return `/g/${gid}?` + qs({ ok: already ? 'Вы вышли из розыгрыша.' : 'Вы участвуете! Удачи 🍀' });
  }

  // ===== синхронизация авто-ролей за бейджи =====
  if (pathName === '/tools/badge_sync') {
    if (acc.rank < LEVELS.owner) return '/tools?' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/tools?' + qs({ err: 'Бот недоступен.' });
    webAuditMeta(client, user, 'Синхронизация бейдж-ролей (сайт)', 'запущено').catch(() => {});
    badges.syncAllRoles(g).catch((e) => console.error('[web] badge sync:', e.message));
    return '/tools?' + qs({ ok: 'Синхронизация запущена (идёт в фоне, создаст недостающие роли).' });
  }

  // ===== SLA: взять заявку/тикет на себя =====
  if (pathName === '/panel/sla/claim') {
    if (acc.rank < LEVELS.hr) return '/panel?tab=sla&' + qs({ err: 'Недостаточно прав.' });
    const table = body.get('table');
    const allowed = ['applications', 'kicks', 'vacations', 'passport_requests', 'data_change_requests', 'hr_applications', 'tickets'];
    if (!allowed.includes(table)) return '/panel?tab=sla&' + qs({ err: 'Неизвестная таблица.' });
    const id = parseInt(body.get('id'), 10) || 0;
    await db.run(`UPDATE ${table} SET assigned_to = ?, assigned_at = ? WHERE id = ?`, [user.id, new Date().toISOString(), id]).catch(() => {});
    await webAudit(client, user, 'Взято на рассмотрение (сайт)', `${table} #${id}`);
    return '/panel?tab=sla&' + qs({ ok: 'Назначено на вас.' });
  }

  // ===== шаблоны рассылок =====
  if (pathName === '/panel/broadcast/tpl_save') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=broadcast&' + qs({ err: 'Недостаточно прав.' });
    const name = (body.get('name') || '').trim().slice(0, 80);
    const text = (body.get('text') || '').trim();
    if (!name || !text) return '/panel?tab=broadcast&' + qs({ err: 'Нужны название и текст.' });
    await db.run('INSERT INTO broadcast_templates (name, text, created_by, created_at) VALUES (?, ?, ?, ?)', [name, text, user.id, new Date().toISOString()]);
    return '/panel?tab=broadcast&' + qs({ ok: 'Шаблон сохранён.' });
  }
  if (pathName === '/panel/broadcast/tpl_delete') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=broadcast&' + qs({ err: 'Недостаточно прав.' });
    await db.run('DELETE FROM broadcast_templates WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
    return '/panel?tab=broadcast&' + qs({ ok: 'Шаблон удалён.' });
  }

  // ===== отложенный розыгрыш =====
  if (pathName === '/panel/giveaway/schedule') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    const prize = (body.get('prize') || '').trim().slice(0, 200);
    const winners = parseInt(body.get('winners'), 10) || 0;
    const durMs = giveaways.parseDuration((body.get('duration') || '').trim());
    const channelId = (body.get('channel_id') || '').trim();
    const roleId = (body.get('role_id') || '').trim() || null;
    const minRoleId = (body.get('min_role_id') || '').trim() || null;
    const ptRaw = (body.get('prize_tiers') || '').trim().slice(0, 800);
    const prizeTiers = giveaways.parsePrizeTiers(ptRaw).length ? ptRaw : null;
    const startAt = dates.parseDeadline(body.get('start_at') || '') || (function () {
      const d = new Date(body.get('start_at'));
      return Number.isNaN(d.getTime()) ? null : d;
    })();
    if (!prize || winners < 1 || !durMs || !/^[0-9]+$/.test(channelId) || !startAt) {
      return '/panel?tab=giveaways&' + qs({ err: 'Проверьте поля (приз, победители, длительность, ID канала, дата старта).' });
    }
    await db.run(
      `INSERT INTO scheduled_giveaways (prize, winners_count, channel_id, duration_ms, required_role_id, min_role_id, prize_tiers, start_at, host_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [prize, winners, channelId, durMs, roleId, minRoleId, prizeTiers, startAt.toISOString(), user.id, new Date().toISOString()],
    );
    await webAudit(client, user, 'Запланирован розыгрыш (сайт)', `«${prize}» на ${dates.formatDateTime(startAt)}`);
    return '/panel?tab=giveaways&' + qs({ ok: 'Розыгрыш запланирован.' });
  }
  if (pathName === '/panel/giveaway/schedule_cancel') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    await db.run("UPDATE scheduled_giveaways SET status='cancelled' WHERE id = ? AND status='pending'", [parseInt(body.get('id'), 10) || 0]);
    await webAudit(client, user, 'Отменён отложенный розыгрыш (сайт)', `#${body.get('id')}`);
    return '/panel?tab=giveaways&' + qs({ ok: 'Отменено.' });
  }
  if (pathName === '/panel/giveaway/tpl_save' || pathName === '/panel/giveaway/tpl_del') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    if (pathName === '/panel/giveaway/tpl_del') {
      await db.run('DELETE FROM giveaway_templates WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
      return '/panel?tab=giveaways&' + qs({ ok: 'Шаблон удалён.' });
    }
    const name = (body.get('name') || '').trim().slice(0, 60);
    const prize = (body.get('prize') || '').trim().slice(0, 200);
    if (!name || !prize) return '/panel?tab=giveaways&' + qs({ err: 'Нужны название и приз.' });
    await db.run(
      'INSERT INTO giveaway_templates (name, prize, winners_count, duration, required_role_id, min_role_id, prize_tiers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, prize, parseInt(body.get('winners'), 10) || 1, (body.get('duration') || '').trim().slice(0, 10),
       (body.get('role_id') || '').trim() || null, (body.get('min_role_id') || '').trim() || null,
       (body.get('prize_tiers') || '').trim().slice(0, 800) || null, new Date().toISOString()],
    );
    return '/panel?tab=giveaways&' + qs({ ok: 'Шаблон сохранён.' });
  }

  // ===== сообщение в тикет с сайта =====
  if (pathName === '/ticket/post') {
    const tid = parseInt(body.get('id'), 10) || 0;
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [tid]);
    if (!t) return '/me?' + qs({ err: 'Тикет не найден.' });
    if (t.opener_id !== user.id && acc.rank < LEVELS.hr) return '/me?' + qs({ err: 'Это не ваш тикет.' });
    const text = (body.get('text') || '').trim().slice(0, 1800);
    if (!text) return `/ticket/${tid}?` + qs({ err: 'Пустое сообщение.' });
    const sent = await postTo(client, t.channel_id, { content: `**${uname} (сайт):** ${text}`, allowedMentions: { parse: [] } });
    if (!sent) return `/ticket/${tid}?` + qs({ err: 'Не удалось отправить (канал закрыт?).' });
    await db.run('UPDATE tickets SET last_activity = ?, autoclose_warned = 0 WHERE id = ?', [new Date().toISOString(), tid]).catch(() => {});
    if (t.opener_id && t.opener_id !== user.id) await pushNotify(t.opener_id, 'ticket', `Ответ в тикете «${t.subject || 'Тикет'}»`, `/ticket/${tid}`).catch(() => {});
    return `/ticket/${tid}?` + qs({ ok: 'Отправлено.' });
  }

  // ===== транскрипт переписки тикета (по запросу) =====
  if (pathName === '/ticket/transcript') {
    const tid = parseInt(body.get('id'), 10) || 0;
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [tid]);
    if (!t) return '/me?' + qs({ err: 'Тикет не найден.' });
    if (t.opener_id !== user.id && acc.rank < LEVELS.hr) return '/me?' + qs({ err: 'Это не ваш тикет.' });
    let built;
    try {
      built = await buildTicketTranscriptHtml(client, t);
    } catch (e) {
      return `/ticket/${tid}?` + qs({ err: 'Не удалось собрать транскрипт: ' + e.message });
    }
    const buf = Buffer.from(built.html, 'utf8');
    await db.run(
      `INSERT INTO ticket_transcripts (ticket_id, html, msg_count, generated_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET html = excluded.html, msg_count = excluded.msg_count, generated_by = excluded.generated_by, created_at = excluded.created_at`,
      [tid, buf, built.count, user.id, new Date().toISOString()],
    );
    await webAudit(client, user, 'Транскрипт тикета собран (сайт)', `#${tid} — ${built.count} сообщ.`);
    return `/ticket/${tid}?` + qs({ ok: `Транскрипт готов (${built.count} сообщ.).` });
  }

  // ===== оценка тикета автором (после закрытия) =====
  if (pathName === '/ticket/rate') {
    const tid = parseInt(body.get('id'), 10) || 0;
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [tid]);
    if (!t) return '/me?' + qs({ err: 'Тикет не найден.' });
    if (t.opener_id !== user.id) return `/ticket/${tid}?` + qs({ err: 'Оценить может только автор.' });
    if (t.status === 'open') return `/ticket/${tid}?` + qs({ err: 'Тикет ещё открыт.' });
    if (t.rating != null) return `/ticket/${tid}?` + qs({ err: 'Уже оценён.' });
    const r = body.get('r') === '1' ? 1 : 0;
    await db.run('UPDATE tickets SET rating = ?, rated_at = ? WHERE id = ?', [r, new Date().toISOString(), tid]);
    await webAudit(client, user, 'Оценка тикета (сайт)', `#${tid} — ${r ? '👍' : '👎'}`);
    return `/ticket/${tid}?` + qs({ ok: 'Спасибо за оценку!' });
  }

  // ===== шаблоны ответов в тикетах (HR+) =====
  if (pathName === '/ticket/tpl_add' || pathName === '/ticket/tpl_del') {
    if (acc.rank < LEVELS.hr) return '/me?' + qs({ err: 'Недостаточно прав.' });
    const tid = parseInt(body.get('tid'), 10) || 0;
    if (pathName === '/ticket/tpl_add') {
      const name = (body.get('name') || '').trim().slice(0, 60);
      const text = (body.get('text') || '').trim().slice(0, 1500);
      if (name && text) await db.run('INSERT INTO ticket_reply_templates (name, text, created_at) VALUES (?, ?, ?)', [name, text, new Date().toISOString()]);
    } else {
      await db.run('DELETE FROM ticket_reply_templates WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
    }
    return `/ticket/${tid}?` + qs({ ok: 'Готово.' });
  }

  // ===== приоритет / назначение / закрытие / переоткрытие тикета (HR+) =====
  if (['/ticket/meta', '/ticket/assign', '/ticket/close', '/ticket/reopen', '/ticket/close_reason_add', '/ticket/close_reason_del'].includes(pathName)) {
    if (acc.rank < LEVELS.hr) return '/me?' + qs({ err: 'Недостаточно прав.' });
    const tid = parseInt(body.get('id') || body.get('tid'), 10) || 0;
    const back = `/ticket/${tid}?`;
    if (pathName === '/ticket/close_reason_add') {
      const text = (body.get('text') || '').trim().slice(0, 200);
      if (text) await db.run('INSERT INTO ticket_close_reasons (text, created_at) VALUES (?, ?)', [text, new Date().toISOString()]);
      return back + qs({ ok: 'Добавлено.' });
    }
    if (pathName === '/ticket/close_reason_del') {
      await db.run('DELETE FROM ticket_close_reasons WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
      return back + qs({ ok: 'Удалено.' });
    }
    const t = await db.get('SELECT * FROM tickets WHERE id = ?', [tid]);
    if (!t) return '/me?' + qs({ err: 'Тикет не найден.' });
    if (pathName === '/ticket/meta') {
      const pri = ['normal', 'high', 'low'].includes(body.get('priority')) ? body.get('priority') : 'normal';
      const tags = (body.get('tags') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10).join(',');
      const cat = Object.keys(TICKET_CAT_RU).filter((k) => k !== 'appeal').includes(body.get('category')) ? body.get('category') : null;
      await db.run(`UPDATE tickets SET priority = ?, tags = ?${cat ? ', category = ?' : ''} WHERE id = ?`,
        cat ? [pri === 'normal' ? null : pri, tags || null, cat, tid] : [pri === 'normal' ? null : pri, tags || null, tid]);
      // Эмодзи-префикс в названии канала по первой известной метке (или приоритету).
      if (g && t.channel_id && t.status === 'open') {
        try {
          const EMO = { 'оплата': '💰', 'срочно': '🔴', 'срочный': '🔴', 'баг': '🐞', 'жалоба': '⚠️', 'важно': '❗' };
          let want = (tags.split(',').map((x) => EMO[x]).find(Boolean)) || (pri === 'high' ? '🔴' : '');
          const ch = await g.channels.fetch(t.channel_id);
          let nm = ch.name.replace(/^(?:💰|🔴|🐞|⚠️|❗)-?/u, '');
          const next = (want ? want + '-' : '') + nm;
          if (next !== ch.name && next.length <= 100) await ch.setName(next.slice(0, 100)).catch(() => {});
        } catch (_) {}
      }
      await webAudit(client, user, 'Тикет: приоритет/категория/метки (сайт)', `#${tid} → ${pri}${cat ? ' /' + cat : ''}${tags ? ' [' + tags + ']' : ''}`);
      return back + qs({ ok: 'Сохранено.' });
    }
    if (pathName === '/ticket/assign') {
      if (body.get('clear') === '1') {
        await db.run('UPDATE tickets SET assigned_to = NULL, assigned_at = NULL WHERE id = ?', [tid]);
      } else {
        await db.run('UPDATE tickets SET assigned_to = ?, assigned_at = ? WHERE id = ?', [user.id, new Date().toISOString(), tid]);
      }
      await webAudit(client, user, 'Тикет: назначение (сайт)', `#${tid} → ${body.get('clear') === '1' ? 'снято' : user.username}`);
      return back + qs({ ok: 'Готово.' });
    }
    if (pathName === '/ticket/close') {
      if (t.status !== 'open') return back + qs({ err: 'Тикет уже закрыт.' });
      const reason = (body.get('reason') || '').trim().slice(0, 500);
      await db.run("UPDATE tickets SET status = 'archived', closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ?",
        [new Date().toISOString(), user.id, reason || null, tid]);
      if (g && t.channel_id) {
        try {
          const ch = await g.channels.fetch(t.channel_id);
          await ch.permissionOverwrites.edit(t.opener_id, { ViewChannel: false, SendMessages: false }).catch(() => {});
          await ch.setParent(config.CHANNEL_TICKETS_ARCHIVE_CATEGORY, { lockPermissions: false }).catch(() => {});
          if (!ch.name.startsWith('закрыт-')) await ch.setName(`закрыт-${ch.name}`.slice(0, 100)).catch(() => {});
          await ch.send({ content: `🔒 Тикет закрыт с сайта — ${uname}${reason ? `\nПричина: ${reason}` : ''}` }).catch(() => {});
        } catch (_) {}
      }
      if (t.opener_id && t.opener_id !== user.id) await pushNotify(t.opener_id, 'ticket', `Тикет «${t.subject || 'Тикет'}» закрыт${reason ? `: ${reason}` : ''}`, `/ticket/${tid}`).catch(() => {});
      await webAudit(client, user, 'Тикет закрыт (сайт)', `#${tid}${reason ? ' — ' + reason : ''}`);
      return back + qs({ ok: 'Тикет закрыт.' });
    }
    if (pathName === '/ticket/reopen') {
      await db.run("UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?", [tid]);
      if (g && t.channel_id) {
        try {
          const ch = await g.channels.fetch(t.channel_id);
          await ch.permissionOverwrites.edit(t.opener_id, { ViewChannel: true, SendMessages: true }).catch(() => {});
          await ch.setParent(config.CHANNEL_TICKETS_ACTIVE_CATEGORY, { lockPermissions: false }).catch(() => {});
          if (ch.name.startsWith('закрыт-')) await ch.setName(ch.name.replace(/^закрыт-/, '').slice(0, 100)).catch(() => {});
          await ch.send({ content: `🔓 Тикет переоткрыт с сайта — ${uname}` }).catch(() => {});
        } catch (_) {}
      }
      if (t.opener_id && t.opener_id !== user.id) await pushNotify(t.opener_id, 'ticket', `Тикет «${t.subject || 'Тикет'}» переоткрыт`, `/ticket/${tid}`).catch(() => {});
      await webAudit(client, user, 'Тикет переоткрыт (сайт)', `#${tid}`);
      return back + qs({ ok: 'Тикет переоткрыт.' });
    }
    return back;
  }

  // ===== проверка контракта (HR+) =====
  if (pathName === '/panel/contract/review') {
    if (!(await panelActionAllowed(client, user, acc, 'contracts_check'))) return '/panel?tab=contracts_check&' + qs({ err: 'Недостаточно прав.' });
    const id = parseInt(body.get('id'), 10) || 0;
    const verdict = body.get('verdict');
    if (!['fulfilled', 'unfulfilled', 'rejected'].includes(verdict)) return '/panel?tab=contracts_check&' + qs({ err: 'Неизвестный вердикт.' });
    const cn = await contracts.getContractById(id).catch(() => null);
    if (!cn || cn.status !== 'pending') return '/panel?tab=contracts_check&' + qs({ err: 'Уже проверен или не найден.' });
    await contracts.reviewContract(id, verdict, user.id);
    try { await contractsDisplay.safeUpdateContractsStats(g); } catch (_) {}
    if (cn.thread_id && (verdict === 'fulfilled' || verdict === 'unfulfilled')) {
      try { await hook('checkContractPromotion')(g, cn.thread_id); } catch (_) {}
    }
    await webAudit(client, user, 'Контракт проверен (сайт)', `#${id} → ${verdict}`);
    return '/panel?tab=contracts_check&' + qs({ ok: 'Готово.' });
  }

  // массовая простановка вердикта (обычно «выполнен») по списку id
  if (pathName === '/panel/contract/review_bulk') {
    if (!(await panelActionAllowed(client, user, acc, 'contracts_check'))) return '/panel?tab=contracts_check&' + qs({ err: 'Недостаточно прав.' });
    const verdict = ['fulfilled', 'unfulfilled', 'rejected'].includes(body.get('verdict')) ? body.get('verdict') : 'fulfilled';
    const ids = (body.get('ids') || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 100);
    let done = 0;
    for (const id of ids) {
      const cn = await contracts.getContractById(id).catch(() => null);
      if (!cn || cn.status !== 'pending') continue;
      await contracts.reviewContract(id, verdict, user.id).catch(() => {});
      if (cn.thread_id && (verdict === 'fulfilled' || verdict === 'unfulfilled')) {
        try { await hook('checkContractPromotion')(g, cn.thread_id); } catch (_) {}
      }
      done++;
    }
    try { await contractsDisplay.safeUpdateContractsStats(g); } catch (_) {}
    await webAudit(client, user, 'Контракты проверены массово (сайт)', `${done} шт → ${verdict}`);
    return '/panel?tab=contracts_check&' + qs({ ok: `Проверено: ${done}.` });
  }

  // ===== снять взятый контракт (руководство, до сдачи итога) =====
  if (pathName === '/panel/contract/abandon') {
    if (!(await panelActionAllowed(client, user, acc, 'contracts_check'))) return '/panel?tab=contracts_check&' + qs({ err: 'Недостаточно прав.' });
    const id = parseInt(body.get('id'), 10) || 0;
    const cn = await db.get("SELECT id, discord_id, thread_id FROM contracts WHERE id = ? AND status = 'taken'", [id]).catch(() => null);
    if (!cn) return '/panel?tab=contracts_check&' + qs({ err: 'Контракт не найден или уже не «в работе».' });
    for (const up of await db.all('SELECT file FROM contract_uploads WHERE contract_id = ?', [id]).catch(() => [])) {
      if (up.file) await deleteUploadFile(up.file);
    }
    await db.run('DELETE FROM contract_uploads WHERE contract_id = ?', [id]).catch(() => {});
    await db.run("UPDATE contracts SET status = 'abandoned' WHERE id = ?", [id]);
    try { await contractsDisplay.safeUpdateContractsStats(g); } catch (_) {}
    await pushNotify(cn.discord_id, 'contract', `Взятый контракт #${id} снят руководством — не засчитан`, '/me').catch(() => {});
    await webAudit(client, user, 'Взятый контракт снят (сайт)', `#${id} у <@${cn.discord_id}>`);
    return '/panel?tab=contracts_check&' + qs({ ok: `Контракт #${id} снят.` });
  }

  // ===== гайды FAQ (Владелец) =====
  if (pathName.startsWith('/panel/faq/')) {
    if (acc.rank < LEVELS.owner) return '/panel?tab=faq_manage&' + qs({ err: 'Недостаточно прав.' });
    const refreshCat = async (cat) => { try { if (g) await faqDisplay.safeUpdateFaqChannel(g, cat); } catch (_) {} };
    if (pathName === '/panel/faq/add') {
      const cat = ['public', 'hr', 'member'].includes(body.get('category')) ? body.get('category') : 'member';
      const title = (body.get('title') || '').trim().slice(0, 120);
      const cont = (body.get('content') || '').trim().slice(0, 3000);
      if (!title || !cont) return '/panel?tab=faq_manage&' + qs({ err: 'Нужны заголовок и текст.' });
      await faq.addEntry(cat, title, cont, user.id);
      await refreshCat(cat);
      await webAuditMeta(client, user, 'FAQ: добавлен гайд (сайт)', `${cat}: ${title}`);
      return '/panel?tab=faq_manage&' + qs({ ok: 'Гайд добавлен.' });
    }
    const eid = parseInt(body.get('id'), 10) || 0;
    const e = await db.get('SELECT * FROM faq_entries WHERE id = ?', [eid]).catch(() => null);
    if (!e) return '/panel?tab=faq_manage&' + qs({ err: 'Гайд не найден.' });
    if (pathName === '/panel/faq/edit') {
      const title = (body.get('title') || '').trim().slice(0, 120);
      const cont = (body.get('content') || '').trim().slice(0, 3000);
      if (!title || !cont) return '/panel?tab=faq_manage&' + qs({ err: 'Пустые поля.' });
      await faq.updateEntry(eid, title, cont, user.id);
      await refreshCat(e.category);
      return '/panel?tab=faq_manage&' + qs({ ok: 'Сохранено.' });
    }
    if (pathName === '/panel/faq/delete') {
      await faq.deleteEntry(eid);
      await refreshCat(e.category);
      await webAuditMeta(client, user, 'FAQ: удалён гайд (сайт)', `#${eid}`);
      return '/panel?tab=faq_manage&' + qs({ ok: 'Удалено.' });
    }
    if (pathName === '/panel/faq/move') {
      await faq.moveEntry(eid, body.get('dir') === 'up' ? 'up' : 'down');
      await refreshCat(e.category);
      return '/panel?tab=faq_manage&' + qs({ ok: 'Порядок изменён.' });
    }
    return '/panel?tab=faq_manage';
  }

  // ===== шаблоны причин отказа (Владелец) =====
  if (pathName.startsWith('/panel/reason/')) {
    if (acc.rank < LEVELS.owner) return '/panel?tab=reasons&' + qs({ err: 'Недостаточно прав.' });
    if (pathName === '/panel/reason/add') {
      const q = body.get('queue');
      if (!['application', 'kick', 'vacation'].includes(q)) return '/panel?tab=reasons&' + qs({ err: 'Неизвестная очередь.' });
      const text = (body.get('text') || '').trim().slice(0, 300);
      if (!text) return '/panel?tab=reasons&' + qs({ err: 'Пустой текст.' });
      const mx = await db.get('SELECT MAX(position) m FROM reject_reason_templates WHERE queue = ?', [q]);
      await db.run('INSERT INTO reject_reason_templates (queue, text, position, created_at) VALUES (?, ?, ?, ?)', [q, text, (mx && mx.m != null ? mx.m : 0) + 1, new Date().toISOString()]);
      return '/panel?tab=reasons&' + qs({ ok: 'Добавлено.' });
    }
    const rid = parseInt(body.get('id'), 10) || 0;
    const r = await db.get('SELECT * FROM reject_reason_templates WHERE id = ?', [rid]).catch(() => null);
    if (!r) return '/panel?tab=reasons&' + qs({ err: 'Не найдено.' });
    if (pathName === '/panel/reason/delete') {
      await db.run('DELETE FROM reject_reason_templates WHERE id = ?', [rid]);
      return '/panel?tab=reasons&' + qs({ ok: 'Удалено.' });
    }
    if (pathName === '/panel/reason/move') {
      const dir = body.get('dir') === 'up' ? -1 : 1;
      const neighbour = await db.get(
        `SELECT * FROM reject_reason_templates WHERE queue = ? AND position ${dir < 0 ? '<' : '>'} ? ORDER BY position ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`,
        [r.queue, r.position],
      );
      if (neighbour) {
        await db.run('UPDATE reject_reason_templates SET position = ? WHERE id = ?', [neighbour.position, r.id]);
        await db.run('UPDATE reject_reason_templates SET position = ? WHERE id = ?', [r.position, neighbour.id]);
      }
      return '/panel?tab=reasons&' + qs({ ok: 'Порядок изменён.' });
    }
    return '/panel?tab=reasons';
  }

  // ===== ручное добавление участника (Зам.+) =====
  if (pathName === '/panel/member/add') {
    if (acc.rank < LEVELS.deputy) return '/panel?tab=members&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=members&' + qs({ err: 'Бот недоступен.' });
    const did = (body.get('discord_id') || '').trim();
    const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
    const stat = (body.get('static') || '').trim();
    const lvl = parseInt(body.get('lvl'), 10) || 1;
    let roleId = (body.get('role_id') || '').trim();
    if (!(config.ROLE_IDS || []).includes(roleId)) roleId = config.ROLE_APPLY;
    if (!/^\d{5,25}$/.test(did) || !name || !/^[0-9]+$/.test(stat)) return '/panel?tab=members&' + qs({ err: 'Проверьте поля.' });
    if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [did])) return '/panel?tab=members&' + qs({ err: 'Уже в списке участников.' });
    if (await db.get('SELECT id FROM blacklist WHERE discord_id = ? OR static = ?', [did, stat])) return '/panel?tab=members&' + qs({ err: 'В чёрном списке.' });
    if (await passportsLib.isStaticTaken(stat)) return '/panel?tab=members&' + qs({ err: 'Такой № паспорта занят.' });
    const now = new Date().toISOString();
    let tag = did;
    try { const m = await g.members.fetch(did); tag = m.user.tag; } catch (_) {}
    await db.run(
      `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
       VALUES (?, ?, ?, ?, ?, '', '', ?, ?)`,
      [did, tag, name, stat, lvl, roleId, now],
    );
    try {
      const m = await g.members.fetch(did);
      await m.roles.add([roleId, config.ROLE_ORGANIZATION].filter(Boolean));
    } catch (_) {}
    await hook('syncEffectiveIdentity')(g, did);
    try { await history.logJoined(did, stat, name, 'Добавлен вручную через сайт'); } catch (_) {}
    try { await hook('createProfileThread')(g, did, name, stat); } catch (_) {}
    await hook('safeUpdateMembersList')(g);
    await webAudit(client, user, 'Участник добавлен вручную (сайт)', `<@${did}> ${name} № ${stat}`);
    return '/panel?tab=members&' + qs({ ok: 'Участник добавлен.' });
  }

  // ===== повторяющиеся розыгрыши (Владелец) =====
  if (pathName === '/panel/giveaway/recur_create' || pathName === '/panel/giveaway/recur_toggle' || pathName === '/panel/giveaway/recur_delete') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    if (pathName === '/panel/giveaway/recur_create') {
      const prize = (body.get('prize') || '').trim().slice(0, 200);
      const winners = parseInt(body.get('winners'), 10) || 0;
      const durMs = giveaways.parseDuration((body.get('duration') || '').trim());
      const weekday = parseInt(body.get('weekday'), 10);
      const channelId = (body.get('channel_id') || '').trim();
      const roleId = (body.get('role_id') || '').trim() || null;
      if (!prize || winners < 1 || !durMs || !(weekday >= 0 && weekday <= 6) || !/^[0-9]+$/.test(channelId)) {
        return '/panel?tab=giveaways&' + qs({ err: 'Проверьте поля правила.' });
      }
      await giveaways.createRecurringRule(channelId, prize, winners, durMs, weekday, user.id, roleId);
      await webAudit(client, user, 'Создано правило повторяющегося розыгрыша (сайт)', `«${prize}» по дням недели #${weekday}`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Правило создано.' });
    }
    const rid = parseInt(body.get('id'), 10) || 0;
    const rule = await giveaways.getRecurringRule(rid).catch(() => null);
    if (!rule) return '/panel?tab=giveaways&' + qs({ err: 'Правило не найдено.' });
    if (pathName === '/panel/giveaway/recur_delete') {
      await db.run('DELETE FROM giveaway_recurring_rules WHERE id = ?', [rid]);
      await webAudit(client, user, 'Удалено правило повторяющегося розыгрыша (сайт)', `#${rid}`);
      return '/panel?tab=giveaways&' + qs({ ok: 'Правило удалено.' });
    }
    const ns = rule.status === 'active' ? 'paused' : 'active';
    await giveaways.setRecurringRuleStatus(rid, ns);
    await webAudit(client, user, 'Правило повторяющегося розыгрыша: ' + (ns === 'active' ? 'возобновлено' : 'на паузе') + ' (сайт)', `#${rid}`);
    return '/panel?tab=giveaways&' + qs({ ok: ns === 'active' ? 'Возобновлено.' : 'Поставлено на паузу.' });
  }

  // ===== разослать правила / опубликовать текст в канал (Владелец) =====
  if (pathName === '/panel/rules_broadcast') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=texts&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=texts&' + qs({ err: 'Бот недоступен.' });
    const text = (await hook('getCurrentText')('rules', '')) || '';
    if (!text) return '/panel?tab=texts&' + qs({ err: 'Текст правил пуст.' });
    const emb = new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил организации').setDescription(String(text).slice(0, 4000));
    await postTo(client, config.CHANNEL_RULES, { embeds: [emb] });
    const ids = (await db.all('SELECT discord_id FROM participants')).map((r) => r.discord_id);
    (async () => {
      let ok = 0;
      for (const did of ids) { if (await dmTo(client, did, { embeds: [emb] })) ok++; await new Promise((r) => setTimeout(r, 1200)); }
      await webAudit(client, user, 'Правила разосланы (сайт)', `в канал + ЛС ${ok}/${ids.length}`).catch(() => {});
    })();
    return '/panel?tab=texts&' + qs({ ok: `Правила отправлены в канал; рассылка в ЛС (${ids.length}) идёт в фоне.` });
  }
  if (pathName === '/panel/text/publish') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=texts&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=texts&' + qs({ err: 'Бот недоступен.' });
    const key = body.get('key');
    const chMap = { agitation: config.CHANNEL_AGITATION, hr_info: config.CHANNEL_HR_APPLY_MENU };
    if (!chMap[key]) return '/panel?tab=texts&' + qs({ err: 'Нельзя опубликовать этот текст.' });
    const text = (await hook('getCurrentText')(key, '')) || '';
    if (!text) return '/panel?tab=texts&' + qs({ err: 'Текст пуст.' });
    const payload = key === 'agitation'
      ? { content: String(text).slice(0, 1900), embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('```\n' + String(text).slice(0, 3900) + '\n```')] }
      : { embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(String(text).slice(0, 4000))] };
    await postTo(client, chMap[key], payload);
    await webAudit(client, user, 'Текст опубликован в канал (сайт)', key);
    return '/panel?tab=texts&' + qs({ ok: 'Опубликовано.' });
  }

  // ===== бэкап сейчас (Владелец) =====
  if (pathName === '/tools/backup_now') {
    if (acc.rank < LEVELS.owner) return '/tools?' + qs({ err: 'Недостаточно прав.' });
    let dest = null;
    try { dest = backup.backupNow(); } catch (e) { return '/tools?' + qs({ err: 'Ошибка: ' + e.message }); }
    await webAuditMeta(client, user, 'Резервная копия БД (сайт)', dest || 'не удалось');
    return '/tools?' + qs(dest ? { ok: 'Копия сохранена: ' + dest } : { err: 'Не удалось создать копию.' });
  }

  // ===== заявки от участника: изменение данных / паспорт / апелляция =====
  if (pathName === '/me/data_change') {
    const p = await db.get('SELECT discord_tag FROM participants WHERE discord_id = ?', [user.id]);
    if (!p) return '/me?' + qs({ err: 'Только для участников.' });
    const stat = (body.get('static') || '').trim();
    const newName = (body.get('new_name') || '').trim().replace(/[_\s]+/g, ' ').trim();
    const pp = (await passportsLib.getAllPassports(user.id)).find((x) => x.static === stat);
    if (!pp) return '/me?' + qs({ err: 'Это не ваш паспорт.' });
    if (!newName || newName === pp.name) return '/me?' + qs({ err: 'Введите новое имя.' });
    if (await db.get("SELECT id FROM data_change_requests WHERE discord_id = ? AND status='pending'", [user.id])) return '/me?' + qs({ err: 'Заявка уже на рассмотрении.' });
    const created = new Date().toISOString();
    const r = await db.run(
      'INSERT INTO data_change_requests (discord_id, discord_tag, target_static, old_name, new_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user.id, p.discord_tag || uname, stat, pp.name, newName, 'pending', created],
    );
    const sent = await postTo(client, config.CHANNEL_DATA_CHANGE_REVIEW, {
      content: REVIEW_MENTION() + ' — заявка на изменение данных (сайт)',
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`Изменение данных #${r.lastID}`).addFields(
        { name: 'Заявитель', value: `<@${user.id}>` },
        { name: 'Паспорт', value: `№ ${stat}`, inline: true },
        { name: 'Было → Станет', value: `${pp.name} → ${newName}` },
      )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`data_change_accept:${r.lastID}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`data_change_reject:${r.lastID}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
      )],
      ...REVIEW_MENTION_OPTS,
    });
    if (sent) await db.run('UPDATE data_change_requests SET message_id = ? WHERE id = ?', [sent.id, r.lastID]);
    await webAudit(client, user, 'Заявка на изменение данных (сайт)', `#${r.lastID} № ${stat}: ${pp.name} → ${newName}`);
    return '/me?' + qs({ ok: 'Заявка отправлена.' });
  }
  if (pathName === '/me/passport_request') {
    const p = await db.get('SELECT discord_tag FROM participants WHERE discord_id = ?', [user.id]);
    if (!p) return '/me?' + qs({ err: 'Только для участников.' });
    const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
    const stat = (body.get('static') || '').trim();
    if (!name || !/^[0-9]+$/.test(stat)) return '/me?' + qs({ err: 'Проверьте имя и № паспорта.' });
    if (await passportsLib.isStaticTaken(stat)) return '/me?' + qs({ err: 'Такой № паспорта уже занят.' });
    if (await db.get("SELECT id FROM passport_requests WHERE discord_id = ? AND status='pending'", [user.id])) return '/me?' + qs({ err: 'Заявка уже на рассмотрении.' });
    const r = await db.run(
      'INSERT INTO passport_requests (discord_id, discord_tag, name, static, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, p.discord_tag || uname, name, stat, 'pending', new Date().toISOString()],
    );
    const sent = await postTo(client, config.CHANNEL_APPLY_REVIEW, {
      content: REVIEW_MENTION() + ' — заявка на добавление паспорта (сайт)',
      embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`Добавление паспорта #${r.lastID}`).addFields(
        { name: 'Заявитель', value: `<@${user.id}>` },
        { name: 'Имя Фамилия', value: name, inline: true },
        { name: '№ Паспорта', value: stat, inline: true },
      )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`passport_request_accept:${r.lastID}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`passport_request_reject:${r.lastID}`).setLabel('❌ Отказать').setStyle(ButtonStyle.Danger),
      )],
      ...REVIEW_MENTION_OPTS,
    });
    if (sent) await db.run('UPDATE passport_requests SET message_id = ? WHERE id = ?', [sent.id, r.lastID]);
    await webAudit(client, user, 'Заявка на добавление паспорта (сайт)', `#${r.lastID} ${name} № ${stat}`);
    return '/me?' + qs({ ok: 'Заявка отправлена.' });
  }
  if (pathName === '/me/appeal') {
    const bl = await db.all('SELECT * FROM blacklist WHERE discord_id = ?', [user.id]);
    if (!bl.length) return '/me?' + qs({ err: 'Вы не в чёрном списке.' });
    if (bl.some((b) => b.appeal_blocked)) return '/me?' + qs({ err: 'Вам запрещено подавать апелляцию.' });
    if (await db.get("SELECT id FROM appeals WHERE discord_id = ? AND status='pending'", [user.id])) return '/me?' + qs({ err: 'Апелляция уже на рассмотрении.' });
    const text = (body.get('text') || '').trim().slice(0, 1500) || '(без текста)';
    const r = await db.run(
      "INSERT INTO appeals (discord_id, discord_tag, text, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      [user.id, uname, text, new Date().toISOString()],
    );
    const sent = await postTo(client, config.CHANNEL_APPEAL_REVIEW, {
      content: config.ROLES_BLACKLIST_ALLOWED.map((x) => `<@&${x}>`).join(' ') + ' — апелляция ЧС (сайт)',
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`🚫 Апелляция на ЧС #${r.lastID}`).setDescription(text.slice(0, 4000)).addFields(
        { name: 'Автор', value: `<@${user.id}> | ${esc(uname)}` },
      )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`appeal_accept:${r.lastID}`).setLabel('✅ Снять из ЧС').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`appeal_reject:${r.lastID}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`appeal_block:${user.id}`).setLabel('🔒 Запретить апелляции').setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: { roles: config.ROLES_BLACKLIST_ALLOWED },
    });
    if (sent) await db.run('UPDATE appeals SET message_id = ? WHERE id = ?', [sent.id, r.lastID]);
    await webAudit(client, user, 'Апелляция ЧС подана (сайт)', `#${r.lastID}`);
    return '/me?' + qs({ ok: 'Апелляция подана.' });
  }

  // ===== админ-панель havirys: бренд / тема / Discord =====
  if (pathName.startsWith('/admin/')) {
    if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только для владельца-аккаунта (havirys).' });

    if (pathName === '/admin/site') {
      const lim = { brand: 60, invite: 200, hero_title: 120, hero_text: 600, footer: 300 };
      for (const k of Object.keys(lim)) {
        await db.setSetting('site.' + k, (body.get(k) || '').trim().slice(0, lim[k]));
      }
      await loadSite(true);
      await webAuditMeta(client, user, 'Изменены название/тексты сайта', `brand=${(body.get('brand') || '').slice(0, 60)}`);
      return '/panel?tab=admin&' + qs({ ok: 'Сохранено.' });
    }

    if (pathName === '/admin/theme') {
      const KEYS = ['bg', 'panel', 'panel2', 'line', 'text', 'muted', 'accent', 'accent2', 'ok', 'bad', 'warn'];
      let n = 0;
      for (const k of KEYS) {
        const raw = (body.get('t_' + k) || body.get('c_' + k) || '').trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(raw)) { await db.setSetting('site.color.' + k, raw); n++; }
      }
      await loadSite(true);
      await webAuditMeta(client, user, 'Изменена тема сайта', `${n} цвет(ов)`);
      return '/panel?tab=admin&' + qs({ ok: 'Тема применена.' });
    }

    if (pathName === '/admin/theme_reset') {
      await db.run("DELETE FROM settings WHERE key LIKE 'site.color.%'");
      await loadSite(true);
      await webAuditMeta(client, user, 'Сброшена тема сайта', '');
      return '/panel?tab=admin&' + qs({ ok: 'Цвета возвращены к стандартным.' });
    }

    if (pathName === '/admin/logo') {
      const data = (body.get('data') || '').trim();
      if (!/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(data)) return '/panel?tab=admin&' + qs({ err: 'Нужен файл-картинка.' });
      if (data.length > 700000) return '/panel?tab=admin&' + qs({ err: 'Картинка слишком большая.' });
      await db.setSetting('site.logo', data);
      await loadSite(true);
      await webAuditMeta(client, user, 'Загружен логотип сайта', `${data.length} симв.`);
      return '/panel?tab=admin&' + qs({ ok: 'Логотип обновлён.' });
    }
    if (pathName === '/admin/logo_clear') {
      await db.setSetting('site.logo', '');
      await loadSite(true);
      await webAuditMeta(client, user, 'Удалён логотип сайта', '');
      return '/panel?tab=admin&' + qs({ ok: 'Логотип убран.' });
    }
    if (pathName === '/admin/nav') {
      await db.setSetting('site.nav', (body.get('nav') || '').slice(0, 2000));
      await loadSite(true);
      await webAuditMeta(client, user, 'Изменено меню сайта', '');
      return '/panel?tab=admin&' + qs({ ok: 'Меню сохранено.' });
    }
    if (pathName === '/admin/css') {
      await db.setSetting('site.css', (body.get('css') || '').slice(0, 20000));
      await loadSite(true);
      await webAuditMeta(client, user, 'Изменён свой CSS сайта', `${(body.get('css') || '').length} симв.`);
      return '/panel?tab=admin&' + qs({ ok: 'CSS сохранён.' });
    }
    if (pathName === '/admin/grants/save') {
      const st = body.get('subject_type') === 'role' ? 'role' : 'user';
      const sid = (body.get('subject_id') || (st === 'role' ? body.get('subject_role') : body.get('subject_user')) || body.get('discord_id') || '').trim();
      if (!/^[0-9]{5,25}$/.test(sid)) return '/panel?tab=grants&' + qs({ err: st === 'role' ? 'Выберите роль.' : 'Неверный Discord ID.' });
      const tabs = body.getAll('tab').filter((t) => GRANTABLE_TABS.has(t));
      const expRaw = (body.get('expires_at') || '').trim();
      const expIso = /^\d{4}-\d{2}-\d{2}$/.test(expRaw) ? new Date(expRaw + 'T23:59:59').toISOString() : null;
      await db.run("DELETE FROM panel_grants WHERE discord_id = ? AND COALESCE(subject_type,'user') = ?", [sid, st]);
      for (const t of tabs) {
        await db.run('INSERT INTO panel_grants (discord_id, subject_type, tab, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [sid, st, t, user.id, new Date().toISOString(), expIso]);
      }
      // грант по участнику — сбрасываем только его; по роли — весь кэш
      // (участников с ролью дёшево не перечислить).
      if (st === 'role') _grantsCache.clear();
      else _grantsCache.delete(sid);
      await webAuditMeta(client, user, 'Доступы к панели (сайт)', `${st === 'role' ? 'роль' : ''} ${sid} → ${tabs.join(', ') || 'убраны все'}${expIso ? ' (до ' + expRaw + ')' : ''}`);
      return `/panel?tab=grants&edit=${st}:${sid}&` + qs({ ok: tabs.length ? `Выдано разделов: ${tabs.length}.` : 'Доступы убраны.' });
    }
    if (pathName === '/admin/page/save' || pathName === '/admin/page/revert') {
      const snapshotPage = async (sl) => {
        const cur = await db.get('SELECT * FROM site_pages WHERE slug = ?', [sl]).catch(() => null);
        if (cur) {
          await db.run('INSERT INTO site_page_versions (slug, title, content, nav, saved_at, saved_by) VALUES (?, ?, ?, ?, ?, ?)',
            [sl, cur.title || '', cur.content || '', cur.nav || 0, new Date().toISOString(), user.id]).catch(() => {});
          // храним не больше 20 версий на страницу
          await db.run("DELETE FROM site_page_versions WHERE slug = ? AND id NOT IN (SELECT id FROM site_page_versions WHERE slug = ? ORDER BY id DESC LIMIT 20)", [sl, sl]).catch(() => {});
        }
      };
      if (pathName === '/admin/page/revert') {
        const vid = parseInt(body.get('vid'), 10) || 0;
        const ver = await db.get('SELECT * FROM site_page_versions WHERE id = ?', [vid]);
        if (!ver) return '/panel?tab=pages&' + qs({ err: 'Версия не найдена.' });
        await snapshotPage(ver.slug);
        await db.run(
          `INSERT INTO site_pages (slug, title, content, nav, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET title = excluded.title, content = excluded.content, nav = excluded.nav, updated_at = excluded.updated_at`,
          [ver.slug, ver.title || '', ver.content || '', ver.nav || 0, new Date().toISOString()],
        );
        await loadSite(true);
        await webAuditMeta(client, user, 'Откат доп. страницы к версии (сайт)', `/p/${ver.slug} → v#${vid}`);
        return '/panel?tab=pages&' + qs({ ok: 'Страница откачена к выбранной версии.' });
      }
      const slug = (body.get('slug') || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{1,40}$/.test(slug)) return '/panel?tab=pages&' + qs({ err: 'Slug: только a-z, 0-9 и дефис.' });
      const orig = (body.get('orig') || '').trim().toLowerCase();
      const title = (body.get('title') || '').slice(0, 120);
      const contentTxt = (body.get('content') || '').slice(0, 20000);
      const nav = body.get('nav') === '1' ? 1 : 0;
      let published = body.get('published') === '1' ? 1 : 0;
      const paRaw = (body.get('publish_at') || '').trim();
      let publishAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(paRaw) ? new Date(paRaw).toISOString() : null;
      // Время в будущем → держим черновиком до авто-публикации.
      if (publishAt && Date.parse(publishAt) > Date.now()) published = 0;
      else publishAt = null;
      const now = new Date().toISOString();
      await snapshotPage(orig && orig !== slug ? orig : slug);
      if (orig && orig !== slug) await db.run('DELETE FROM site_pages WHERE slug = ?', [orig]);
      await db.run(
        `INSERT INTO site_pages (slug, title, content, nav, published, publish_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET title = excluded.title, content = excluded.content, nav = excluded.nav, published = excluded.published, publish_at = excluded.publish_at, updated_at = excluded.updated_at`,
        [slug, title, contentTxt, nav, published, publishAt, now],
      );
      await loadSite(true);
      await webAuditMeta(client, user, 'Сохранена доп. страница (сайт)', `/p/${slug}`);
      return '/panel?tab=pages&' + qs({ ok: 'Страница сохранена.' });
    }
    if (pathName === '/admin/page/del') {
      const slug = (body.get('orig') || body.get('slug') || '').trim().toLowerCase();
      await db.run('DELETE FROM site_pages WHERE slug = ?', [slug]);
      await loadSite(true);
      await webAuditMeta(client, user, 'Удалена доп. страница (сайт)', `/p/${slug}`);
      return '/panel?tab=pages&' + qs({ ok: 'Страница удалена.' });
    }
    if (pathName === '/admin/asset/upload') {
      const data = (body.get('data') || '').trim();
      const m = /^data:(image\/(png|jpeg|jpg|webp|gif|svg\+xml));base64,(.+)$/i.exec(data);
      if (!m) return '/panel?tab=pages&' + qs({ err: 'Нужен файл-картинка.' });
      let buf;
      try { buf = Buffer.from(m[3], 'base64'); } catch (_) { return '/panel?tab=pages&' + qs({ err: 'Не удалось прочитать файл.' }); }
      if (buf.length > 512 * 1024) return '/panel?tab=pages&' + qs({ err: 'Файл больше 500 КБ.' });
      const svg = /svg/i.test(m[1]);
      const fname = svg ? null : await saveUploadFile('a', m[1], buf);
      await db.run('INSERT INTO page_assets (filename, mime, data, file, size, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [(body.get('filename') || 'image').slice(0, 120), m[1], svg ? buf : null, fname, buf.length, user.id, new Date().toISOString()]);
      await webAuditMeta(client, user, 'Загружена картинка страницы (сайт)', `${buf.length} байт`);
      return '/panel?tab=pages&' + qs({ ok: 'Картинка загружена.' });
    }
    if (pathName === '/admin/asset/del') {
      const aid = parseInt(body.get('id'), 10) || 0;
      const a0 = await db.get('SELECT file FROM page_assets WHERE id = ?', [aid]).catch(() => null);
      if (a0 && a0.file) await deleteUploadFile(a0.file);
      await db.run('DELETE FROM page_assets WHERE id = ?', [aid]);
      await webAuditMeta(client, user, 'Удалена картинка страницы (сайт)', `#${body.get('id')}`);
      return '/panel?tab=pages&' + qs({ ok: 'Удалено.' });
    }
    if (pathName === '/admin/page_tpl_save') {
      const name = (body.get('name') || '').trim().slice(0, 60);
      const content = (body.get('content') || '').slice(0, 20000);
      if (name) await db.run('INSERT INTO page_templates (name, content, created_at) VALUES (?, ?, ?)', [name, content, new Date().toISOString()]);
      return '/panel?tab=pages&' + qs({ ok: 'Шаблон сохранён.' });
    }
    if (pathName === '/admin/page_tpl_del') {
      await db.run('DELETE FROM page_templates WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
      return '/panel?tab=pages&' + qs({ ok: 'Шаблон удалён.' });
    }

    if (pathName === '/admin/bot_nick') {
      if (!g) return '/panel?tab=admin&' + qs({ err: 'Бот недоступен.' });
      const nick = (body.get('nick') || '').trim().slice(0, 32);
      try {
        await g.members.me.setNickname(nick || null);
      } catch (e) { return '/panel?tab=admin&' + qs({ err: 'Не удалось: ' + e.message }); }
      await webAuditMeta(client, user, 'Изменён ник бота на сервере', nick || '(сброшен)');
      return '/panel?tab=admin&' + qs({ ok: 'Ник бота обновлён.' });
    }

    if (pathName.startsWith('/admin/landing/')) {
      const KINDS = ['text', 'buttons', 'cards', 'stats'];
      if (pathName === '/admin/landing/settings') {
        for (const k of ['hide_stats', 'hide_giveaways', 'hide_agitation', 'banner_on', 'discord_widget']) {
          await db.setSetting('site.' + k, body.get(k) === '1' ? '1' : '');
        }
        await db.setSetting('site.banner_text', (body.get('banner_text') || '').slice(0, 400));
        await db.setSetting('site.banner_from', (body.get('banner_from') || '').slice(0, 40));
        await db.setSetting('site.banner_to', (body.get('banner_to') || '').slice(0, 40));
        await db.setSetting('site.agitation_title', (body.get('agitation_title') || '').slice(0, 80));
        await db.setSetting('site.stats_title', (body.get('stats_title') || '').slice(0, 80));
        await db.setSetting('site.stats', (body.get('stats') || '').slice(0, 1200));
        await db.setSetting('site.features_title', (body.get('features_title') || '').slice(0, 80));
        await db.setSetting('site.features', (body.get('features') || '').slice(0, 1500));
        await db.setSetting('site.howto_title', (body.get('howto_title') || '').slice(0, 80));
        await db.setSetting('site.howto', (body.get('howto') || '').slice(0, 1200));
        await db.setSetting('site.hero_minh', String(parseInt(body.get('hero_minh'), 10) || 0));
        await db.setSetting('site.hero_buttons', (body.get('hero_buttons') || '').slice(0, 600));
        await loadSite(true);
        await webAuditMeta(client, user, 'Настройки главной страницы (сайт)', '');
        return '/panel?tab=landing&' + qs({ ok: 'Сохранено.' });
      }
      if (pathName === '/admin/landing/add') {
        const mx = await db.get('SELECT MAX(position) m FROM landing_blocks');
        await db.run('INSERT INTO landing_blocks (position, kind, title, content, min_height, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [(mx && mx.m != null ? mx.m : 0) + 1, KINDS.includes(body.get('kind')) ? body.get('kind') : 'text', (body.get('title') || '').slice(0, 120), (body.get('content') || '').slice(0, 4000), parseInt(body.get('min_height'), 10) || 0, new Date().toISOString()]);
        return '/panel?tab=landing&' + qs({ ok: 'Блок добавлен.' });
      }
      const bid = parseInt(body.get('id'), 10) || 0;
      const blk = await db.get('SELECT * FROM landing_blocks WHERE id = ?', [bid]);
      if (!blk) return '/panel?tab=landing&' + qs({ err: 'Блок не найден.' });
      if (pathName === '/admin/landing/save') {
        await db.run('UPDATE landing_blocks SET kind = ?, title = ?, content = ?, min_height = ?, updated_at = ? WHERE id = ?',
          [KINDS.includes(body.get('kind')) ? body.get('kind') : blk.kind, (body.get('title') || '').slice(0, 120), (body.get('content') || '').slice(0, 4000), parseInt(body.get('min_height'), 10) || 0, new Date().toISOString(), bid]);
        return '/panel?tab=landing&' + qs({ ok: 'Сохранено.' });
      }
      if (pathName === '/admin/landing/del') {
        await db.run('DELETE FROM landing_blocks WHERE id = ?', [bid]);
        return '/panel?tab=landing&' + qs({ ok: 'Удалено.' });
      }
      if (pathName === '/admin/landing/move') {
        const dir = body.get('dir') === 'up' ? '<' : '>';
        const ord = body.get('dir') === 'up' ? 'DESC' : 'ASC';
        const nb = await db.get(`SELECT * FROM landing_blocks WHERE position ${dir} ? ORDER BY position ${ord} LIMIT 1`, [blk.position]);
        if (nb) {
          await db.run('UPDATE landing_blocks SET position = ? WHERE id = ?', [nb.position, blk.id]);
          await db.run('UPDATE landing_blocks SET position = ? WHERE id = ?', [blk.position, nb.id]);
        }
        return '/panel?tab=landing&' + qs({ ok: 'Порядок изменён.' });
      }
      return '/panel?tab=landing';
    }

    if (pathName === '/admin/menus') {
      if (!g) return '/panel?tab=admin&' + qs({ err: 'Бот недоступен.' });
      hook('initMenus')(g).catch((e) => console.error('[web] initMenus:', e.message));
      await webAuditMeta(client, user, 'Переинициализация меню Discord (сайт)', '');
      return '/panel?tab=admin&' + qs({ ok: 'Меню публикуются (в фоне).' });
    }

    if (pathName === '/admin/profiles_restore') {
      if (!g) return '/panel?tab=admin&' + qs({ err: 'Бот недоступен.' });
      (async () => {
        try {
          const n = await hook('restoreProfiles')(g);
          await webAuditMeta(client, user, 'Восстановление каналов-профилей (сайт)', `создано ${n}`).catch(() => {});
        } catch (e) { console.error('[web] restoreProfiles:', e.message); }
      })();
      return '/panel?tab=admin&' + qs({ ok: 'Восстановление запущено (в фоне).' });
    }

    if (pathName === '/admin/role') {
      if (!g) return '/panel?tab=admin&' + qs({ err: 'Бот недоступен.' });
      const rid = (body.get('id') || '').trim();
      const name = (body.get('name') || '').trim().slice(0, 90);
      const color = (body.get('color') || '').trim().toLowerCase();
      try {
        const role = await g.roles.fetch(rid);
        if (!role) return '/panel?tab=admin&' + qs({ err: 'Роль не найдена.' });
        const patch = {};
        if (name && name !== role.name) patch.name = name;
        if (/^#[0-9a-f]{6}$/.test(color)) patch.color = parseInt(color.slice(1), 16);
        if (Object.keys(patch).length) await role.edit(patch);
      } catch (e) { return '/panel?tab=admin&' + qs({ err: 'Не удалось изменить роль: ' + e.message }); }
      await webAuditMeta(client, user, 'Изменена роль Discord (сайт)', `${rid} → «${name}» ${color}`);
      return '/panel?tab=admin&' + qs({ ok: 'Роль обновлена.' });
    }

    if (pathName === '/admin/theme_preset') {
      if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только владелец-аккаунт.' });
      const pr = THEME_PRESETS[body.get('preset')] || null;
      if (!pr) return '/panel?tab=admin&' + qs({ err: 'Неизвестный пресет.' });
      await db.run("DELETE FROM settings WHERE key LIKE 'site.color.%'");
      for (const [k, v] of Object.entries(pr)) await db.setSetting('site.color.' + k, v);
      await loadSite(true);
      await webAuditMeta(client, user, 'Применён пресет темы', body.get('preset'));
      return '/panel?tab=admin&' + qs({ ok: 'Пресет применён.' });
    }
    if (pathName === '/admin/config_import') {
      if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только владелец-аккаунт.' });
      let obj;
      try { obj = JSON.parse(body.get('json') || '{}'); } catch (e) { return '/panel?tab=admin&' + qs({ err: 'Неверный JSON.' }); }
      let n = 0;
      if (obj.site && typeof obj.site === 'object') {
        for (const [k, v] of Object.entries(obj.site)) {
          if (!k.startsWith('site.')) continue;
          if (k.startsWith('site.color.') && !/^#[0-9a-fA-F]{6}$/.test(String(v))) continue;
          await db.setSetting(k, String(v).slice(0, 600)); n++;
        }
      }
      if (obj.channels && typeof obj.channels === 'object') {
        for (const [k, v] of Object.entries(obj.channels)) {
          if (!k.startsWith('CHANNEL_') || !/^[0-9]{5,25}$/.test(String(v))) continue;
          try { await configStore.setOverride(k, String(v), user.id); n++; } catch (_) {}
        }
      }
      await loadSite(true);
      await webAuditMeta(client, user, 'Импорт конфигурации сайта (сайт)', `${n} ключ(ей)`);
      return '/panel?tab=admin&' + qs({ ok: `Применено: ${n}.` });
    }
    if (pathName === '/admin/channels') {
      if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только владелец-аккаунт.' });
      let n = 0;
      for (const [key, val] of body.entries()) {
        if (!key.startsWith('ch_')) continue;
        const cfgKey = key.slice(3);
        if (!cfgKey.startsWith('CHANNEL_')) continue;
        const v = (val || '').trim();
        if (!/^[0-9]{5,25}$/.test(v)) continue;
        if (String(config[cfgKey]) === v) continue;
        try { await configStore.setOverride(cfgKey, v, user.id); n++; } catch (_) {}
      }
      await webAuditMeta(client, user, 'Изменены ID каналов (сайт)', `${n} шт.`);
      return '/panel?tab=admin&' + qs({ ok: `Обновлено каналов: ${n}.` });
    }

    return '/panel?tab=admin';
  }

  // ===== аварийная замена БД (havirys) =====
  if (pathName === '/panel/db/restore') {
    if (user.id !== OWNER_ID) return '/tools?' + qs({ err: 'Только для владельца-аккаунта.' });
    const b64 = (body.get('b64') || '').trim();
    if (b64.length < 100) return '/tools?' + qs({ err: 'Похоже, файл не вставлен.' });
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3') return '/tools?' + qs({ err: 'Это не файл SQLite.' });
      const fs = require('fs');
      fs.writeFileSync(db.dbPath + '.incoming', buf);
      fs.renameSync(db.dbPath + '.incoming', db.dbPath);
      await webAuditMeta(client, user, 'АВАРИЙНАЯ замена БД (сайт)', `${buf.length} байт записано в ${db.dbPath}. Требуется перезапуск бота.`);
      return '/tools?' + qs({ ok: 'Файл записан. Перезапустите бота, чтобы он перечитал базу.' });
    } catch (e) {
      return '/tools?' + qs({ err: 'Ошибка записи: ' + e.message });
    }
  }

  // ===== уведомления: прочитать всё / одно / отложить / настройки =====
  if (pathName === '/notifications/read_all') {
    await db.run('UPDATE notifications SET read_at = ? WHERE discord_id = ? AND read_at IS NULL', [new Date().toISOString(), user.id]);
    invalidateUnread(user.id);
    return '/notifications?' + qs({ ok: 'Отмечено.' });
  }
  if (pathName === '/notifications/read_one') {
    await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND discord_id = ?', [new Date().toISOString(), parseInt(body.get('id'), 10) || 0, user.id]);
    invalidateUnread(user.id);
    return '/notifications?' + qs({ ok: 'Отмечено.' });
  }
  if (pathName === '/notifications/snooze') {
    invalidateUnread(user.id);
    await db.run('UPDATE notifications SET snooze_until = ? WHERE id = ? AND discord_id = ?', [new Date(Date.now() + 3 * 864e5).toISOString(), parseInt(body.get('id'), 10) || 0, user.id]);
    return '/notifications?' + qs({ ok: 'Отложено на 3 дня.' });
  }
  if (pathName === '/notifications/prefs') {
    const on = new Set(body.getAll('on'));
    const muted = NOTIF_KINDS.map(([k]) => k).filter((k) => !on.has(k));
    await db.run('INSERT INTO notif_prefs (discord_id, muted) VALUES (?, ?) ON CONFLICT(discord_id) DO UPDATE SET muted = excluded.muted', [user.id, muted.join(',')]);
    return '/notifications?' + qs({ ok: 'Настройки сохранены.' });
  }

  // ===== сверка ролей: починить (Зам.+) =====
  if (pathName === '/panel/rolecheck/fix' || pathName === '/panel/rolecheck/fixall') {
    if (acc.rank < LEVELS.deputy) return '/panel?tab=role_check&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=role_check&' + qs({ err: 'Бот недоступен.' });
    let ids = [];
    if (pathName === '/panel/rolecheck/fix') {
      const id = (body.get('id') || '').trim();
      if (/^\d{5,25}$/.test(id)) ids = [id];
    } else {
      ids = (await db.all('SELECT discord_id FROM participants')).map((r) => r.discord_id);
    }
    let n = 0;
    for (const did of ids) { await hook('syncEffectiveIdentity')(g, did); n++; }
    await hook('safeUpdateMembersList')(g);
    await webAudit(client, user, 'Сверка ролей — пересинхронизация (сайт)', `${n} участник(ов)`);
    return '/panel?tab=role_check&' + qs({ ok: `Пересинхронизировано: ${n}.` });
  }

  // ===== импорт участников из CSV (Владелец) =====
  if (pathName === '/panel/member/import') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=members&' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/panel?tab=members&' + qs({ err: 'Бот недоступен.' });
    const text = body.get('csv') || '';
    let recs = [];
    try { recs = csvLib.parseCsvObjects(text); } catch (e) { return '/panel?tab=members&' + qs({ err: 'Не разобрать CSV: ' + e.message }); }
    if (!recs.length) return '/panel?tab=members&' + qs({ err: 'Пустой CSV.' });
    let ok = 0; const skipped = [];
    for (const r of recs) {
      const did = String(r.discord_id || r.id || '').trim();
      const name = String(r.name || '').trim().replace(/[_\s]+/g, ' ').trim();
      const stat = String(r.static || r.passport || '').trim();
      if (!/^\d{5,25}$/.test(did) || !name || !/^[0-9]+$/.test(stat)) { skipped.push(did || '?'); continue; }
      if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [did])) { skipped.push(did + ' (есть)'); continue; }
      if (await passportsLib.isStaticTaken(stat)) { skipped.push(did + ' (паспорт занят)'); continue; }
      const roleId = (config.ROLE_IDS || []).includes(r.role_id) ? r.role_id : config.ROLE_APPLY;
      let tag = did;
      try { const m = await g.members.fetch(did); tag = m.user.tag; } catch (_) {}
      await db.run(
        `INSERT INTO participants (discord_id, discord_tag, name, static, lvl, skills, online, role_id, joined_at)
         VALUES (?, ?, ?, ?, ?, '', '', ?, ?)`,
        [did, tag, name, stat, parseInt(r.lvl, 10) || 1, roleId, new Date().toISOString()],
      );
      try { const m = await g.members.fetch(did); await m.roles.add([roleId, config.ROLE_ORGANIZATION].filter(Boolean)); } catch (_) {}
      await hook('syncEffectiveIdentity')(g, did);
      try { await history.logJoined(did, stat, name, 'Импорт CSV через сайт'); } catch (_) {}
      ok++;
    }
    await hook('safeUpdateMembersList')(g);
    await webAudit(client, user, 'Импорт участников CSV (сайт)', `добавлено ${ok}, пропущено ${skipped.length}`);
    return '/panel?tab=members&' + qs({ ok: `Добавлено ${ok}. Пропущено ${skipped.length}${skipped.length ? ': ' + skipped.slice(0, 10).join(', ') : ''}` });
  }

  // ===== синхронизация видимости команд в Discord (havirys) =====
  if (pathName === '/panel/perm/sync') {
    if (user.id !== OWNER_ID) return '/panel?tab=perms&' + qs({ err: 'Только владелец-аккаунт.' });
    if (!g) return '/panel?tab=perms&' + qs({ err: 'Бот недоступен.' });
    hook('syncAllCommandPermissions')(g).catch((e) => console.error('[web] perm sync:', e.message));
    await webAuditMeta(client, user, 'Синхронизация видимости команд (сайт)', '');
    return '/panel?tab=perms&' + qs({ ok: 'Синхронизация запущена (в фоне).' });
  }

  // ===== отмена последнего действия (Зам.+, окно 5 мин) =====
  if (pathName === '/undo') {
    if (acc.rank < LEVELS.deputy) return '/audit?' + qs({ err: 'Недостаточно прав.' });
    if (!g) return '/audit?' + qs({ err: 'Бот недоступен.' });
    const uid = parseInt(body.get('id'), 10) || 0;
    const rec = await db.get('SELECT * FROM undo_actions WHERE id = ?', [uid]);
    if (!rec || rec.done_at) return '/audit?' + qs({ err: 'Уже отменено или не найдено.' });
    if (new Date(rec.expires_at) < new Date()) return '/audit?' + qs({ err: 'Окно отмены (5 мин) истекло.' });
    let payload = {};
    try { payload = JSON.parse(rec.payload || '{}'); } catch (_) {}
    if (rec.kind === 'rank' && payload.static && payload.prevRoleId) {
      await passportsLib.updatePassportFields(rec.target_id, payload.static, { role_id: payload.prevRoleId });
      await hook('syncEffectiveIdentity')(g, rec.target_id);
      await hook('safeUpdateMembersList')(g);
    } else if (rec.kind === 'dbrow' && payload.table && payload.row && DATA_TABLES[payload.table]) {
      if (user.id !== OWNER_ID) return '/audit?' + qs({ err: 'Откат правки БД — только havirys.' });
      try {
        const cols = Object.keys(payload.row);
        const exists = await db.get(`SELECT 1 x FROM ${payload.table} WHERE rowid = ?`, [payload.pk]);
        if (exists) {
          await db.run(`UPDATE ${payload.table} SET ${cols.map((cn) => `${cn} = ?`).join(', ')} WHERE rowid = ?`, [...cols.map((cn) => payload.row[cn]), payload.pk]);
        } else {
          await db.run(`INSERT INTO ${payload.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((cn) => payload.row[cn]));
        }
      } catch (e) { return '/audit?' + qs({ err: 'Не удалось откатить: ' + e.message }); }
    }
    await db.run('UPDATE undo_actions SET done_at = ? WHERE id = ?', [new Date().toISOString(), uid]);
    await webAudit(client, user, 'Отмена действия (сайт)', `${rec.kind} #${uid} для <@${rec.target_id}>`);
    return '/audit?' + qs({ ok: 'Действие отменено.' });
  }

  return '/';
}

// ---------- Сервер ----------
function start(client, hooks = {}) {
  HOOKS = hooks || {};
  _mdClient = client;
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const _reqStart = Date.now();
    const done = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };
    const html = (code, body, extra = {}) => done(code, { 'Content-Type': 'text/html; charset=utf-8', ...extra }, body);
    const redirect = (loc, extra = {}) => done(302, { Location: loc, ...extra }, '');

    try {
      const u = new URL(req.url, baseUrl());
      const path = u.pathname;
      let user = readSession(req.headers.cookie);
      if (user && !(await sessionFresh(user))) user = null; // «выйти со всех устройств»
      // Локальный аккаунт (логин/пароль, без Discord). Если havirys привязал его
      // к участнику — дальше работаем от имени этого участника (user.id подменяем).
      if (user && String(user.id).startsWith('local:')) {
        user.local = true;
        user.localId = user.id;
        try {
          const lu = await db.get('SELECT username, linked_discord_id, oauth_discord_id FROM web_users WHERE discord_id = ?', [user.id]);
          if (lu) {
            if (lu.username) user.username = lu.username;
            user.oauthDiscordId = lu.oauth_discord_id || null;
            if (lu.linked_discord_id) user.id = lu.linked_discord_id;
          }
        } catch (_) {}
      }
      const pageNum = Math.max(0, parseInt(u.searchParams.get('page') || '0', 10) || 0);
      const flash = flashBanner(u);
      const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      const notif = user ? await unreadCount(user.id).catch(() => 0) : 0;
      const panelGrant = user ? (await getPanelGrants(client, user.id)).size > 0 : false;
      const L = (o) => layout({ notif, panelGrant, ...o }); // layout с колокольчиком

      if (path === '/healthz') return done(200, { 'Content-Type': 'text/plain' }, 'ok');

      // Заморозка: участник с frozen=1 не может пользоваться сайтом (кроме выхода).
      // Статус кэшируется на 30 сек, чтобы не бить в БД на каждый запрос.
      if (user && user.id !== OWNER_ID && path !== '/logout' && path !== '/manifest.webmanifest' && path !== '/sw.js'
          && !path.startsWith('/asset/') && !path.startsWith('/cimg/') && path !== '/healthz') {
        let fc = _frozenCache.get(user.id);
        if (!fc || Date.now() - fc.at > 30000) {
          const fr = await db.get('SELECT frozen, frozen_reason FROM participants WHERE discord_id = ?', [user.id]).catch(() => null);
          fc = { at: Date.now(), frozen: !!(fr && fr.frozen), reason: fr ? fr.frozen_reason : null };
          _frozenCache.set(user.id, fc);
        }
        if (fc.frozen) {
          return html(403, layout({ title: 'Доступ ограничен', user, level: 'guest', body:
            `<h1>Доступ к сайту приостановлен</h1>
             <div class="card">Ваш доступ временно ограничен руководством.${fc.reason ? `<br><br>Причина: ${esc(fc.reason)}` : ''}<br><br>По вопросам обратитесь к HR в Discord.</div>
             <a class="btn" href="/logout">Выйти</a>` }));
        }
      }

      await loadSite(); // настройки бренда/темы (кэш 30 сек)

      if (path === '/manifest.webmanifest') {
        const bg = (SITE.color && SITE.color.bg) || '#0f1013';
        const ac = (SITE.color && SITE.color.accent) || '#5b6cff';
        const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192"><rect width="192" height="192" fill="${bg}"/><circle cx="96" cy="96" r="56" fill="${ac}"/></svg>`)}`;
        return done(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' }, JSON.stringify({
          name: siteBrand(), short_name: siteBrand().split(' ')[0], start_url: '/me', display: 'standalone',
          background_color: bg, theme_color: bg,
          icons: [{ src: icon, sizes: '192x192', type: 'image/svg+xml' }, { src: icon, sizes: '512x512', type: 'image/svg+xml' }],
        }));
      }

      // Минимальный service worker — нужен, чтобы браузер предложил «Установить приложение».
      if (path === '/sw.js') {
        return done(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
          "self.addEventListener('install',function(){self.skipWaiting()});self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});self.addEventListener('fetch',function(){});");
      }

      // ----- POST: все действия записи -----
      if (path === '/md/preview' && req.method === 'POST') {
        if (!user) return done(401, { 'Content-Type': 'text/plain' }, '');
        const b = await readBody(req);
        return done(200, { 'Content-Type': 'text/html; charset=utf-8' }, mdToHtml((b.get('text') || '').slice(0, 20000)));
      }

      // Сохранение доски из редактора (AJAX, отвечает JSON, не редиректом).
      if (/^\/board\/\d+\/save$/.test(path) && req.method === 'POST') {
        const jr = (obj) => done(200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
        if (!user) return done(403, { 'Content-Type': 'application/json; charset=utf-8' }, '{"ok":false,"err":"forbidden"}');
        const bid = parseInt(path.split('/')[2], 10) || 0;
        const b = await readBody(req);
        if (!csrfOk(user, b.get('_csrf'))) return jr({ ok: false, err: 'csrf' });
        const board = await db.get('SELECT id, version, data FROM boards WHERE id = ?', [bid]).catch(() => null);
        if (!board) return jr({ ok: false, err: 'notfound' });
        if ((await boardAccess(client, user, board)) !== 'edit') return jr({ ok: false, err: 'forbidden' });
        const raw = b.get('data') || '';
        if (!raw || raw.length > 3_000_000) return jr({ ok: false, err: 'too_big' });
        // Явно проверяем, что тело — валидный JSON (обрезанное при передаче
        // тело не должно молча сохраниться как пустая доска).
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return jr({ ok: false, err: 'bad_json' }); }
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) return jr({ ok: false, err: 'bad_shape' });
        const clean = JSON.stringify(boardParse(raw));
        const now = new Date().toISOString();
        // PNG-снимок доски (из клиентского рендера) — кладём в data/uploads/board-<id>.png
        let imgFile = null;
        const png = b.get('png') || '';
        if (png.startsWith('data:image/png;base64,')) {
          try {
            const buf = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
            if (buf.length > 50 && buf.length < 4_000_000) {
              imgFile = 'board-' + bid + '.png';
              await _fsMod.promises.writeFile(_pathMod.join(uploadsDir(), imgFile), buf);
            }
          } catch (_) { imgFile = null; }
        }
        // Содержимое не менялось (сохранение ради PNG) — версию не плодим,
        // чтобы стандартная доска не «залипала» для авто-обновления по seed.
        if (clean === board.data) {
          if (imgFile) await db.run('UPDATE boards SET image_file = ?, updated_at = ? WHERE id = ?', [imgFile, now, bid]).catch(() => {});
          return jr({ ok: true, version: board.version || 1, at: now, nochange: true });
        }
        const nv = (board.version || 1) + 1;
        await db.run('UPDATE boards SET data = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?', [clean, nv, user.id, now, bid]);
        if (imgFile) await db.run('UPDATE boards SET image_file = ? WHERE id = ?', [imgFile, bid]).catch(() => {});
        await db.run('INSERT INTO board_versions (board_id, version, data, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)', [bid, nv, clean, user.id, now]).catch(() => {});
        await db.run('DELETE FROM board_versions WHERE board_id = ? AND id NOT IN (SELECT id FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT 50)', [bid, bid]).catch(() => {});
        return jr({ ok: true, version: nv, at: now });
      }

      // Выход через POST (CSRF-безопасно). GET /logout ниже оставлен для
      // аварийных ссылок (страница заморозки, экран ошибки).
      if (path === '/logout' && req.method === 'POST') {
        const b = await readBody(req);
        if (user && !csrfOk(user, b.get('_csrf'))) return redirect('/me?' + qs({ err: 'Сессия формы устарела.' }));
        return redirect('/', { 'Set-Cookie': 'fc_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      }

      // ----- Локальные аккаунты: анонимные POST (регистрация / вход / сброс) -----
      if ((path === '/register' || path === '/login/local' || path === '/forgot') && req.method === 'POST') {
        const backP = path === '/register' ? '/register?' : path === '/forgot' ? '/forgot?' : '/login/local?';
        if (!rateOk('auth:' + clientIp, 12, 60000)) return redirect(backP + qs({ err: 'Слишком много попыток — подождите минуту.' }));
        const b = await readBody(req);
        if (!anonCsrfOk(null, b.get('_csrf'))) return redirect(backP + qs({ err: 'Форма устарела — обновите страницу.' }));

        if (path === '/register') {
          const login = (b.get('login') || '').trim();
          const email = (b.get('email') || '').trim().toLowerCase();
          const pw = b.get('password') || '';
          const pw2 = b.get('password2') || '';
          if (!LOGIN_RE.test(login)) return redirect('/register?' + qs({ err: 'Логин: 3–32 символа, латиница/цифры/._-' }));
          if (!EMAIL_RE.test(email)) return redirect('/register?' + qs({ err: 'Укажите корректную почту.' }));
          if (String(pw).length < 8) return redirect('/register?' + qs({ err: 'Пароль — минимум 8 символов.' }));
          if (pw !== pw2) return redirect('/register?' + qs({ err: 'Пароли не совпадают.' }));
          const dup = await db.get('SELECT 1 x FROM web_users WHERE is_local = 1 AND (LOWER(login) = ? OR LOWER(email) = ?)', [login.toLowerCase(), email]).catch(() => null);
          if (dup) return redirect('/register?' + qs({ err: 'Логин или почта уже заняты.' }));
          const localId = 'local:' + crypto.randomBytes(9).toString('base64url');
          const rec = pwMake(pw);
          const now = new Date().toISOString();
          await db.run(
            `INSERT INTO web_users (discord_id, username, avatar, first_login, last_login, login_count, is_local, login, email, pass_hash, pass_salt)
             VALUES (?, ?, '', ?, ?, 1, 1, ?, ?, ?, ?)`,
            [localId, login, now, now, login, email, rec.hash, rec.salt],
          );
          const cookie = await issueWebSession(req, client, localId);
          return redirect('/me', { 'Set-Cookie': cookie });
        }

        if (path === '/login/local') {
          const id = (b.get('login') || '').trim().toLowerCase();
          const pw = b.get('password') || '';
          const row = await db.get('SELECT discord_id, login, pass_hash, pass_salt FROM web_users WHERE is_local = 1 AND (LOWER(login) = ? OR LOWER(email) = ?)', [id, id]).catch(() => null);
          if (!row || !pwVerify(pw, row.pass_salt, row.pass_hash)) {
            await logDenial(client, null, `/login/local неверные данные (${clientIp})`).catch(() => {});
            return redirect('/login/local?' + qs({ err: 'Неверный логин или пароль.' }));
          }
          const cookie = await issueWebSession(req, client, row.discord_id);
          return redirect('/me', { 'Set-Cookie': cookie });
        }

        // /forgot
        const login = (b.get('login') || '').trim().slice(0, 60);
        const email = (b.get('email') || '').trim().toLowerCase().slice(0, 120);
        const note = (b.get('note') || '').trim().slice(0, 500);
        if (!login && !email) return redirect('/forgot?' + qs({ err: 'Укажите логин или почту.' }));
        const r = await db.run('INSERT INTO password_reset_requests (login, email, note, status, created_at) VALUES (?, ?, ?, \'pending\', ?)', [login, email, note, new Date().toISOString()]);
        try { await hook('notifyPasswordReset')(r.lastID); } catch (_) {}
        return redirect('/login/local?' + qs({ ok: 'Заявка на сброс пароля отправлена — с вами свяжется руководство.' }));
      }

      if (req.method === 'POST') {
        if (!rateOk(user ? 'u:' + user.id : 'ip:' + clientIp)) {
          await logDenial(client, user, `${path} (rate limit, ${clientIp})`).catch(() => {});
          return redirect((path.startsWith('/panel') ? '/panel' : path.startsWith('/u/') ? '/people' : '/me') + '?' + qs({ err: 'Слишком много запросов — подождите минуту.' }));
        }
        const acc = user ? await accessFor(client, user.id) : { rank: 0, level: 'guest' };
        const body = await readBody(req);
        const loc = await handlePost(client, path, user, body, acc, req.headers.cookie);
        if (/[?&]err=[^&]*(?:%D0%BF%D1%80%D0%B0%D0%B2|%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF)/i.test(loc || '')) {
          await logDenial(client, user, `${path} → ${decodeURIComponent((loc.split('err=')[1] || '').split('&')[0])}`).catch(() => {});
        }
        return redirect(loc || '/');
      }

      if (path === '/' && req.method === 'GET') {
        const level = user ? (await accessFor(client, user.id)).level : 'guest';
        return html(200, L({ title: siteBrand(), user, level, body: flash + await landingBody(await orgStats()) }));
      }

      if (path.startsWith('/asset/') && req.method === 'GET') {
        const aid = parseInt(path.slice(7), 10) || 0;
        const a = await db.get('SELECT id, mime, data, file FROM page_assets WHERE id = ?', [aid]).catch(() => null);
        if (!a) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
        const etag = `"a${aid}"`;
        if ((req.headers['if-none-match'] || '') === etag) return done(304, { ETag: etag, 'Cache-Control': 'public, max-age=86400' }, '');
        const buf = await loadUploadBytes('page_assets', a);
        if (!buf) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
        return done(200, { 'Content-Type': a.mime || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', ETag: etag }, buf);
      }

      if (path.startsWith('/cimg/') && req.method === 'GET') {
        const cid = parseInt(path.slice(6), 10) || 0;
        const tokenOk = cimgTokenOk(cid, u.searchParams.get('t'));
        if (!tokenOk && !user) return done(401, { 'Content-Type': 'text/plain' }, 'auth');
        const im = await db.get('SELECT id, owner_id, mime, data, file FROM contract_uploads WHERE id = ?', [cid]).catch(() => null);
        if (!im) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
        if (!tokenOk && im.owner_id !== user.id) {
          // скрины контрактов не секретны внутри организации — доступны участникам+
          const a2 = await accessFor(client, user.id).catch(() => ({ rank: 0 }));
          if (a2.rank < LEVELS.member) return done(403, { 'Content-Type': 'text/plain' }, 'forbidden');
        }
        const etag = `"c${cid}"`;
        if ((req.headers['if-none-match'] || '') === etag) return done(304, { ETag: etag, 'Cache-Control': 'private, max-age=3600' }, '');
        const buf = await loadUploadBytes('contract_uploads', im);
        if (!buf) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
        return done(200, { 'Content-Type': im.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=3600', ETag: etag }, buf);
      }

      if (path.startsWith('/text/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для участников</h1><a class="btn" href="/apply">Подать заявку</a>' }));
        const key = path.slice(6);
        const TITLES = { rules: 'Свод правил', agitation: 'Агитация', hr_info: 'Вакансия HR-Менеджера' };
        if (!TITLES[key]) return html(404, L({ title: 'Не найдено', user, level: acc.level, body: '<h1>Не найдено</h1>' }));
        let txt = '';
        try { const row = await contentVersions.getLatestVersion(key); txt = row ? row.content : ''; } catch (_) {}
        if (!txt || !txt.trim()) txt = ({ rules: content.DEFAULT_RULES, agitation: content.DEFAULT_AGITATION, hr_info: content.DEFAULT_HR_INFO }[key]) || '';
        const strip = `<div class="tabs"><a href="/text/rules"${key === 'rules' ? ' class="on"' : ''}>Правила</a><a href="/text/agitation"${key === 'agitation' ? ' class="on"' : ''}>Агитация</a><a href="/text/hr_info"${key === 'hr_info' ? ' class="on"' : ''}>Вакансия HR</a></div>`;
        return html(200, L({ title: TITLES[key], user, level: acc.level, wide: true, body: flash + `<h1>${esc(TITLES[key])}</h1>${strip}<div class="card">${mdToHtml(txt)}</div>` }));
      }

      // ----- Доски (havirys + по гранту view/edit) -----
      if (path === '/board-editor.js' && req.method === 'GET') {
        return done(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, BOARD_EDITOR_JS);
      }
      if (path === '/boards' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const bacc = await accessFor(client, user.id).catch(() => ({ level: 'guest', rank: 0 }));
        const showArch = u.searchParams.get('arch') === '1';
        const all = await db.all('SELECT * FROM boards WHERE archived = ? ORDER BY updated_at DESC, id DESC', [showArch ? 1 : 0]).catch(() => []);
        const rows = [];
        for (const b of all) { const m = await boardAccess(client, user, b); if (m) { b._mode = m; rows.push(b); } }
        if (!rows.length && user.id !== OWNER_ID && bacc.rank < LEVELS.deputy) {
          return html(403, L({ title: 'Доски', user, level: bacc.level, body: '<h1>Доски</h1><div class="card">Вам не открыта ни одна доска.</div>' }));
        }
        return html(200, L({ title: 'Доски', user, level: bacc.level, wide: true, body: flash + boardsListBody(rows, user, showArch, bacc) }));
      }
      if (path.startsWith('/board/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const bacc = await accessFor(client, user.id).catch(() => ({ level: 'guest', rank: 0 }));
        const seg = path.slice(7).split('/');
        const bid = parseInt(seg[0], 10) || 0;
        const sub = seg[1] || '';
        const board = await db.get('SELECT * FROM boards WHERE id = ?', [bid]).catch(() => null);
        if (!board) return html(404, L({ title: 'Доска', user, level: bacc.level, body: '<h1>Доска не найдена</h1><a class="btn" href="/boards">← к списку</a>' }));
        const mode = await boardAccess(client, user, board);
        if (!mode) return html(403, L({ title: 'Доска', user, level: bacc.level, body: '<h1>Нет доступа к этой доске</h1><a class="btn" href="/boards">← к списку</a>' }));
        const isOwner = user.id === OWNER_ID;
        if (sub === 'image.png') {
          if (!board.image_file) return done(404, { 'Content-Type': 'text/plain' }, 'no image');
          const buf = await readUploadFile(board.image_file);
          if (!buf) return done(404, { 'Content-Type': 'text/plain' }, 'no image');
          return done(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60' }, buf);
        }
        if (sub === 'export.json') {
          return done(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="board-${bid}.json"` }, JSON.stringify(boardParse(board.data)));
        }
        if ((sub === 'edit' || sub === 'settings') && mode !== 'edit') {
          return html(403, L({ title: 'Доска', user, level: bacc.level, body: '<h1>Доска открыта только для просмотра</h1><a class="btn" href="/board/' + bid + '">Открыть просмотр</a>' }));
        }
        if (sub === 'edit') return html(200, L({ title: '✎ ' + (board.title || 'Доска'), user, level: bacc.level, wide: true, body: boardEditBody(board, user) }));
        if (sub === 'settings') {
          const grants = isOwner ? await db.all('SELECT * FROM board_grants WHERE board_id = ? ORDER BY id', [bid]).catch(() => []) : [];
          return html(200, L({ title: 'Доска — настройки', user, level: bacc.level, wide: true, body: flash + boardSettingsBody(board, user, grants, isOwner) }));
        }
        if (sub === 'versions') {
          const vs = await db.all('SELECT id, version, saved_by, saved_at FROM board_versions WHERE board_id = ? ORDER BY version DESC LIMIT 100', [bid]).catch(() => []);
          return html(200, L({ title: 'Доска — версии', user, level: bacc.level, wide: true, body: flash + boardVersionsBody(board, vs, user, mode === 'edit') }));
        }
        return html(200, L({ title: board.title || 'Доска', user, level: bacc.level, wide: true, body: flash + boardViewBody(board, user, mode === 'edit') }));
      }

      if (path.startsWith('/form/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        const slug = decodeURIComponent(path.slice(6)).split('/')[0].toLowerCase();
        const f = slug ? await db.get('SELECT * FROM forms WHERE slug = ?', [slug]).catch(() => null) : null;
        if (!f || !f.active) return html(404, L({ title: 'Форма не найдена', user, level: acc.level, body: '<h1>Форма не найдена или закрыта</h1><a class="btn" href="/me">В кабинет</a>' }));
        return html(200, L({ title: f.name || 'Форма', user, level: acc.level, body: flash + await formPublicBody(client, user, f) }));
      }

      if ((path === '/rules' || path === '/about' || path.startsWith('/p/')) && req.method === 'GET') {
        const level = user ? (await accessFor(client, user.id)).level : 'guest';
        const slug = path === '/rules' ? 'rules' : path === '/about' ? 'about' : decodeURIComponent(path.slice(3)).split('/')[0];
        const pg = await db.get('SELECT * FROM site_pages WHERE slug = ?', [slug]).catch(() => null);
        const draftHidden = pg && !pg.published && (!user || user.id !== OWNER_ID);
        if (!pg || draftHidden) return html(404, L({ title: 'Страница не найдена', user, level, body: '<h1>Страница не найдена</h1><a class="btn" href="/">На главную</a>' }));
        return html(200, L({ title: pg.title || slug, user, level, body: flash + `${!pg.published ? '<div class="card" style="border-color:var(--warn)"><b>Черновик</b> — виден только вам (havirys).</div>' : ''}<h1>${esc(pg.title || slug)}</h1><div class="card">${mdToHtml(pg.content || '')}</div>` }));
      }

      if (path === '/login') {
        if (u.searchParams.get('go') === 'discord' || u.searchParams.get('go') === 'link') {
          if (!process.env.CLIENT_ID) return html(500, L({ title: 'Ошибка', body: '<h1>CLIENT_ID не задан</h1>' }));
          const params = new URLSearchParams({ client_id: process.env.CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: 'identify' });
          if (u.searchParams.get('go') === 'link') params.set('state', 'link');
          return redirect(`${DISCORD_API}/oauth2/authorize?${params.toString()}`);
        }
        if (user) return redirect('/me');
        return html(200, L({ title: 'Вход', user: null, level: 'guest', body: flash + `
          <h1>Вход</h1>
          <div class="card" style="max-width:420px">
            <a class="btn" href="/login?go=discord" style="width:100%;text-align:center">Войти через Discord</a>
            <div class="mini" style="text-align:center;margin:10px 0">— или —</div>
            <a class="btn ghost" href="/login/local" style="width:100%;text-align:center">Войти по логину и паролю</a>
            <div class="mini" style="text-align:center;margin-top:10px">Нет аккаунта? <a href="/register">Зарегистрироваться</a></div>
          </div>` }));
      }

      if (path === '/login/local' && req.method === 'GET') {
        if (user) return redirect('/me');
        return html(200, L({ title: 'Вход по паролю', user: null, level: 'guest', body: flash + `
          <h1>Вход по логину и паролю</h1>
          <div class="card" style="max-width:420px">
            <form method="POST" action="/login/local" class="form">${anonCsrfField()}
              <label>Логин или почта<input name="login" required maxlength="120" autofocus></label>
              <label>Пароль<input name="password" type="password" required maxlength="200"></label>
              <button class="btn" type="submit">Войти</button>
            </form>
            <div class="mini" style="margin-top:10px"><a href="/register">Регистрация</a> · <a href="/forgot">Забыли пароль?</a> · <a href="/login?go=discord">Войти через Discord</a></div>
          </div>` }));
      }

      if (path === '/register' && req.method === 'GET') {
        if (user) return redirect('/me');
        return html(200, L({ title: 'Регистрация', user: null, level: 'guest', body: flash + `
          <h1>Регистрация без Discord</h1>
          <div class="card" style="max-width:420px">
            <p class="mini">Аккаунт по логину и паролю — для тех, у кого нет Discord. Чтобы подать заявку на вступление, позже нужно будет привязать Discord (аккаунт должен быть на сервере).</p>
            <form method="POST" action="/register" class="form">${anonCsrfField()}
              <label>Логин (3–32, латиница/цифры/._-)<input name="login" required maxlength="32" pattern="[a-zA-Z0-9_.-]{3,32}"></label>
              <label>Почта<input name="email" type="email" required maxlength="120"></label>
              <label>Пароль (минимум 8 символов)<input name="password" type="password" required minlength="8" maxlength="200"></label>
              <label>Повторите пароль<input name="password2" type="password" required minlength="8" maxlength="200"></label>
              <button class="btn" type="submit">Создать аккаунт</button>
            </form>
            <div class="mini" style="margin-top:10px">Уже есть аккаунт? <a href="/login/local">Войти</a></div>
          </div>` }));
      }

      if (path === '/forgot' && req.method === 'GET') {
        return html(200, L({ title: 'Сброс пароля', user: null, level: 'guest', body: flash + `
          <h1>Сброс пароля</h1>
          <div class="card" style="max-width:420px">
            <p class="mini">Писем мы не шлём. Заявка уйдёт руководству — с вами свяжутся в Discord и сбросят пароль вручную.</p>
            <form method="POST" action="/forgot" class="form">${anonCsrfField()}
              <label>Ваш логин<input name="login" maxlength="60"></label>
              <label>Почта аккаунта<input name="email" type="email" maxlength="120"></label>
              <label>Как с вами связаться / комментарий<textarea name="note" rows="3" maxlength="500"></textarea></label>
              <button class="btn" type="submit">Отправить заявку</button>
            </form>
            <div class="mini" style="margin-top:10px"><a href="/login/local">← ко входу</a></div>
          </div>` }));
      }

      if (path === '/account' && req.method === 'GET') {
        if (!user) return redirect('/login');
        if (!user.local) return redirect('/me');
        const lu = await db.get('SELECT login, email, linked_discord_id, oauth_discord_id FROM web_users WHERE discord_id = ?', [user.localId]).catch(() => null);
        const acc = await accessFor(client, user.id);
        const linkedTxt = lu && lu.linked_discord_id
          ? `Привязан к участнику: <b>${esc(nickOf(client, lu.linked_discord_id) || lu.linked_discord_id)}</b> — на сайте вы работаете от его имени.`
          : (lu && lu.oauth_discord_id
            ? `Discord привязан (${esc(lu.oauth_discord_id)})${guildOf(client) && guildOf(client).members.cache.get(lu.oauth_discord_id) ? ' — вы на сервере ✅' : ' — но вас нет на сервере ⚠'}.`
            : 'Discord не привязан. Чтобы подать заявку на вступление, привяжите Discord (аккаунт должен быть на сервере).');
        return html(200, L({ title: 'Аккаунт', user, level: acc.level, body: flash + `
          <h1>Мой аккаунт</h1>
          <div class="card"><b>Логин:</b> ${esc(lu ? lu.login : user.username)}<br><b>Почта:</b> ${esc(lu ? lu.email || '—' : '—')}</div>
          <div class="card"><h2>Discord</h2><p>${linkedTxt}</p>
            ${lu && lu.linked_discord_id ? '' : `<a class="btn sm" href="/login?go=link">Привязать Discord</a>
            ${lu && lu.oauth_discord_id ? `<form method="POST" action="/account/discord_unlink" style="display:inline;margin-left:6px">${csrfField(user)}<button class="btn ghost sm" type="submit">Отвязать</button></form>` : ''}`}
          </div>
          <div class="card"><h2>Сменить пароль</h2>
            <form method="POST" action="/account/password" class="form">${csrfField(user)}
              <label>Текущий пароль<input name="old" type="password" required maxlength="200"></label>
              <label>Новый пароль (минимум 8)<input name="new" type="password" required minlength="8" maxlength="200"></label>
              <label>Повторите новый<input name="new2" type="password" required minlength="8" maxlength="200"></label>
              <button class="btn" type="submit">Сохранить</button>
            </form>
          </div>
          <p><a href="/me">← в кабинет</a></p>` }));
      }

      if (path === '/logout') {
        return redirect('/', { 'Set-Cookie': 'fc_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      }

      // Вход по одноразовой ссылке (Discord: команда /сайт или кнопка в канале входа).
      if (path.startsWith('/m/') && req.method === 'GET') {
        const token = decodeURIComponent(path.slice(3)).trim();
        const row = token ? await db.get('SELECT * FROM magic_links WHERE token = ?', [token]).catch(() => null) : null;
        const bad = !row || row.used_at || (row.expires_at && Date.parse(row.expires_at) < Date.now());
        if (bad) {
          return html(400, L({ title: 'Ссылка недействительна', body:
            `<h1>Ссылка для входа недействительна или истекла</h1>
             <div class="card">Одноразовые ссылки живут 10 минут и срабатывают один раз.<br><br>
             Запросите новую: команда <b>/сайт</b> в Discord или кнопка «Войти на сайт» в канале входа.</div>
             <a class="btn" href="/login">Войти через Discord</a>` }));
        }
        await db.run('UPDATE magic_links SET used_at = ? WHERE token = ?', [new Date().toISOString(), token]).catch(() => {});
        try {
          const cookie = await issueWebSession(req, client, row.discord_id);
          return redirect('/me', { 'Set-Cookie': cookie });
        } catch (err) {
          console.error('[web] magic-link вход:', err.message);
          return html(500, L({ title: 'Ошибка входа', body: '<h1>Не удалось войти по ссылке</h1><a class="btn" href="/login">Войти через Discord</a>' }));
        }
      }

      // Подписка на календарь отпусков (.ics). Доступ по секретному токену в ?key=,
      // чтобы календарные приложения (без входа) могли тянуть события.
      if ((path === '/calendar.ics' || path === '/calendar-all.ics') && req.method === 'GET') {
        const key = (u.searchParams.get('key') || '').trim();
        const owner = key ? await db.get('SELECT discord_id FROM web_users WHERE ical_token = ?', [key]).catch(() => null) : null;
        if (!owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Неверная ссылка-подписка.');
        let ics;
        if (path === '/calendar-all.ics') {
          const oa = await accessFor(client, owner.discord_id).catch(() => ({ rank: 0 }));
          if (oa.rank < LEVELS.hr) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Общий календарь доступен только HR и выше.');
          ics = await buildVacationIcs(siteBrand() + ' — отпуска (все)', null);
        } else {
          ics = await buildVacationIcs(siteBrand() + ' — мои отпуска', owner.discord_id);
        }
        return done(200, {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': `inline; filename="${path === '/calendar-all.ics' ? 'vacations-all.ics' : 'vacations.ics'}"`,
          'Cache-Control': 'private, max-age=900',
        }, ics);
      }

      if (path.startsWith('/i/') && req.method === 'GET') {
        const code = decodeURIComponent(path.slice(3)).replace(/[^a-z0-9]/gi, '').slice(0, 24);
        const link = code ? await db.get('SELECT * FROM invite_links WHERE code = ?', [code]) : null;
        if (link) {
          await db.run('UPDATE invite_links SET uses = uses + 1 WHERE code = ?', [code]);
          return redirect('/apply', { 'Set-Cookie': `fc_ref=${encodeURIComponent(link.creator_id)}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax` });
        }
        return redirect('/apply');
      }

      if (path === '/auth/callback') {
        const code = u.searchParams.get('code');
        if (!code) return redirect('/');
        try {
          const tr = await fetch(`${DISCORD_API}/oauth2/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri() }).toString(),
          });
          if (!tr.ok) throw new Error(`token ${tr.status}`);
          const tok = await tr.json();
          const mr = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
          if (!mr.ok) throw new Error(`users/@me ${mr.status}`);
          const me = await mr.json();
          const uname = me.username || me.global_name || me.id;
          const now = new Date().toISOString();

          // Привязка Discord к локальному аккаунту (не вход) — state=link.
          if (u.searchParams.get('state') === 'link' && user && user.local) {
            const taken = await db.get('SELECT discord_id FROM web_users WHERE discord_id = ? OR (is_local = 1 AND oauth_discord_id = ?)', [me.id, me.id]).catch(() => null);
            if (taken && taken.discord_id !== user.localId) {
              return html(400, L({ title: 'Discord занят', user, body: '<h1>Этот Discord уже привязан к другому аккаунту</h1><a class="btn" href="/account">← к аккаунту</a>' }));
            }
            await db.run('UPDATE web_users SET oauth_discord_id = ? WHERE discord_id = ?', [me.id, user.localId]);
            return redirect('/account?' + qs({ ok: 'Discord привязан.' }));
          }
          await db.run(
            `INSERT INTO web_users (discord_id, username, avatar, first_login, last_login, login_count)
             VALUES (?, ?, ?, ?, ?, 1)
             ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar,
               last_login = excluded.last_login, login_count = login_count + 1`,
            [me.id, uname, me.avatar || '', now, now],
          );
          accessCache.delete(me.id);
          const svRow = await db.get('SELECT sess_ver FROM web_users WHERE discord_id = ?', [me.id]).catch(() => null);
          const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
          const ua = (req.headers['user-agent'] || '').slice(0, 300);
          // Новое устройство: этот UA у пользователя раньше не встречался.
          const seenBefore = await db.get('SELECT 1 x FROM web_logins WHERE discord_id = ? AND ua = ? LIMIT 1', [me.id, ua]).catch(() => null);
          await db.run('INSERT INTO web_logins (discord_id, ip, ua, at) VALUES (?, ?, ?, ?)', [me.id, ip, ua, now]).catch(() => {});
          const sid = crypto.randomBytes(9).toString('base64url');
          await db.run('INSERT INTO web_sessions (sid, discord_id, ip, ua, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)', [sid, me.id, ip, ua, now, now]).catch(() => {});
          if (!seenBefore) {
            const short = (ua || 'неизвестный браузер').slice(0, 80);
            await pushNotify(me.id, 'security', `Вход с нового устройства: ${short}${ip ? ` (IP ${ip})` : ''}. Если это не вы — «Выйти со всех устройств» в разделе «Активные сессии».`, '/me').catch(() => {});
            await dmTo(client, me.id, `🔐 Новый вход на сайт «${siteBrand()}»\nУстройство: ${short}\nIP: ${ip || '—'}\nВремя: ${new Date().toLocaleString('ru-RU')}\n\nЕсли это не вы — зайдите в «Мой профиль» → «Активные сессии» и нажмите «Выйти со всех устройств».`).catch(() => {});
          }
          const cookie = `fc_sess=${makeSession({ id: me.id, username: uname, avatar: me.avatar || '', sv: svRow ? (svRow.sess_ver || 0) : 0, sid })}; Path=/; Max-Age=${SESSION_DAYS * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`;
          return redirect('/me', { 'Set-Cookie': cookie });
        } catch (err) {
          console.error('[web] OAuth ошибка:', err.message);
          return html(502, L({ title: 'Ошибка входа', body: `<h1>Не удалось войти через Discord</h1><p class="muted">${esc(err.message)}</p><a class="btn" href="/">На главную</a>` }));
        }
      }

      if (path === '/apply' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const level = (await accessFor(client, user.id)).level;
        if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id])) return redirect('/me');
        const eff = effectiveDiscordId(user);
        if (!eff || !(await memberOfGuild(client, eff))) {
          const inv = (SITE && SITE.invite) || config.SITE_DISCORD_INVITE || '';
          return html(200, L({ title: 'Заявка на вступление', user, level, body: flash + `
            <h1>Заявка на вступление</h1>
            <div class="card">
              <p>Чтобы подать заявку, нужно быть на Discord-сервере организации${user.local ? ' и привязать Discord к аккаунту (аккаунт должен быть на сервере)' : ''}.</p>
              ${inv ? `<a class="btn" href="${esc(inv)}" target="_blank" rel="noopener">Зайти на Discord-сервер</a> ` : ''}
              ${user.local ? '<a class="btn ghost" href="/login?go=link">Привязать Discord</a>' : ''}
            </div>` }));
        }
        return html(200, L({ title: 'Заявка на вступление', user, level, body: flash + applyBody(user, getCookie(req.headers.cookie, 'fc_ref')) }));
      }

      if (path === '/me/export.json' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const id = user.id;
        const pick = async (sql, p = []) => db.all(sql, p).catch(() => []);
        const out = {
          exported_at: new Date().toISOString(),
          discord_id: id,
          participant: await db.get('SELECT * FROM participants WHERE discord_id = ?', [id]).catch(() => null),
          passports: await pick('SELECT * FROM extra_passports WHERE discord_id = ?', [id]),
          applications: await pick('SELECT * FROM applications WHERE discord_id = ?', [id]),
          contracts: await pick('SELECT id, thread_id, status, submitted_at, taken_submitted_at, message_url FROM contracts WHERE discord_id = ?', [id]),
          vacations: await pick('SELECT * FROM vacations WHERE discord_id = ?', [id]),
          kicks: await pick('SELECT * FROM kicks WHERE discord_id = ?', [id]),
          invitations: await pick('SELECT * FROM invitations WHERE inviter_discord_id = ?', [id]),
          thanks_received: await pick('SELECT from_id, note, created_at FROM thanks WHERE to_id = ?', [id]),
          badges: await pick('SELECT badge_key, awarded_at FROM badge_awards WHERE discord_id = ?', [id]),
          tickets: await pick('SELECT id, subject, category, status, rating, created_at, closed_at FROM tickets WHERE opener_id = ?', [id]),
          notifications: await pick('SELECT kind, text, link, created_at, read_at FROM notifications WHERE discord_id = ? ORDER BY id DESC LIMIT 500', [id]),
          web_logins: await pick('SELECT ip, ua, at FROM web_logins WHERE discord_id = ? ORDER BY id DESC LIMIT 100', [id]),
        };
        return done(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="my-data-${id}.json"`,
        }, JSON.stringify(out, null, 2));
      }

      if (path === '/me') {
        if (!user) return redirect('/login');
        let level = 'guest';
        try { level = (await accessFor(client, user.id)).level; } catch (_) {}
        let bodyHtml;
        try {
          bodyHtml = await meBody(client, user);
        } catch (err) {
          console.error('[web] /me meBody:', err && err.stack || err);
          bodyHtml = `<div class="phead"><h1>Личный кабинет</h1></div>
            <div class="card">Не удалось собрать профиль полностью: <code>${esc(err && err.message || 'ошибка')}</code>.
            <div class="muted" style="margin-top:6px">Вход выполнен. Попробуйте обновить страницу; если повторяется — сообщите разработчику.</div></div>
            <a class="btn" href="/">На главную</a>
            <a class="btn sm" href="/logout" style="background:var(--bad);margin-left:8px">Выйти из аккаунта</a>`;
        }
        return html(200, L({ title: 'Личный кабинет', user, level, wide: true, body: flash + bodyHtml }));
      }

      if (path === '/people' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ только для участников</h1><a class="btn" href="/apply">Подать заявку</a>' }));
        return html(200, L({ title: 'Участники', user, level: acc.level, wide: true, body: flash + await peopleBody(client, acc, u.searchParams.get('q'), pageNum, user) }));
      }

      if (path.startsWith('/u/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ только для участников</h1><a class="btn" href="/apply">Подать заявку</a>' }));
        const uparts = decodeURIComponent(path.slice(3)).split('/');
        if (uparts[1] === 'card.svg') {
          if (uparts[0] !== user.id && acc.rank < LEVELS.hr) return done(403, { 'Content-Type': 'text/plain' }, 'forbidden');
          const svg = await profileCardSvg(client, uparts[0]);
          if (!svg) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
          return done(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': `attachment; filename="card-${uparts[0]}.svg"` }, svg);
        }
        if (uparts[1] === 'card') {
          if (uparts[0] !== user.id && acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Только свой профиль или HR+</h1>' }));
          return html(200, L({ title: 'Карточка', user, level: acc.level, body: flash + await profileCardBody(client, uparts[0]) }));
        }
        return html(200, L({ title: 'Профиль', user, level: acc.level, wide: true, body: flash + await profileBody(client, user, acc, uparts[0]) }));
      }

      if (path === '/panel/page_diff' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (user.id !== OWNER_ID) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Только havirys</h1>' }));
        const slug = (u.searchParams.get('slug') || '').trim().toLowerCase();
        const vid = parseInt(u.searchParams.get('vid'), 10) || 0;
        const ver = await db.get('SELECT * FROM site_page_versions WHERE id = ? AND slug = ?', [vid, slug]).catch(() => null);
        const cur = await db.get('SELECT content FROM site_pages WHERE slug = ?', [slug]).catch(() => null);
        if (!ver || !cur) return html(404, L({ title: 'Нет данных', user, level: acc.level, body: '<h1>Версия или страница не найдена</h1>' }));
        return html(200, L({ title: 'Различия', user, level: acc.level, wide: true, body: flash + `
          <h1>Различия: <code>/p/${esc(slug)}</code></h1>
          <p class="mini">Слева — версия от ${fmt(ver.saved_at)}, справа — текущая. Зелёное — добавлено, красное — убрано.</p>
          <div class="card">${lineDiffHtml(ver.content || '', cur.content || '')}</div>
          <p><a href="/panel?tab=pages">← к страницам</a></p>` }));
      }

      if (path === '/panel/row' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (user.id !== OWNER_ID) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Редактор БД доступен только владельцу (havirys).</p>' }));
        return html(200, L({ title: 'Правка строки', user, level: acc.level, wide: true, body: flash + await rowEditBody(client, user, u.searchParams.get('table'), u.searchParams.get('pk')) }));
      }

      if (path === '/panel/row/new' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (user.id !== OWNER_ID) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Редактор БД доступен только владельцу (havirys).</p>' }));
        return html(200, L({ title: 'Новая строка', user, level: acc.level, wide: true, body: flash + await rowNewBody(client, user, u.searchParams.get('table')) }));
      }

      if (path === '/panel') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        const grantsForGate = await getPanelGrants(client, user.id);
        if (acc.rank < LEVELS.hr && grantsForGate.size === 0) {
          return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Панель управления доступна HR-Менеджеру и выше (или по выданному доступу).</p><a class="btn" href="/me">Мой профиль</a>' }));
        }
        let tab = u.searchParams.get('tab') || 'overview';
        // Пользователю с точечным доступом открываем его первый раздел, а не «Обзор».
        if (acc.rank < LEVELS.hr && !grantsForGate.has(tab)) tab = [...grantsForGate][0] || 'overview';
        return html(200, L({ title: 'Панель управления', user, level: acc.level, wide: true, body: flash + await panelBody(client, acc, user, tab, pageNum, u.searchParams.get('table'), u.searchParams) }));
      }

      // ----- Аналитика / инструменты -----
      if ((path === '/dashboard' || path === '/leaderboards' || path === '/calendar' || path === '/search') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для HR-Менеджера и выше</h1><a class="btn" href="/me">Мой профиль</a>' }));
        let bodyHtml;
        if (path === '/dashboard') bodyHtml = await dashboardBody(client, u.searchParams.get('days'));
        else if (path === '/leaderboards') bodyHtml = await leaderboardsBody(client, user.id);
        else if (path === '/calendar') bodyHtml = await calendarBody(client, user);
        else bodyHtml = await searchBody(client, u.searchParams.get('q'));
        return html(200, L({ title: 'Аналитика', user, level: acc.level, wide: true, body: flash + bodyHtml }));
      }

      if (path === '/compare' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для участников организации</h1><a class="btn" href="/me">Мой профиль</a>' }));
        return html(200, L({ title: 'Сравнение', user, level: acc.level, wide: true, body: flash + await compareBody(client, user.id, (u.searchParams.get('with') || '').trim(), u.searchParams.get('days')) }));
      }

      if (path === '/bug' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        return html(200, L({ title: 'Сообщить о баге', user, level: acc.level, body: flash + await bugReportBody(client, user, acc) }));
      }

      if (path === '/tickets' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Список тикетов — для HR и выше</h1><a class="btn" href="/me">Мой профиль</a>' }));
        return html(200, L({ title: 'Тикеты', user, level: acc.level, wide: true, body: flash + await ticketsListBody(client, u.searchParams, user) }));
      }

      if (path === '/audit' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.deputy) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Аудит — Зам. Владелец и выше</h1>' }));
        return html(200, L({ title: 'Аудит', user, level: acc.level, wide: true, body: flash + await auditBody(client, u.searchParams, pageNum, user) }));
      }

      if (path === '/tools' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.owner) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Инструменты — Admin / Владелец</h1>' }));
        return html(200, L({ title: 'Инструменты', user, level: acc.level, wide: true, body: flash + await toolsBody(client, acc, user) }));
      }

      if (path === '/health' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.owner) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Только для Владельца</h1>' }));
        return html(200, L({ title: 'Здоровье системы', user, level: acc.level, wide: true, body: flash + await healthBody(client) }));
      }

      if (path === '/faq' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        return html(200, L({ title: 'FAQ', user, level: acc.level, wide: true, body: flash + await faqBody(client, acc, user) }));
      }

      if (path === '/giveaways' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Розыгрыши — для участников организации</h1><p class="muted">Розыгрыши проходят внутри организации.</p><a class="btn" href="/apply">Подать заявку</a>' }));
        return html(200, L({ title: 'Розыгрыши', user, level: acc.level, wide: true, body: flash + await giveawaysPublicBody(client) }));
      }

      if (path === '/giveaways/history' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для HR-Менеджера и выше</h1>' }));
        return html(200, L({ title: 'История розыгрышей', user, level: acc.level, wide: true, body: flash + await giveawayHistoryBody(client) }));
      }

      if (path === '/notifications' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        return html(200, L({ title: 'Уведомления', user, level: acc.level, body: flash + await notificationsBody(user, u.searchParams) }));
      }

      // Переход по уведомлению — помечаем прочитанным и ведём на ссылку.
      if (/^\/n\/\d+$/.test(path) && req.method === 'GET') {
        if (!user) return redirect('/login');
        const nid = parseInt(path.slice(3), 10) || 0;
        const n = await db.get('SELECT link FROM notifications WHERE id = ? AND discord_id = ?', [nid, user.id]).catch(() => null);
        await db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND discord_id = ?', [new Date().toISOString(), nid, user.id]).catch(() => {});
        invalidateUnread(user.id);
        const dest = n && n.link && /^\/[a-z0-9/_?=&.-]*$/i.test(n.link) ? n.link : '/notifications';
        return redirect(dest);
      }

      if (path === '/commands' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        return html(200, L({ title: 'Команды', user, level: acc.level, wide: true, body: flash + commandsBody(acc, user) }));
      }

      if (path === '/board' && req.method === 'GET') {
        return html(200, L({ title: siteBrand(), user, level: user ? (await accessFor(client, user.id)).level : 'guest', wide: true, body: flash + await boardBody(client) }));
      }

      if (path.startsWith('/g/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Розыгрыши — для участников организации</h1><a class="btn" href="/apply">Подать заявку</a>' }));
        const gid = parseInt(decodeURIComponent(path.slice(3)), 10) || 0;
        return html(200, L({ title: 'Розыгрыш', user, level: acc.level, wide: true, body: flash + await giveawayPageBody(client, user, gid, acc) }));
      }

      if (/^\/ticket\/\d+\/transcript$/.test(path) && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        const tid = parseInt(path.split('/')[2], 10) || 0;
        const t = await db.get('SELECT opener_id FROM tickets WHERE id = ?', [tid]).catch(() => null);
        if (!t) return html(404, L({ title: 'Не найдено', user, level: acc.level, body: '<h1>Тикет не найден</h1>' }));
        if (t.opener_id !== user.id && acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Транскрипт доступен автору тикета или HR+</h1>' }));
        const trr = await db.get('SELECT html FROM ticket_transcripts WHERE ticket_id = ?', [tid]).catch(() => null);
        if (!trr || !trr.html) return html(404, L({ title: 'Нет транскрипта', user, level: acc.level, body: `<h1>Транскрипт ещё не создан</h1><a class="btn" href="/ticket/${tid}">← к тикету</a>` }));
        return done(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=300' }, trr.html);
      }

      if (/^\/ticket\/\d+\/status$/.test(path) && req.method === 'GET') {
        if (!user) return done(401, { 'Content-Type': 'application/json' }, '{}');
        const tid = parseInt(path.split('/')[2], 10) || 0;
        const t = await db.get('SELECT status, rating FROM tickets WHERE id = ?', [tid]).catch(() => null);
        return done(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, JSON.stringify(t || {}));
      }

      if (path.startsWith('/ticket/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        const tid = parseInt(decodeURIComponent(path.slice(8)), 10) || 0;
        return html(200, L({ title: 'Тикет', user, level: acc.level, wide: true, body: flash + await ticketPageBody(client, user, acc, tid) }));
      }

      // ----- Файловые выгрузки -----
      if (path.startsWith('/export/') || path === '/audit.csv') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Нет доступа');
        const sendCsv = (name, text) => done(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }, text);

        if (path === '/export/chart.csv') {
          const type = u.searchParams.get('type') || '';
          if (type === 'weekly_contracts') {
            const out = [];
            for (let w = 11; w >= 0; w--) {
              const r = contracts.getWeekRange(w);
              const cnt = await db.get("SELECT COUNT(*) c FROM contracts WHERE status='fulfilled' AND submitted_at BETWEEN ? AND ?", [r.start.toISOString(), r.end.toISOString()]).then((x) => (x ? x.c : 0)).catch(() => 0);
              out.push({ week: contracts.formatWeekLabel(r).replace(/\s*—.*/, ''), fulfilled: cnt });
            }
            return sendCsv('weekly_contracts.csv', toCsv(out, [{ key: 'week', label: 'Неделя' }, { key: 'fulfilled', label: 'Выполнено' }]));
          }
          return done(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Неизвестный график');
        }

        if (path.startsWith('/export/table/') && path.endsWith('.csv')) {
          if (user.id !== OWNER_ID) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только havirys');
          const tbl = path.slice('/export/table/'.length, -'.csv'.length);
          if (!DATA_TABLES[tbl]) return done(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Неизвестная таблица');
          const rows = await db.all(`SELECT * FROM ${tbl} LIMIT 50000`).catch(() => []);
          let cols = rows.length ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : [{ key: 'empty', label: 'empty' }];
          const want = (u.searchParams.get('cols') || '').split(',').map((s) => s.trim()).filter(Boolean);
          if (want.length) cols = cols.filter((c) => want.includes(c.key));
          if (!cols.length) cols = [{ key: 'empty', label: 'empty' }];
          await webAuditMeta(client, user, 'Экспорт таблицы CSV (сайт)', `${tbl} (${rows.length} строк${want.length ? ', колонки: ' + want.join(',') : ''})`);
          return sendCsv(`${tbl}.csv`, toCsv(rows, cols));
        }

        if (path === '/export/participants.csv') {
          const rows = await db.all('SELECT discord_id, discord_tag, name, static, lvl, role_id, joined_at, vacation_until, afk_since FROM participants ORDER BY name');
          for (const r of rows) r.rank = roleName(client, r.role_id);
          return sendCsv('participants.csv', toCsv(rows, [
            { key: 'discord_id', label: 'Discord ID' }, { key: 'discord_tag', label: 'Тег' }, { key: 'name', label: 'Имя Фамилия' },
            { key: 'static', label: '№ Паспорта' }, { key: 'lvl', label: 'LVL' }, { key: 'rank', label: 'Ранг' },
            { key: 'joined_at', label: 'Вступил' }, { key: 'vacation_until', label: 'Отпуск до' }, { key: 'afk_since', label: 'AFK с' },
          ]));
        }
        if (path === '/export/audit.csv' || path === '/audit.csv') {
          const days = parseInt(u.searchParams.get('days') || '30', 10) || 30;
          const since = new Date(Date.now() - days * 864e5).toISOString();
          const who = (u.searchParams.get('who') || '').trim();
          const act = (u.searchParams.get('act') || '').trim();
          const cond = ['at >= ?']; const par = [since];
          if (who) { cond.push('(actor_id = ? OR actor_tag LIKE ?)'); par.push(who, `%${who}%`); }
          if (act) { cond.push('action LIKE ?'); par.push(`%${act}%`); }
          const rows = await db.all(`SELECT at, actor_tag, action, details FROM audit_log WHERE ${cond.join(' AND ')} ORDER BY id DESC LIMIT 5000`, par);
          return sendCsv('audit.csv', toCsv(rows, [
            { key: 'at', label: 'Когда' }, { key: 'actor_tag', label: 'Кто' }, { key: 'action', label: 'Действие' }, { key: 'details', label: 'Детали' },
          ]));
        }
        if (path === '/export/stats.csv') {
          const range = contracts.getWeekRange(0);
          const lb = await contracts.getWeekLeaderboard(range);
          return sendCsv('stats-week.csv', toCsv(lb, [
            { key: 'discord_id', label: 'Discord ID' }, { key: 'fulfilled', label: 'Выполнено' }, { key: 'unfulfilled', label: 'Не выполнено' },
          ]));
        }
        if (path === '/export/dashboard.html') {
          const dstr = new Date().toISOString().slice(0, 10);
          const inner = await dashboardBody(client, u.searchParams.get('days'));
          const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Дашборд — ${esc(siteBrand())} — ${dstr}</title>
<style>${STYLE}${themeOverrideCss()}</style></head>
<body><div class="wrap wide">
<p class="mini">Снимок дашборда «${esc(siteBrand())}» · ${new Date().toLocaleString('ru-RU')}</p>
${inner}
</div>
<script>(function(){document.querySelectorAll('button,form,.gcd').forEach(function(e){if(e.classList.contains('gcd'))return;e.style.display='none'});document.querySelectorAll('.gcd').forEach(function(e){e.textContent='—'})})();</script>
</body></html>`;
          await webAuditMeta(client, user, 'Скачивание дашборда HTML (сайт)', dstr);
          return done(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="dashboard-${dstr}.html"` }, page);
        }
        if (path === '/export/db.sqlite') {
          if (acc.rank < LEVELS.owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только Владелец');
          try {
            const fs = require('fs');
            const buf = fs.readFileSync(db.dbPath);
            await webAuditMeta(client, user, 'Скачивание БД (сайт)', `${buf.length} байт`);
            return done(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="data.db"' }, buf);
          } catch (e) {
            return done(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Ошибка: ' + e.message);
          }
        }
        if (path === '/export/archive.zip') {
          if (acc.rank < LEVELS.owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только Владелец');
          try {
            const fs = require('fs');
            const files = [{ name: 'data.db', data: fs.readFileSync(db.dbPath) }];
            const parts = await db.all('SELECT discord_id, discord_tag, name, static, lvl, role_id, joined_at, vacation_until, afk_since FROM participants ORDER BY name');
            for (const r of parts) r.rank = roleName(client, r.role_id);
            files.push({ name: 'participants.csv', data: toCsv(parts, [
              { key: 'discord_id', label: 'Discord ID' }, { key: 'discord_tag', label: 'Тег' }, { key: 'name', label: 'Имя Фамилия' },
              { key: 'static', label: '№ Паспорта' }, { key: 'lvl', label: 'LVL' }, { key: 'rank', label: 'Ранг' }, { key: 'joined_at', label: 'Вступил' },
              { key: 'vacation_until', label: 'Отпуск до' }, { key: 'afk_since', label: 'AFK с' },
            ]) });
            const aud = await db.all('SELECT at, actor_tag, action, details FROM audit_log ORDER BY id DESC LIMIT 20000');
            files.push({ name: 'audit.csv', data: toCsv(aud, [
              { key: 'at', label: 'Когда' }, { key: 'actor_tag', label: 'Кто' }, { key: 'action', label: 'Действие' }, { key: 'details', label: 'Детали' },
            ]) });
            for (const [k, fn] of [['rules', 'rules.txt'], ['agitation', 'agitation.txt'], ['hr_info', 'hr_vacancy.txt']]) {
              const row = await contentVersions.getLatestVersion(k).catch(() => null);
              files.push({ name: fn, data: (row && row.content) || '' });
            }
            const zip = zipStore(files);
            await webAuditMeta(client, user, 'Экспорт архива .zip (сайт)', `${files.length} файлов, ${(zip.length / 1048576).toFixed(2)} МБ`);
            return done(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="freelance-archive-${new Date().toISOString().slice(0, 10)}.zip"` }, zip);
          } catch (e) {
            return done(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Ошибка: ' + e.message);
          }
        }
        if (path.startsWith('/export/backup/')) {
          if (acc.rank < LEVELS.owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только Владелец');
          const fname = decodeURIComponent(path.slice('/export/backup/'.length)).replace(/[^a-zA-Z0-9._-]/g, '');
          try {
            const fs = require('fs'); const pathMod = require('path');
            const dir = db.dataDir ? pathMod.join(db.dataDir, 'backups') : 'backups';
            const full = pathMod.join(dir, fname);
            if (!full.startsWith(dir) || !fs.existsSync(full)) return done(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
            return done(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fname}"` }, fs.readFileSync(full));
          } catch (e) { return done(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Ошибка: ' + e.message); }
        }
        if (path.startsWith('/export/giveaway/')) {
          const gid = parseInt(path.slice('/export/giveaway/'.length), 10) || 0;
          if (acc.rank < LEVELS.owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только Владелец');
          const ents = await giveaways.getEntries(gid).catch(() => []);
          const rows = ents.map((e) => ({ discord_id: e, name: nickOf(client, e) || '' }));
          return sendCsv(`giveaway-${gid}.csv`, toCsv(rows, [{ key: 'discord_id', label: 'Discord ID' }, { key: 'name', label: 'Имя на сервере' }]));
        }
        if (path === '/export/site-config.json') {
          if (acc.rank < LEVELS.owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только Владелец');
          const srows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'site.%'").catch(() => []);
          const site = {}; for (const r of srows) site[r.key] = r.value;
          const chans = {};
          for (const k of Object.keys(config).filter((x) => x.startsWith('CHANNEL_'))) chans[k] = String(config[k] || '');
          return done(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="site-config.json"' },
            JSON.stringify({ site, channels: chans }, null, 2));
        }
        if (path === '/export/stats-period.csv') {
          if (acc.rank < LEVELS.deputy) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Нет доступа');
          const from = (u.searchParams.get('from') || '').trim();
          const to = (u.searchParams.get('to') || '').trim();
          if (!from || !to) return done(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Укажите from/to');
          const a = from + 'T00:00:00.000Z'; const b = to + 'T23:59:59.999Z';
          const lb = await db.all(
            `SELECT discord_id,
               SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END) fulfilled,
               SUM(CASE WHEN status='unfulfilled' THEN 1 ELSE 0 END) unfulfilled
             FROM contracts WHERE submitted_at BETWEEN ? AND ? GROUP BY discord_id ORDER BY fulfilled DESC`, [a, b]);
          for (const r of lb) r.name = nickOf(client, r.discord_id) || '';
          return sendCsv(`stats_${from}_${to}.csv`, toCsv(lb, [
            { key: 'discord_id', label: 'Discord ID' }, { key: 'name', label: 'Имя' }, { key: 'fulfilled', label: 'Выполнено' }, { key: 'unfulfilled', label: 'Не выполнено' },
          ]));
        }
        return done(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
      }

      return html(404, L({ title: '404', body: '<h1>404</h1><a class="btn" href="/">На главную</a>' }));
    } catch (err) {
      console.error('[web] Ошибка запроса:', err.message);
      recordWebErr(req.url || '', err && (err.stack || err.message));
      try { html(500, layout({ title: '500', body: '<h1>Внутренняя ошибка</h1>' })); } catch (_) {}
    } finally {
      const ms = Date.now() - _reqStart;
      if (ms > 1500) { _slowLog.push({ at: Date.now(), path: (req.url || '').split('?')[0], ms }); if (_slowLog.length > 300) _slowLog.splice(0, _slowLog.length - 300); }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web] Сайт запущен: ${baseUrl()} (0.0.0.0:${port})`);
    console.log(`[web] OAuth redirect_uri: ${redirectUri()} — добавь его в Discord Developer Portal → OAuth2 → Redirects`);
  });
  server.on('error', (err) => console.error('[web] Ошибка сервера:', err.message));
  return server;
}

// Сбросить кэш прав/грантов для участника — зовётся ботом при смене ранга,
// разморозке, выдаче грантов и т.п., чтобы права на сайте обновились сразу.
function invalidateAccess(discordId) {
  const id = String(discordId || '');
  if (!id) return;
  accessCache.delete(id);
  _grantsCache.delete(id);
  _frozenCache.delete(id);
}
module.exports = { start, createMagicLink, invalidateAccess, seedBoards };
