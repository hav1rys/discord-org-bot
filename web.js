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
const { notify: pushNotify, unreadCount } = require('./notify');

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
.avatar{border-radius:50%;object-fit:cover;border:1px solid var(--line);background:var(--panel2);flex:0 0 auto}
.phead{display:flex;gap:16px;align-items:center;margin-bottom:6px}
.phead h1{margin:0}
.actions{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.actions .form{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px}
.actions h3{font-size:14px;margin-bottom:2px}
.tglbtn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:14px}
.themebox{position:relative;display:inline-block}
.themepop{position:absolute;right:0;top:calc(100% + 8px);z-index:100;width:250px;max-height:72vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 12px 34px rgba(0,0,0,.4)}
.themepop[hidden]{display:none}
.themepop .seg{display:flex;gap:4px;margin-bottom:10px}
.themepop .seg button{flex:1;padding:6px 4px;font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);cursor:pointer}
.themepop .seg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.themepop .crow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0;font-size:12px;color:var(--text)}
.themepop .crow input[type=color]{width:42px;height:26px;padding:1px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);cursor:pointer;flex:0 0 auto}
.themepop .acts{display:flex;gap:6px;margin-top:12px}
.themepop .acts button{flex:1;padding:7px;font-size:12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer}
.themepop .acts button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
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
  return `<div class="themebox">
    <button class="tglbtn" type="button" onclick="fcThemeMenu(event)" title="Оформление сайта">🎨</button>
    <div class="themepop" id="themepop" hidden>
      <div class="seg" id="fcModeSeg">
        <button type="button" data-m="auto" onclick="fcSetMode('auto')">Авто</button>
        <button type="button" data-m="light" onclick="fcSetMode('light')">Светлая</button>
        <button type="button" data-m="dark" onclick="fcSetMode('dark')">Тёмная</button>
      </div>
      <div class="mini" style="margin-bottom:4px">Свои цвета — только в этом браузере</div>
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
  window.fcThemeMenu=function(ev){ if(ev)ev.stopPropagation(); var p=pop(); if(!p)return;
    if(p.hasAttribute('hidden')){ p.removeAttribute('hidden'); syncSeg(); fillInputs();
      p.style.right=''; p.style.left='';
      var r=p.getBoundingClientRect();
      if(r.left<6){ p.style.right='auto'; p.style.left='0'; }
    } else { p.setAttribute('hidden',''); } };
  window.fcSetMode=function(m){ mode=m; apply(m); try{localStorage.setItem('fc_theme',m);}catch(e){} syncSeg(); };
  window.fcColorsApply=function(){ var o={}, ins=document.querySelectorAll('#themepop input[data-k]');
    for(var i=0;i<ins.length;i++) o[ins[i].getAttribute('data-k')]=ins[i].value;
    try{localStorage.setItem('fc_colors',JSON.stringify(o));}catch(e){} applyColors(o); };
  window.fcColorsReset=function(){ try{localStorage.removeItem('fc_colors');}catch(e){} location.reload(); };
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
    // «текст(https://…)» без квадратных скобок — как в Discord: сам URL в ссылку
    .replace(/(\()((?:https?:\/\/|www\.)[^\s)]+)(\))/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>$3')
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
  return `<div class="md">${out.join('\n').replace(/%%CODEBLK(\d+)%%/g, (mm, i) => blocks[+i] || '')}</div>`;
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
    return items;
  }
  const nav = ['<a href="/me">Мой профиль</a>'];
  if (LEVELS[level] < LEVELS.member) nav.push('<a href="/apply">Подать заявку</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/people">Участники</a>');
  nav.push('<a href="/giveaways">Розыгрыши</a>');
  nav.push('<a href="/faq">FAQ</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/commands">Команды</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/dashboard">Дашборд</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/tickets">Тикеты</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel?tab=apps">Заявки</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel?tab=contracts_check">Контракты</a>');
  if (LEVELS[level] >= LEVELS.hr || panelGrant) nav.push('<a href="/panel">Панель</a>');
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
    return `<div class="top"><div class="left nav">${themeToggle()}${gnav}<a class="btn sm" href="/login">Войти через Discord</a></div><div class="right">${brand}</div></div>`;
  }
  const bell = `<a href="/notifications" class="tglbtn" style="text-decoration:none" title="Уведомления">🔔${notif ? `<b style="color:var(--bad)"> ${notif}</b>` : ''}</a>`;
  return `<div class="top">
    <div class="left nav">${navItems(level, panelGrant).join('')}</div>
    <div class="right">${bell}${themeToggle()}${brand}</div>
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
  const customCss = SITE.css ? `<style>${String(SITE.css).replace(/<\//g, '<\\/').slice(0, 20000)}</style>` : '';
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
</div></body></html>`;
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
  </div>`}`;
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

async function panelGrants(client, user) {
  const rows = await db.all("SELECT discord_id, COALESCE(subject_type,'user') st, tab, granted_by, granted_at FROM panel_grants ORDER BY st, discord_id").catch(() => []);
  const bySubject = new Map(); // key: st|id
  for (const r of rows) {
    const k = r.st + '|' + r.discord_id;
    if (!bySubject.has(k)) bySubject.set(k, { st: r.st, id: r.discord_id, tabs: [], by: r.granted_by, at: r.granted_at });
    bySubject.get(k).tabs.push(r.tab);
  }
  const label = (t) => (PANEL_TABS.find(([i]) => i === t) || [t, t])[1];
  const tabsList = PANEL_TABS.filter(([id]) => GRANTABLE_TABS.has(id));
  const g = guildOf(client);
  const roleOpts = g
    ? g.roles.cache.filter((r) => r.name !== '@everyone').sort((a, b) => b.position - a.position)
      .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')
    : '';
  const subjName = (st, id) => st === 'role'
    ? `<span class="mention role">@${esc((g && g.roles.cache.get(id) && g.roles.cache.get(id).name) || ('роль ' + id))}</span>`
    : `${personLink(client, id)} <span class="mini">${esc(id)}</span>`;
  const cur = [...bySubject.values()].map((info) => `<tr>
    <td>${subjName(info.st, info.id)}</td>
    <td>${info.tabs.map((t) => `<span class="pill">${esc(label(t))}</span>`).join(' ')}</td>
    <td class="mini">${info.by ? personLink(client, info.by) : '—'} · ${fmt(info.at)}</td>
    <td style="white-space:nowrap">
      <button class="btn ghost sm" type="button" onclick='fcGrantEdit(${JSON.stringify(info.st)}, ${JSON.stringify(info.id)}, ${JSON.stringify(info.tabs)})'>изменить</button>
      <form method="POST" action="/admin/grants/save" style="display:inline">${csrfField(user)}<input type="hidden" name="subject_type" value="${esc(info.st)}"><input type="hidden" name="subject_id" value="${esc(info.id)}"><button class="btn ghost sm" style="background:var(--bad)" type="submit" onclick="return confirm('Убрать все доступы у этого субъекта?')">убрать все</button></form>
    </td>
  </tr>`).join('');
  return `
  <div class="card"><h2>Выдать доступ к разделам панели</h2>
    <p class="mini">Доступ можно выдать <b>участнику</b> (по Discord ID) или <b>всем с ролью</b>. Инфраструктурные разделы (База данных, Админ, Права команд, Главная, Страницы) выдать нельзя.</p>
    <form method="POST" action="/admin/grants/save" class="form" id="grantForm">${csrfField(user)}
      <label>Кому<select name="subject_type" id="grantType" onchange="fcGrantType()">
        <option value="user">Конкретному участнику</option>
        <option value="role">Всем с ролью</option>
      </select></label>
      <label id="grantUserRow">Discord ID участника<input name="subject_user" id="grantUser" pattern="[0-9]{5,25}" maxlength="25"></label>
      <label id="grantRoleRow" style="display:none">Роль<select name="subject_role" id="grantRole">${roleOpts || '<option value="">(бот офлайн — ролей нет)</option>'}</select></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px;margin:8px 0">
        ${tabsList.map(([id, lbl]) => `<label class="chk"><input type="checkbox" name="tab" value="${id}"><span>${esc(lbl)}</span></label>`).join('')}
      </div>
      <div class="bar">
        <button class="btn sm" type="submit">Сохранить доступы</button>
        <button class="btn ghost sm" type="button" onclick="document.querySelectorAll('#grantForm input[name=tab]').forEach(function(c){c.checked=true})">отметить все</button>
        <button class="btn ghost sm" type="button" onclick="document.querySelectorAll('#grantForm input[name=tab]').forEach(function(c){c.checked=false})">снять все</button>
      </div>
    </form>
    <script>
    function fcGrantType(){var t=document.getElementById('grantType').value;
      document.getElementById('grantUserRow').style.display=t==='user'?'':'none';
      document.getElementById('grantRoleRow').style.display=t==='role'?'':'none';}
    function fcGrantEdit(st,id,tabs){var f=document.getElementById('grantForm');
      document.getElementById('grantType').value=st; fcGrantType();
      if(st==='role')f.subject_role.value=id; else f.subject_user.value=id;
      var s=new Set(tabs); f.querySelectorAll('input[name=tab]').forEach(function(c){c.checked=s.has(c.value)});
      f.scrollIntoView({behavior:'smooth'});}
    fcGrantType();
    </script>
  </div>
  <div class="card"><h2>Кому сейчас выдан доступ (${bySubject.size})</h2>
    <div class="tablewrap"><table><tr><th>Субъект</th><th>Разделы</th><th>Кем выдано</th><th></th></tr>
      ${cur || '<tr><td colspan="4">пока никому</td></tr>'}
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
          <td><form method="POST" action="/admin/page/revert" style="display:inline">${csrfField(user)}<input type="hidden" name="vid" value="${v.id}"><button class="btn ghost sm" type="submit" onclick="return confirm('Откатить страницу к этой версии? Текущая уйдёт в историю.')">откатить</button></form></td></tr>`).join('')}
      </table></div></details>` : '';
    list.push(`<div class="card">
    <form method="POST" action="/admin/page/save" class="form">${csrfField(user)}<input type="hidden" name="orig" value="${esc(p.slug)}">
      <label>Адрес (slug) — открывается по /p/slug<input name="slug" value="${esc(p.slug)}" pattern="[a-z0-9-]{1,40}" required></label>
      <label>Заголовок<input name="title" value="${esc(p.title || '')}" maxlength="120"></label>
      <label>Содержимое (форматирование как в Discord)<textarea name="content" data-md rows="8" maxlength="20000">${esc(p.content || '')}</textarea></label>
      <label class="chk"><input type="checkbox" name="nav" value="1" ${p.nav ? 'checked' : ''}><span>Показывать пункт в меню шапки</span></label>
      <label class="chk"><input type="checkbox" name="published" value="1" ${(p.published == null || p.published) ? 'checked' : ''}><span>Опубликована (снять — черновик, видит только havirys)</span></label>
      <div class="bar">
        ${!p.published && p.published != null ? '<span class="badge warn">черновик</span>' : ''}
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
  const won = rows.filter((g) => (g.winners || '').split(',').includes(did)).length;
  const list = rows.map((g) => {
    const iWon = (g.winners || '').split(',').includes(did);
    const st = g.status === 'active' ? `идёт, до ${fmt(g.ends_at)}` : (iWon ? '🏆 победа' : 'участвовал');
    return `<tr><td><a href="/g/${g.id}">${esc(g.prize)}</a></td><td>${st}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Мои розыгрыши (${rows.length}${won ? `, побед: ${won}` : ''})</h2>
    <div class="tablewrap"><table><tr><th>Приз</th><th>Статус</th></tr>${list}</table></div></div>`;
}

async function meBody(client, user) {
  const did = user.id;
  const acc = await accessFor(client, did);
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [did]);
  const av = await resolveAvatar(client, did, 128);
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
  </div>`;

  const logoutBtn = '<a class="btn sm" href="/logout" style="background:var(--bad)">Выйти из аккаунта</a>';

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
        <button class="btn sm" type="submit">Сохранить</button>
      </form>
    </div>
    ${ticketCard}
    ${inviteCard}
    ${await myGiveawaysCard(did)}
    ${loginsCard}
    ${memberForms(user, passports, canAppeal)}`;
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
// Разделы, выданные участнику лично + всем его ролям.
async function getPanelGrants(client, discordId) {
  if (!discordId) return new Set();
  const hit = _grantsCache.get(discordId);
  if (hit && Date.now() - hit.at < 30000) return hit.set;
  const set = new Set();
  try {
    const uRows = await db.all("SELECT tab FROM panel_grants WHERE discord_id = ? AND COALESCE(subject_type,'user') = 'user'", [String(discordId)]);
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
      const rRows = await db.all(`SELECT tab FROM panel_grants WHERE subject_type = 'role' AND discord_id IN (${ph})`, roleIds);
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
    role_check: acc.rank >= LEVELS.deputy, hr_payouts: acc.rank >= LEVELS.owner,
    landing: isHavirys, pages: isHavirys, grants: isHavirys,
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
  else if (tab === 'contracts_check') body = await panelContractCheck(client, user, pageNum);
  else if (tab === 'role_check') body = await panelRoleCheck(client, user);
  else if (tab === 'members') body = await panelMembers(client, pageNum, user);
  else if (tab === 'contracts') body = await panelContracts(client);
  else if (tab === 'invites') body = await panelInvites(client);
  else if (tab === 'hr_payouts') body = await panelHrPayouts(client);
  else if (tab === 'giveaways') body = await panelGiveaways(client, acc, user);
  else if (tab === 'blacklist') body = await panelBlacklist(client, user);
  else if (tab === 'texts') body = await panelTexts(user);
  else if (tab === 'faq_manage') body = (await panelFaqManage(user)) + (await faqFeedbackReport());
  else if (tab === 'reasons') body = await panelReasons(user);
  else if (tab === 'broadcast') body = await panelBroadcast(user);
  else if (tab === 'settings') body = await panelSettings(user);
  else if (tab === 'perms') body = await panelPerms(user);
  else if (tab === 'admin') body = await panelAdmin(client, user);
  else if (tab === 'landing') body = await panelLanding(user);
  else if (tab === 'pages') body = await panelPages(client, user);
  else if (tab === 'grants') body = await panelGrants(client, user);
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
const TICKET_CAT_RU = { question: 'Вопрос', complaint: 'Жалоба', other: 'Другое', appeal: 'Апелляция ЧС' };

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
  let info = [];
  try { info = await db.all(`PRAGMA table_info(${table})`); } catch (_) {}
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
    ${canEdit ? `<p class="muted" style="margin-bottom:10px">Режим редактирования (havirys): ✏️ — изменить строку. ${addBtn} <a class="btn ghost sm" href="/export/table/${esc(table)}.csv">⬇ Скачать всю таблицу CSV</a></p>` : ''}
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

function guildOf(client) {
  return client && process.env.GUILD_ID ? client.guilds.cache.get(process.env.GUILD_ID) : null;
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
  if (ok) return `<div class="card" style="border-color:#1f5c43;color:var(--ok)">✅ ${esc(ok)}</div>`;
  if (err) return `<div class="card" style="border-color:#5c2626;color:var(--bad)">⛔ ${esc(err)}</div>`;
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

function memberForms(user, passports = [], blacklisted = false) {
  const passOpts = passports.map((pp) => `<option value="${esc(pp.static)}">${esc(pp.name)} — № ${esc(pp.static)}</option>`).join('');
  return `
  <div class="card"><h2>Сдать контракт</h2>
    ${passports.length ? `
    <p class="mini">Нужны два скриншота: «взял контракт» и «итог». Каждый — файл с устройства <b>или</b> ссылка.</p>
    <form method="POST" action="/me/contract" class="form" onsubmit="return fcCtrSubmit(this)">
      ${csrfField(user)}
      <label>Паспорт<select name="static" required>${passports.map((pp) => `<option value="${esc(pp.static)}">${esc(pp.name)} — № ${esc(pp.static)}</option>`).join('')}</select></label>
      <label>Скрин «Взял контракт» — файл<input type="file" accept="image/*" data-for="taken_data"></label>
      <label>…или ссылка<input name="taken_url" maxlength="400" placeholder="https://..."></label>
      <input type="hidden" name="taken_data">
      <label>Скрин «Итог» — файл<input type="file" accept="image/*" data-for="result_data"></label>
      <label>…или ссылка<input name="result_url" maxlength="400" placeholder="https://..."></label>
      <input type="hidden" name="result_data">
      <button class="btn" type="submit">Отправить на проверку</button>
    </form>
    <script>
    function fcCtrSubmit(f){
      var slots=[['taken_data','taken_url'],['result_data','result_url']];
      var files=f.querySelectorAll('input[type=file][data-for]'), pending=0;
      function finish(){
        for(var i=0;i<slots.length;i++){
          var d=f[slots[i][0]].value, u=(f[slots[i][1]].value||'').trim();
          if(!d && !/^https?:\\/\\//i.test(u)){ alert('Приложите оба скриншота: файл или ссылку (http).'); return; }
        }
        f.submit();
      }
      files.forEach(function(inp){
        var file=inp.files[0]; if(!file){return;}
        pending++;
        var img=new Image(), url=URL.createObjectURL(file);
        img.onload=function(){
          var s=Math.min(1,1280/Math.max(img.width,img.height));
          var c=document.createElement('canvas'); c.width=Math.round(img.width*s)||1; c.height=Math.round(img.height*s)||1;
          c.getContext('2d').drawImage(img,0,0,c.width,c.height);
          try{ f[inp.dataset.for].value=c.toDataURL('image/jpeg',0.72); }catch(e){}
          URL.revokeObjectURL(url); if(--pending===0)finish();
        };
        img.onerror=function(){ URL.revokeObjectURL(url); if(--pending===0)finish(); };
        img.src=url;
      });
      if(pending===0)finish();
      return false;
    }
    </script>`
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
        </select>
      </label>
      <label>Тема<input name="subject" required maxlength="100"></label>
      <label>Описание<textarea name="description" rows="3" maxlength="1000"></textarea></label>
      <button class="btn" type="submit">Создать тикет в Discord</button>
    </form>
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
  const info = await db.all(`PRAGMA table_info(${table})`);
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
  const info = await db.all(`PRAGMA table_info(${table})`);
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
  const list = rows.map((p) => `<tr>
    ${bulk ? `<td><input type="checkbox" name="ids" value="${esc(p.discord_id)}"></td>` : ''}
    <td>${onlineDot(client, p.discord_id)}<a href="/u/${esc(p.discord_id)}">${esc(p.name)}</a></td>
    <td>№ ${esc(p.static)}</td>
    <td>${esc(roleName(client, p.role_id))}</td>
    <td class="muted">${fmt(p.joined_at)}</td>
  </tr>`).join('');
  const head = `${bulk ? '<th></th>' : ''}<th>Имя Фамилия</th><th>Паспорт</th><th>Ранг</th><th>Вступил</th>`;
  const tableBlock = `<div class="tablewrap"><table><tr>${head}</tr>${list || `<tr><td colspan="${bulk ? 5 : 4}">—</td></tr>`}</table></div>`;
  const inner = bulk
    ? `<form method="POST" action="/people/bulk">${csrfField(user)}
        ${tableBlock}
        <div class="bar" style="margin-top:12px">
          <select name="act">
            <option value="vacation">Выдать отпуск выбранным</option>
            <option value="dm">Отправить ЛС выбранным</option>
            <option value="rank_recalc">Пересчитать ранги (всем)</option>
          </select>
          <input name="deadline" placeholder="отпуск до (7d)" style="max-width:150px">
          <input name="text" placeholder="текст ЛС" style="max-width:220px">
          <button class="btn sm" type="submit">Применить к выбранным</button>
        </div>
      </form>`
    : tableBlock;
  return `
  <h1>Участники</h1>
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
  const av = await resolveAvatar(client, targetId, 128);
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
  const contractHist = await db.all("SELECT status, submitted_at, reviewed_at, message_url FROM contracts WHERE discord_id = ? ORDER BY COALESCE(submitted_at, reviewed_at) DESC LIMIT 40", [targetId]).catch(() => []);
  const thanksRows = await db.all('SELECT from_id, note, created_at FROM thanks WHERE to_id = ? ORDER BY id DESC LIMIT 30', [targetId]).catch(() => []);
  const thanksCnt = thanksRows.length;
  const badgeAwards = await db.all('SELECT badge_key, awarded_at FROM badge_awards WHERE discord_id = ? ORDER BY awarded_at DESC LIMIT 20', [targetId]).catch(() => []);
  // 12 недель контрактов для спарклайна
  const sparkWeeks = [];
  for (let w = 11; w >= 0; w--) {
    const r = contracts.getWeekRange(w);
    const c = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status='fulfilled' AND submitted_at BETWEEN ? AND ?", [targetId, r.start.toISOString(), r.end.toISOString()]).catch(() => null);
    sparkWeeks.push(c ? c.c : 0);
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
    <td>${c.message_url ? `<a href="${esc(c.message_url)}" target="_blank" rel="noopener">открыть</a>` : '—'}</td>
  </tr>`).join('');
  const selfOrHr = (viewer && viewer.id === targetId) || canHr;
  const aboutHidden = p.about_private && !selfOrHr;
  const contractsHidden = p.contracts_private && !selfOrHr;
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
  for (const b of badgeAwards) feed.push({ at: b.awarded_at, txt: `🏅 бейдж «${esc((badges.LABELS && badges.LABELS[b.badge_key]) || b.badge_key)}»` });
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
  ${badgesCard(bs, p.pinned_badges)}
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
async function dashboardBody(client, periodDays) {
  const c = (sql, p = []) => db.get(sql, p).then((r) => (r ? r.c : 0));
  const days = [7, 30, 90].includes(+periodDays) ? +periodDays : 30;
  const since30 = new Date(Date.now() - days * 864e5).toISOString();
  const periodBar = `<div class="bar"><span class="mini">Период:</span>${[7, 30, 90].map((d) => `<a class="btn ${d === days ? '' : 'ghost '}sm" href="/dashboard?days=${d}">${d} дн.</a>`).join('')}</div>`;

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

  // по неделям: контракты за 6 недель
  const weeks = [];
  for (let w = 5; w >= 0; w--) {
    const r = contracts.getWeekRange(w);
    const f = await c("SELECT COUNT(*) c FROM contracts WHERE status='fulfilled' AND submitted_at BETWEEN ? AND ?", [r.start.toISOString(), r.end.toISOString()]);
    weeks.push({ label: contracts.formatWeekLabel(r).replace(/\s*—.*/, ''), value: f });
  }

  const onVac = await c('SELECT COUNT(*) c FROM participants WHERE vacation_until IS NOT NULL') + await c('SELECT COUNT(DISTINCT discord_id) c FROM extra_passports WHERE vacation_until IS NOT NULL');
  const onAfk = await c('SELECT COUNT(*) c FROM participants WHERE afk_since IS NOT NULL');
  const tile = (n, l) => `<div class="tile"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;

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
  <div class="card"><h2>Выполненные контракты по неделям</h2>${barChart(weeks)}</div>
  <div class="card"><h2>Эта неделя vs прошлая</h2><div class="grid">
    ${tile(`${cw.contracts}${delta(cw.contracts, lw.contracts)}`, `контракты (было ${lw.contracts})`)}
    ${tile(`${cw.apps}${delta(cw.apps, lw.apps)}`, `заявки (было ${lw.apps})`)}
    ${tile(`${cw.invites}${delta(cw.invites, lw.invites)}`, `приглашения (было ${lw.invites})`)}
  </div></div>
  <div class="card"><h2>Статусы сейчас</h2>
    <div class="grid">${tile(onVac, 'в отпуске')}${tile(onAfk, 'AFK')}</div>
  </div>
  ${retCard}
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

async function compareBody(client, meId, otherId) {
  const range = contracts.getWeekRange(0);
  const gather = async (id) => {
    const p = await db.get('SELECT name, joined_at FROM participants WHERE discord_id = ?', [id]).catch(() => null);
    const bs = await computeBadgesAndStreak(client, id);
    const week = await contracts.getUserWeekStats(id, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
    return {
      id, name: (p && p.name) || nickOf(client, id) || ('ID ' + String(id).slice(-6)),
      inOrg: !!p,
      fulfilled: bs.fulfilled || 0, week: week.fulfilled.length,
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
      ${row('Приглашений подтверждено', me.invites, ot.invites)}
      ${row('Недельный стрик', me.streak, ot.streak)}
      ${row('Дней в организации', me.days, ot.days)}
      ${row('Побед в розыгрышах', me.wins, ot.wins)}
      ${row('Бейджей открыто', me.badges, ot.badges)}
    </table></div>
    <p class="mini"><a href="/u/${esc(ot.id)}">профиль ${esc(ot.name)}</a></p>
  </div>`;
}

async function calendarBody(client) {
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
  const sec = (title, rowsHtml, colsN) => `<div class="card"><h2>${esc(title)}</h2><div class="tablewrap"><table>${rowsHtml || `<tr><td colspan="${colsN}">—</td></tr>`}</table></div></div>`;
  return `
  <h1>Поиск: «${esc(q)}»</h1>
  <div class="card"><form method="GET" action="/search" class="form"><label>Запрос<input name="q" value="${esc(q)}" maxlength="80"></label><button class="btn" type="submit">Искать</button></form></div>
  ${sec('Участники (' + P.length + ')', '<tr><th>Имя</th><th>Паспорт</th></tr>' + P.map((r) => `<tr><td><a href="/u/${esc(r.discord_id)}">${esc(r.name)}</a></td><td>№ ${esc(r.static)}</td></tr>`).join(''), 2)}
  ${sec('Заявки (' + A.length + ')', '<tr><th>#</th><th>Имя</th><th>Паспорт</th><th>Статус</th></tr>' + A.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.name || r.discord_tag)}</td><td>${esc(r.static || '—')}</td><td>${esc(ruStatus(r.status))}</td></tr>`).join(''), 4)}
  ${sec('Контракты (' + CN.length + ')', '<tr><th>#</th><th>Участник</th><th>Итог</th><th>Когда</th><th>Пруф</th></tr>' + CN.map((r) => `<tr><td>#${r.id}</td><td>${personLink(client, r.discord_id)}</td><td>${esc(ruStatus(r.status))}</td><td class="muted">${fmt(r.submitted_at)}</td><td>${r.message_url ? `<a href="${esc(r.message_url)}" target="_blank" rel="noopener">ссылка</a>` : '—'}</td></tr>`).join(''), 5)}
  ${sec('Благодарности (' + TH.length + ')', '<tr><th>От</th><th>Кому</th><th>За что</th><th>Когда</th></tr>' + TH.map((r) => `<tr><td>${personLink(client, r.from_id)}</td><td>${personLink(client, r.to_id)}</td><td>${esc(r.note || '—')}</td><td class="muted">${fmt(r.created_at)}</td></tr>`).join(''), 4)}
  ${sec('Аудит (' + AU.length + ')', '<tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Детали</th></tr>' + AU.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${esc(r.actor_tag || '—')}</td><td>${esc(r.action || '')}</td><td class="mini">${renderMentions(client, esc((r.details || '').slice(0, 160)))}</td></tr>`).join(''), 4)}
  ${sec('Чёрный список (' + B.length + ')', '<tr><th>#</th><th>Discord ID</th><th>Паспорт</th><th>Причина</th></tr>' + B.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.discord_id || '—')}</td><td>${esc(r.static || '—')}</td><td>${esc(r.reason || '—')}</td></tr>`).join(''), 4)}
  ${sec('Тикеты (' + T.length + ')', '<tr><th>#</th><th>Тема</th><th>Тип</th><th>Статус</th></tr>' + T.map((r) => `<tr><td><a href="/ticket/${r.id}">#${r.id}</a></td><td>${esc(r.subject || '—')}</td><td>${esc(TICKET_CAT_RU[r.category] || r.category || '—')}</td><td>${esc(ruStatus(r.status))}</td></tr>`).join(''), 4)}`;
}

async function auditBody(client, sp, pageNum, user) {
  const who = (sp.get('who') || '').trim();
  const act = (sp.get('act') || '').trim();
  const showSys = sp.get('sys') === '1';
  const days = parseInt(sp.get('days') || '14', 10) || 14;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const cond = ['at >= ?'];
  const par = [since];
  if (who) { cond.push('(actor_id = ? OR actor_tag LIKE ?)'); par.push(who, `%${who}%`); }
  if (act) { cond.push('action LIKE ?'); par.push(`%${act}%`); }
  if (!showSys && !act) { cond.push("action NOT LIKE ?"); par.push(META_PREFIX + '%'); }
  const where = 'WHERE ' + cond.join(' AND ');
  const totalRow = await db.get(`SELECT COUNT(*) c FROM audit_log ${where}`, par);
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...par, PAGE_SIZE, pageNum * PAGE_SIZE]);
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
    <div class="tablewrap"><table><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Детали</th></tr>${trs || '<tr><td colspan="4">—</td></tr>'}</table></div>
    ${pager('/audit?' + qkeep, pageNum, total)}
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
    <b>Заявка #${a.id}</b> — ${personLink(client, a.discord_id)} (${esc(a.discord_tag || '')})
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
  return `<div class="card"><h2>Заявки на вступление — всего ${total}</h2><p class="mini">Приём с сайта выполняет полный онбординг: роли, ник, профиль-канал, ЛС с правилами.</p>${pager('/panel?tab=apps', pageNum, total)}</div>${cards.join('') || '<div class="card">Очередь пуста.</div>'}${pager('/panel?tab=apps', pageNum, total)}`;
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
  return `<div class="card"><h2>Переключатели</h2>${flags.join('')}</div>
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
};
const PRESET_LABELS = { default: 'стандарт', amoled: 'AMOLED', ocean: 'океан', forest: 'лес', plum: 'слива' };
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
    <div class="bar" style="margin-top:8px"><span class="mini">Пресеты:</span>
      ${Object.keys(THEME_PRESETS).map((pn) => {
        const on = curPreset === pn;
        return `<form method="POST" action="/admin/theme_preset" style="display:inline">${csrfField(user)}<input type="hidden" name="preset" value="${pn}"><button class="btn ${on ? '' : 'ghost '}sm" type="submit"${on ? ' style="outline:2px solid var(--accent2);outline-offset:1px"' : ''}>${on ? '✓ ' : ''}${esc(PRESET_LABELS[pn])}</button></form>`;
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
    <p class="mini">Один пункт в строке: <code>Текст | /path | tier</code>. tier: <code>all</code> (все), <code>member</code> (участники), <code>hr</code> (HR+). Ниже уже стандартное меню — правьте под себя. Полностью очистите поле, чтобы вернуть стандартное.</p>
    <form method="POST" action="/admin/nav" class="form">${csrfField(user)}
      <textarea name="nav" rows="12" maxlength="2000">${esc((SITE.nav && SITE.nav.trim()) ? SITE.nav : DEFAULT_NAV_TEXT)}</textarea>
      <button class="btn sm" type="submit">Сохранить меню</button>
    </form>
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
  </div></div>
  <div class="card"><h2>Незакрытые очереди</h2><div class="grid">
    ${Object.entries(queues).map(([k, v]) => tile(v, k)).join('')}
  </div></div>
  <div class="card"><h2>Строк в таблицах</h2><div class="grid">
    ${await (async () => {
      const tbls = ['participants', 'extra_passports', 'applications', 'kicks', 'vacations', 'contracts', 'invitations', 'blacklist', 'giveaways', 'tickets', 'audit_log', 'web_users', 'notifications'];
      const out = [];
      for (const t of tbls) { try { const r = await db.get(`SELECT COUNT(*) c FROM ${t}`); out.push(tile(r ? r.c : 0, t)); } catch (_) {} }
      return out.join('');
    })()}
  </div></div>`;
}

// ---------- FAQ + реакции ----------
async function faqBody(client, acc, user) {
  const cats = acc.rank >= LEVELS.hr ? ['member', 'hr'] : ['member'];
  const catTitle = { member: 'Для участников', hr: 'Для HR' };
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
    <div class="card"><input id="faqf" placeholder="🔍 поиск по гайдам…" style="width:100%" oninput="(function(q){q=q.value.toLowerCase().trim();document.querySelectorAll('.faq-item').forEach(function(el){el.style.display=(!q||el.dataset.faq.indexOf(q)>=0)?'':'none'});})(this)"></div>
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
      <div class="mini">Победителей: ${gv.winners_count} · Участников: ${cnt}${gv.required_role_id ? ` · роль ${roleTag(client, gv.required_role_id)}` : ''}${gv.min_role_id ? ` · ранг не ниже ${roleTag(client, gv.min_role_id)}` : ''}</div>
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
  const tplSelect = tpls.length ? `<label>Шаблон ответа
    <select onchange="if(this.value){var ta=this.form.text;ta.value=(ta.value?ta.value+'\\n':'')+this.value;this.selectedIndex=0}">
      <option value="">— вставить шаблон —</option>
      ${tpls.map((tp) => `<option value="${esc(tp.text)}">${esc(tp.name)}</option>`).join('')}
    </select></label>` : '';
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
  ${tplManage}
  <p><a href="/me">← в кабинет</a></p>`;
}

// ---------- Контракты на проверке (HR+) ----------
async function panelContractCheck(client, user, pageNum = 0) {
  const totalRow = await db.get("SELECT COUNT(*) c FROM contracts WHERE status = 'pending'").catch(() => null);
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all("SELECT * FROM contracts WHERE status = 'pending' ORDER BY submitted_at ASC LIMIT ? OFFSET ?", [PAGE_SIZE, pageNum * PAGE_SIZE]).catch(() => []);
  const cards = [];
  for (const cn of rows) {
    const pr = await db.get('SELECT name, static FROM participants WHERE discord_id = ?', [cn.discord_id]).catch(() => null);
    const links = [
      cn.taken_message_url ? `<a href="${esc(cn.taken_message_url)}" target="_blank" rel="noopener">скрин «взял»</a>` : '',
      cn.message_url ? `<a href="${esc(cn.message_url)}" target="_blank" rel="noopener">скрин «итог»</a>` : '',
    ].filter(Boolean).join(' · ') || '<span class="mini">ссылок нет</span>';
    cards.push(`<div class="card">
      <b>#${cn.id}</b> — <a href="/u/${esc(cn.discord_id)}">${esc(pr ? pr.name : cn.discord_id)}</a>${pr ? ` (№ ${esc(pr.static)})` : ''}
      <div class="mini">отправлен ${fmt(cn.submitted_at)} · ${links}</div>
      <div class="bar" style="margin-top:8px">
        ${['fulfilled', 'unfulfilled', 'rejected'].map((vd) => `<form method="POST" action="/panel/contract/review" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${cn.id}"><input type="hidden" name="verdict" value="${vd}"><button class="btn sm" ${vd === 'rejected' ? 'style="background:var(--bad)"' : ''} type="submit">${vd === 'fulfilled' ? '✅ Выполнен' : vd === 'unfulfilled' ? '❌ Не выполнен' : '🗑 Отклонить'}</button></form>`).join('')}
      </div>
    </div>`);
  }
  return `<div class="card"><h2>Контракты на проверке — всего ${total}</h2><p class="mini">То же, что кнопки под карточкой контракта в Discord.</p>${pager('/panel?tab=contracts_check', pageNum, total)}</div>${cards.join('') || '<div class="card">Очередь пуста.</div>'}${pager('/panel?tab=contracts_check', pageNum, total)}`;
}

// ---------- Управление гайдами FAQ (Владелец) ----------
async function panelFaqManage(user) {
  const cats = [['member', 'Для участников'], ['hr', 'Для HR']];
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
      <div class="mini">${fmt(n.created_at)}${n.link ? ` · <a href="${esc(n.link)}">открыть</a>` : ''}${snoozed ? ` · <span class="badge warn">отложено до ${fmt(n.snooze_until)}</span>` : ''}</div>
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
async function profileCardBody(client, targetId) {
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [targetId]).catch(() => null);
  if (!p) return '<div class="card">Участник не найден.</div>';
  const av = await resolveAvatar(client, targetId, 256);
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
    .pcard{width:420px;max-width:100%;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:var(--panel);box-shadow:0 14px 40px rgba(0,0,0,.3)}
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
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><style>'+css+'</style><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="background:'+bg+'">'+html+'</div></foreignObject></svg>';
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
  const grouped = commandsAllowed(acc.rank, user && user.id === OWNER_ID);
  const order = ['everyone', 'hr', 'deputy', 'owner', 'admin', 'owner_account_only'];
  const seen = new Set();
  const secs = [];
  for (const t of [...order, ...Object.keys(grouped)]) {
    if (seen.has(t) || !grouped[t]) continue;
    seen.add(t);
    const cmds = grouped[t].map((c) => `<span class="pill" style="${c.ok ? '' : 'opacity:.4'}">/${esc(c.name)}${c.ok ? '' : ' 🔒'}</span>`).join(' ');
    secs.push(`<div class="card"><h2>${esc(labels[t] || t)}</h2>${cmds}</div>`);
  }
  return `<h1>Команды бота</h1><p class="mini">Доступные вам — ярко, недоступные — бледно с 🔒.</p>${secs.join('')}`;
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

// ---------- Обработка POST ----------
async function handlePost(client, pathName, user, body, acc, cookieHeader) {
  if (!user) return '/login';
  if (!csrfOk(user, body.get('_csrf'))) return '/me?' + qs({ err: 'Сессия формы устарела — откройте форму заново.' });
  const g = guildOf(client);
  const uname = user.username || user.id;

  // ===== заявка на вступление =====
  if (pathName === '/apply') {
    if ((body.get('website') || '').trim()) return '/me?' + qs({ ok: 'Заявка отправлена на рассмотрение.' }); // honeypot — тихо игнорируем
    if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id])) return '/me?' + qs({ err: 'Вы уже участник организации.' });
    if (await db.get('SELECT id FROM blacklist WHERE discord_id = ?', [user.id])) return '/apply?' + qs({ err: 'Вы в чёрном списке организации.' });
    const name = (body.get('name') || '').trim().replace(/[_\s]+/g, ' ').trim();
    const stat = (body.get('static') || '').trim();
    const lvl = parseInt(body.get('lvl'), 10) || 0;
    const skills = (body.get('skills') || '').trim();
    const refId = getCookie(cookieHeader, 'fc_ref');
    const invited = (body.get('invited_by') || '').trim() || refId || '';
    if (!name || !/^[0-9]+$/.test(stat) || lvl < 1) return '/apply?' + qs({ err: 'Проверьте поля: имя, № паспорта (только цифры), LVL.' });
    if (await db.get("SELECT id FROM applications WHERE discord_id = ? AND status='pending'", [user.id])) return '/me?' + qs({ err: 'У вас уже есть заявка на рассмотрении.' });
    const created = new Date().toISOString();
    const r = await db.run(
      `INSERT INTO applications (discord_id, discord_tag, name, static, lvl, skills, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [user.id, uname, name, stat, lvl, skills, invited, created],
    );
    const app = { id: r.lastID, discord_id: user.id, discord_tag: uname, name, static: stat, lvl, skills, invited_by: invited, status: 'pending', created_at: created };
    const sent = await postTo(client, config.CHANNEL_APPLY_REVIEW, {
      content: REVIEW_MENTION() + ' — заявка подана через сайт',
      embeds: [webApplyEmbed(app)], components: webApplyComponents(app), ...REVIEW_MENTION_OPTS,
    });
    if (sent) await db.run('UPDATE applications SET message_id = ? WHERE id = ?', [sent.id, app.id]);
    if (refId) await db.run('UPDATE invite_links SET signups = signups + 1 WHERE creator_id = ?', [refId]).catch(() => {});
    await webAudit(client, user, 'Заявка на вступление (сайт)', `#${app.id} — ${name}, № ${stat}, LVL ${lvl}${refId ? ' (по ссылке ' + refId + ')' : ''}`);
    return '/me?' + qs({ ok: 'Заявка отправлена на рассмотрение.' });
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
    await db.run('UPDATE participants SET about = ?, about_private = ?, contracts_private = ? WHERE discord_id = ?', [
      (body.get('about') || '').slice(0, 1000),
      body.get('about_private') === '1' ? 1 : 0,
      body.get('contracts_private') === '1' ? 1 : 0,
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
    return '/panel?tab=apps&' + qs({ ok: 'Комментарий добавлен.' });
  }

  // ===== сдать контракт с сайта (участник): 2 скриншота, файл или ссылка =====
  if (pathName === '/me/contract') {
    if (!(await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id]))) return '/me?' + qs({ err: 'Только для участников.' });
    const stat = (body.get('static') || '').trim();
    const pps = await passportsLib.getAllPassports(user.id).catch(() => []);
    const pp = pps.find((x) => x.static === stat);
    if (!pp) return '/me?' + qs({ err: 'Выберите паспорт из списка.' });
    const pend = await db.get("SELECT COUNT(*) c FROM contracts WHERE discord_id = ? AND status = 'pending'", [user.id]).catch(() => null);
    if (pend && pend.c >= 10) return '/me?' + qs({ err: 'У вас уже 10 контрактов на проверке — дождитесь решения.' });
    const resolveSlot = (dataField, urlField) => {
      const data = (body.get(dataField) || '').trim();
      const url = (body.get(urlField) || '').trim();
      const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(data);
      if (m) {
        let buf;
        try { buf = Buffer.from(m[2], 'base64'); } catch (_) { return { err: 'Файл не читается.' }; }
        if (buf.length > 1400 * 1024) return { err: 'Скриншот слишком большой (после сжатия).' };
        if (!buf.length) return { err: 'Пустой файл.' };
        return { buf, mime: m[1] };
      }
      if (/^https?:\/\//i.test(url)) return { url: url.slice(0, 400) };
      return {};
    };
    const taken = resolveSlot('taken_data', 'taken_url');
    const result = resolveSlot('result_data', 'result_url');
    if (taken.err || result.err) return '/me?' + qs({ err: taken.err || result.err });
    if ((!taken.buf && !taken.url) || (!result.buf && !result.url)) {
      return '/me?' + qs({ err: 'Нужны оба скриншота: «взял» и «итог» (файл или ссылка).' });
    }
    const now = new Date().toISOString();
    let cid;
    try {
      cid = await contracts.recordPendingContract(user.id, pp.profile_thread_id || null, null, null, now);
    } catch (e) { return '/me?' + qs({ err: 'Не удалось: ' + e.message }); }
    const store = async (slot, s) => {
      if (s.buf) {
        const r = await db.run(
          'INSERT INTO contract_uploads (contract_id, owner_id, slot, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [cid, user.id, slot, s.mime, s.buf, s.buf.length, now],
        );
        return '/cimg/' + r.lastID;
      }
      return s.url;
    };
    const takenUrl = await store('taken', taken);
    const resultUrl = await store('result', result);
    await db.run('UPDATE contracts SET message_url = ?, taken_message_url = ?, taken_submitted_at = ? WHERE id = ?', [resultUrl, takenUrl, now, cid]);
    await webAudit(client, user, 'Контракт отправлен на проверку (сайт)', `#${cid} № ${stat}`);
    return '/me?' + qs({ ok: 'Контракт отправлен на проверку HR.' });
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
    const CATS = { question: 'Вопрос', complaint: 'Жалоба', other: 'Другое' };
    const cat = body.get('category');
    if (!CATS[cat]) return '/me?' + qs({ err: 'Неизвестный тип тикета.' });
    if (!g) return '/me?' + qs({ err: 'Бот сейчас недоступен, попробуйте позже.' });
    const subject = ((body.get('subject') || '').trim() || 'Без темы').slice(0, 100);
    const desc = (body.get('description') || '').trim();
    if (await db.get("SELECT channel_id FROM tickets WHERE opener_id = ? AND status='open' AND (category IS NULL OR category != 'appeal')", [user.id])) {
      return '/me?' + qs({ err: 'У вас уже есть открытый тикет в Discord.' });
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
      return '/me?' + qs({ err: 'Не удалось создать канал тикета: ' + e.message });
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
    await webAudit(client, user, 'Открыт тикет (сайт)', `#${r.lastID} ${CATS[cat]}: ${subject}`);
    return '/me?' + qs({ ok: 'Тикет создан в Discord.' });
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
      const endsAt = new Date(Date.now() + durMs);
      const gid = await giveaways.createGiveaway(channelId, prize, winners, user.id, endsAt.toISOString(), roleId, null, minRoleId, prizeTiers);
      const tiersDesc = giveaways.parsePrizeTiers(prizeTiers).map((t) => `\n${t.from === t.to ? t.from : t.from + '–' + t.to} место — **${t.text}**`).join('');
      const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`🎉 ${prize}`)
        .setDescription(`Нажмите на кнопку ниже, чтобы участвовать!\nОрганизатор: <@${user.id}>${roleId ? `\nУсловие: только роль <@&${roleId}>` : ''}${minRoleId ? `\nУсловие: роль <@&${minRoleId}> и выше` : ''}${tiersDesc}`)
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
    const info = await db.all(`PRAGMA table_info(${table})`);
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
      await snapshotRow('update');
      const sets = setCols.map((ci) => `${ci.name} = ?`).join(', ');
      const vals = setCols.map((ci) => {
        const raw = body.get('f_' + ci.name);
        return raw === '' || raw == null ? null : raw;
      });
      await db.run(`UPDATE ${table} SET ${sets} WHERE rowid = ?`, [...vals, pk]);
      await webAuditMeta(client, user, 'Правка БД (сайт)', `${table} rowid=${pk}: ${setCols.map((c) => c.name).join(', ')}`);
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
  if (pathName === '/panel/app/accept' || pathName === '/panel/app/reject') {
    if (!(await panelActionAllowed(client, user, acc, 'apps'))) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    const id = parseInt(body.get('id'), 10) || 0;
    const app = await db.get('SELECT * FROM applications WHERE id = ?', [id]);
    if (!app || app.status !== 'pending') return '/panel?tab=apps&' + qs({ err: 'Заявка уже обработана.' });

    if (pathName === '/panel/app/reject') {
      const reason = (body.get('preset') || '').trim() || (body.get('reason') || '').trim() || 'Без указания причины';
      await db.run("UPDATE applications SET status='rejected', rejected_by=?, reject_reason=?, reviewed_at=? WHERE id=?", [user.id, reason, new Date().toISOString(), id]);
      await dmTo(client, app.discord_id, `❌ Ваша заявка на вступление отклонена. Причина: ${reason}`);
      await pushNotify(app.discord_id, 'apply', `Заявка на вступление отклонена. Причина: ${reason}`, '/apply').catch(() => {});
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
    await db.run("UPDATE applications SET status='accepted', accepted_by=?, reviewed_at=? WHERE id=?", [user.id, now, id]);
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
    await dmTo(client, app.discord_id, '✅ Ваша заявка на вступление принята! Добро пожаловать в организацию.');
    if (channelUrl) await dmTo(client, app.discord_id, `📸 Ваш профиль для отчётов по контрактам: ${channelUrl}`);
    try {
      const rulesText = await hook('getCurrentText')('rules', '');
      if (rulesText) await dmTo(client, app.discord_id, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📕 Свод правил организации').setDescription(String(rulesText).slice(0, 4000))] });
    } catch (_) {}
    await hook('safeUpdateMembersList')(g);
    if (app.message_id) {
      try {
        const ch = await g.channels.fetch(config.CHANNEL_APPLY_REVIEW);
        const msg = await ch.messages.fetch(app.message_id);
        await msg.edit({ components: [] });
      } catch (_) {}
    }
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
  if (pathName === '/g/enter') {
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
    if (t.opener_id && t.opener_id !== user.id) await pushNotify(t.opener_id, 'ticket', `Ответ в тикете «${t.subject || 'Тикет'}»`, `/ticket/${tid}`).catch(() => {});
    return `/ticket/${tid}?` + qs({ ok: 'Отправлено.' });
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
      await db.run('UPDATE tickets SET priority = ?, tags = ? WHERE id = ?', [pri === 'normal' ? null : pri, tags || null, tid]);
      await webAudit(client, user, 'Тикет: приоритет/метки (сайт)', `#${tid} → ${pri}${tags ? ' [' + tags + ']' : ''}`);
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

  // ===== гайды FAQ (Владелец) =====
  if (pathName.startsWith('/panel/faq/')) {
    if (acc.rank < LEVELS.owner) return '/panel?tab=faq_manage&' + qs({ err: 'Недостаточно прав.' });
    const refreshCat = async (cat) => { try { if (g) await faqDisplay.safeUpdateFaqChannel(g, cat); } catch (_) {} };
    if (pathName === '/panel/faq/add') {
      const cat = body.get('category') === 'hr' ? 'hr' : 'member';
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
      await db.run("DELETE FROM panel_grants WHERE discord_id = ? AND COALESCE(subject_type,'user') = ?", [sid, st]);
      for (const t of tabs) {
        await db.run('INSERT INTO panel_grants (discord_id, subject_type, tab, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)', [sid, st, t, user.id, new Date().toISOString()]);
      }
      _grantsCache.clear(); // роль затрагивает многих — сбрасываем весь кэш
      await webAuditMeta(client, user, 'Доступы к панели (сайт)', `${st === 'role' ? 'роль' : ''} ${sid} → ${tabs.join(', ') || 'убраны все'}`);
      return '/panel?tab=grants&' + qs({ ok: tabs.length ? `Выдано разделов: ${tabs.length}.` : 'Доступы убраны.' });
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
      const published = body.get('published') === '1' ? 1 : 0;
      const now = new Date().toISOString();
      await snapshotPage(orig && orig !== slug ? orig : slug);
      if (orig && orig !== slug) await db.run('DELETE FROM site_pages WHERE slug = ?', [orig]);
      await db.run(
        `INSERT INTO site_pages (slug, title, content, nav, published, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET title = excluded.title, content = excluded.content, nav = excluded.nav, published = excluded.published, updated_at = excluded.updated_at`,
        [slug, title, contentTxt, nav, published, now],
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
      await db.run('INSERT INTO page_assets (filename, mime, data, size, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
        [(body.get('filename') || 'image').slice(0, 120), m[1], buf, buf.length, user.id, new Date().toISOString()]);
      await webAuditMeta(client, user, 'Загружена картинка страницы (сайт)', `${buf.length} байт`);
      return '/panel?tab=pages&' + qs({ ok: 'Картинка загружена.' });
    }
    if (pathName === '/admin/asset/del') {
      await db.run('DELETE FROM page_assets WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
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
        for (const k of ['hide_stats', 'hide_giveaways', 'hide_agitation', 'banner_on']) {
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
    return '/notifications?' + qs({ ok: 'Отмечено.' });
  }
  if (pathName === '/notifications/read_one') {
    await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND discord_id = ?', [new Date().toISOString(), parseInt(body.get('id'), 10) || 0, user.id]);
    return '/notifications?' + qs({ ok: 'Отмечено.' });
  }
  if (pathName === '/notifications/snooze') {
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
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const done = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };
    const html = (code, body, extra = {}) => done(code, { 'Content-Type': 'text/html; charset=utf-8', ...extra }, body);
    const redirect = (loc, extra = {}) => done(302, { Location: loc, ...extra }, '');

    try {
      const u = new URL(req.url, baseUrl());
      const path = u.pathname;
      let user = readSession(req.headers.cookie);
      if (user && !(await sessionFresh(user))) user = null; // «выйти со всех устройств»
      const pageNum = Math.max(0, parseInt(u.searchParams.get('page') || '0', 10) || 0);
      const flash = flashBanner(u);
      const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      const notif = user ? await unreadCount(user.id).catch(() => 0) : 0;
      const panelGrant = user ? (await getPanelGrants(client, user.id)).size > 0 : false;
      const L = (o) => layout({ notif, panelGrant, ...o }); // layout с колокольчиком

      if (path === '/healthz') return done(200, { 'Content-Type': 'text/plain' }, 'ok');

      // Заморозка: участник с frozen=1 не может пользоваться сайтом (кроме выхода).
      // Статус кэшируется на 30 сек, чтобы не бить в БД на каждый запрос.
      if (user && user.id !== OWNER_ID && path !== '/logout' && path !== '/manifest.webmanifest'
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

      // ----- POST: все действия записи -----
      if (path === '/md/preview' && req.method === 'POST') {
        if (!user) return done(401, { 'Content-Type': 'text/plain' }, '');
        const b = await readBody(req);
        return done(200, { 'Content-Type': 'text/html; charset=utf-8' }, mdToHtml((b.get('text') || '').slice(0, 20000)));
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
        const a = await db.get('SELECT mime, data FROM page_assets WHERE id = ?', [aid]).catch(() => null);
        if (!a || !a.data) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
        return done(200, { 'Content-Type': a.mime || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }, a.data);
      }

      if (path.startsWith('/cimg/') && req.method === 'GET') {
        if (!user) return done(401, { 'Content-Type': 'text/plain' }, 'auth');
        const cid = parseInt(path.slice(6), 10) || 0;
        const im = await db.get('SELECT owner_id, mime, data FROM contract_uploads WHERE id = ?', [cid]).catch(() => null);
        if (!im || !im.data) return done(404, { 'Content-Type': 'text/plain' }, 'not found');
        if (im.owner_id !== user.id) {
          const a2 = await accessFor(client, user.id).catch(() => ({ rank: 0 }));
          if (a2.rank < LEVELS.hr) return done(403, { 'Content-Type': 'text/plain' }, 'forbidden');
        }
        return done(200, { 'Content-Type': im.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }, im.data);
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
        if (!process.env.CLIENT_ID) return html(500, L({ title: 'Ошибка', body: '<h1>CLIENT_ID не задан</h1>' }));
        const params = new URLSearchParams({ client_id: process.env.CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: 'identify' });
        return redirect(`${DISCORD_API}/oauth2/authorize?${params.toString()}`);
      }

      if (path === '/logout') {
        return redirect('/', { 'Set-Cookie': 'fc_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
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
        return html(200, L({ title: 'Заявка на вступление', user, level, body: flash + applyBody(user, getCookie(req.headers.cookie, 'fc_ref')) }));
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
        return html(200, L({ title: 'Личный кабинет', user, level, body: flash + bodyHtml }));
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
        if (uparts[1] === 'card') {
          if (uparts[0] !== user.id && acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Только свой профиль или HR+</h1>' }));
          return html(200, L({ title: 'Карточка', user, level: acc.level, body: flash + await profileCardBody(client, uparts[0]) }));
        }
        return html(200, L({ title: 'Профиль', user, level: acc.level, wide: true, body: flash + await profileBody(client, user, acc, uparts[0]) }));
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
        else if (path === '/calendar') bodyHtml = await calendarBody(client);
        else bodyHtml = await searchBody(client, u.searchParams.get('q'));
        return html(200, L({ title: 'Аналитика', user, level: acc.level, wide: true, body: flash + bodyHtml }));
      }

      if (path === '/compare' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для участников организации</h1><a class="btn" href="/me">Мой профиль</a>' }));
        return html(200, L({ title: 'Сравнение', user, level: acc.level, wide: true, body: flash + await compareBody(client, user.id, (u.searchParams.get('with') || '').trim()) }));
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
        const gid = parseInt(decodeURIComponent(path.slice(3)), 10) || 0;
        return html(200, L({ title: 'Розыгрыш', user, level: acc.level, wide: true, body: flash + await giveawayPageBody(client, user, gid, acc) }));
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

        if (path.startsWith('/export/table/') && path.endsWith('.csv')) {
          if (user.id !== OWNER_ID) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только havirys');
          const tbl = path.slice('/export/table/'.length, -'.csv'.length);
          if (!DATA_TABLES[tbl]) return done(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Неизвестная таблица');
          const rows = await db.all(`SELECT * FROM ${tbl} LIMIT 50000`).catch(() => []);
          const cols = rows.length ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : [{ key: 'empty', label: 'empty' }];
          await webAuditMeta(client, user, 'Экспорт таблицы CSV (сайт)', `${tbl} (${rows.length} строк)`);
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
      try { html(500, layout({ title: '500', body: '<h1>Внутренняя ошибка</h1>' })); } catch (_) {}
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web] Сайт запущен: ${baseUrl()} (0.0.0.0:${port})`);
    console.log(`[web] OAuth redirect_uri: ${redirectUri()} — добавь его в Discord Developer Portal → OAuth2 → Redirects`);
  });
  server.on('error', (err) => console.error('[web] Ошибка сервера:', err.message));
  return server;
}

module.exports = { start };
