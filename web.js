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
// Кликабельное имя/ссылка на профиль вместо сырого <@id>.
function personLink(client, id) {
  if (!id) return '—';
  const nm = nickOf(client, id) || ('ID ' + String(id).slice(-6));
  return `<a href="/u/${esc(id)}">${esc(nm)}</a>`;
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
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
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
.form button{margin-top:14px}
.avatar{border-radius:50%;object-fit:cover;border:1px solid var(--line);background:var(--panel2);flex:0 0 auto}
.phead{display:flex;gap:16px;align-items:center;margin-bottom:6px}
.phead h1{margin:0}
.actions{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.actions .form{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px}
.actions h3{font-size:14px;margin-bottom:2px}
.tglbtn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:14px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
.chart{display:flex;align-items:flex-end;gap:10px;height:170px;padding:10px 0;overflow-x:auto}
.chart .col{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:54px}
.chart .bar2{width:34px;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:6px 6px 0 0}
.chart .cap{font-size:11px;color:var(--muted);text-align:center}
.chart .val{font-size:12px;font-weight:700}
.mini{font-size:12px;color:var(--muted)}
@media(max-width:640px){
  .wrap{padding:18px 12px 48px}
  .top{padding:10px 12px}
  .actions{grid-template-columns:1fr}
  .phead{flex-wrap:wrap;gap:12px}
  h1{font-size:22px}
  .grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
}
`;

const THEME_TOGGLE = `<button class="tglbtn" type="button" onclick="fcTheme()" title="Тема">🌓</button>`;
const CLIENT_SCRIPT = `
(function(){
  try{
    var t=localStorage.getItem('fc_theme');
    if(t)document.documentElement.setAttribute('data-theme',t);
  }catch(e){}
  window.fcTheme=function(){
    var cur=document.documentElement.getAttribute('data-theme')==='light'?'':'light';
    if(cur)document.documentElement.setAttribute('data-theme','light');
    else document.documentElement.removeAttribute('data-theme');
    try{localStorage.setItem('fc_theme',cur);}catch(e){}
  };
  try{
    var p=location.pathname, s=location.search;
    if(p==='/panel'&&s.indexOf('tab=')<0){
      var lt=localStorage.getItem('fc_panel_tab');
      if(lt)location.replace('/panel?tab='+encodeURIComponent(lt));
    }
    if(p==='/panel'){
      var m=s.match(/tab=([^&]+)/); if(m)localStorage.setItem('fc_panel_tab',decodeURIComponent(m[1]));
    }
  }catch(e){}
})();`;

// ---------- Discord-подобное форматирование текста ----------
function mdInline(s) {
  return s
    .replace(/\[([^\]\n]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
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
  const next = { color: {} };
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
  const parts = siteBrand().trim().split(/\s+/);
  return parts.length > 1
    ? `<b>${esc(parts[0])}</b> ${esc(parts.slice(1).join(' '))}`
    : `<b>${esc(siteBrand())}</b>`;
}

function topbar(user, level, notif) {
  const brand = `<a class="brand" href="/">${brandHtml()}</a>`;
  if (!user) {
    return `<div class="top"><div class="left">${THEME_TOGGLE}<a class="btn sm" href="/login">Войти через Discord</a></div><div class="right">${brand}</div></div>`;
  }
  const bell = `<a href="/notifications" class="tglbtn" style="text-decoration:none" title="Уведомления">🔔${notif ? `<b style="color:var(--bad)"> ${notif}</b>` : ''}</a>`;
  const nav = ['<a href="/me">Мой профиль</a>'];
  if (LEVELS[level] < LEVELS.member) nav.push('<a href="/apply">Подать заявку</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/people">Участники</a>');
  nav.push('<a href="/giveaways">Розыгрыши</a>');
  nav.push('<a href="/faq">FAQ</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/commands">Команды</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/dashboard">Дашборд</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel">Панель</a>');
  return `<div class="top">
    <div class="left nav">${nav.join('')}<a href="/logout">Выйти</a></div>
    <div class="right">${bell}${THEME_TOGGLE}${brand}</div>
  </div>`;
}

function layout(opts) {
  const override = themeOverrideCss();
  const foot = SITE.footer ? esc(SITE.footer) : `${esc(siteBrand())} · сайт работает на том же сервере, что и Discord-бот`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="${(SITE.color && SITE.color.bg) || '#0f1013'}">
<style>${STYLE}${override}</style><script>${CLIENT_SCRIPT}</script></head><body>
${topbar(opts.user, opts.level || 'guest', opts.notif || 0)}
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
  return `
  <div class="hero">
    <h1>${esc(heroTitle)}</h1>
    <p>${esc(heroText)}</p>
    <a class="btn" href="/apply">Подать заявку на вступление</a>
    <a class="btn ghost" href="/login">Войти через Discord</a>
    <a class="btn ghost" href="${inv}" target="_blank" rel="noopener">Discord-сервер</a>
  </div>

  <div class="card">
    <h2>Организация в цифрах</h2>
    <div class="grid">
      <div class="tile"><div class="n">${st.accounts}</div><div class="l">участников</div></div>
      <div class="tile"><div class="n">${st.passports}</div><div class="l">паспортов</div></div>
      <div class="tile"><div class="n">${st.fulfilled} / ${st.unfulfilled}</div><div class="l">контракты ✅/❌ за неделю</div></div>
      <div class="tile"><div class="n">${st.endedGiveaways}</div><div class="l">завершённых розыгрышей</div></div>
    </div>
  </div>

  ${(st.activeGiveaways && st.activeGiveaways.length) ? `<div class="card"><h2>🎉 Идут розыгрыши</h2>
    ${st.activeGiveaways.map((gw) => `<a class="pill" href="/g/${gw.id}" style="font-size:14px">${esc(gw.prize)}</a>`).join(' ')}
    <div style="margin-top:10px"><a class="btn sm" href="/giveaways">Все розыгрыши · участвовать</a></div>
  </div>` : ''}

  ${await renderLandingBlocks(inv)}

  <div class="card">
    <h2>Текущая агитация</h2>
    <pre>${esc(ag).slice(0, 4000)}</pre>
  </div>`;
}

async function renderLandingBlocks(inv) {
  const rows = await db.all('SELECT * FROM landing_blocks ORDER BY position, id').catch(() => []);
  if (!rows.length) {
    return `
  <div class="card"><h2>Преимущества</h2><div class="feat">
    <div class="c"><h3>Контракты от 50 векселей</h3><p>Без x2. Берёшь сам, когда удобно.</p></div>
    <div class="c"><h3>Офис в Rockford Hills ВС</h3><p>Вексели сдаются там же.</p></div>
    <div class="c"><h3>Помощь в прокачке</h3><p>Поддержка по навыкам и профессиям.</p></div>
    <div class="c"><h3>Наборы при активности</h3><p>Можно брать наборы при минимальном онлайне.</p></div>
  </div></div>
  <div class="card"><h2>Как вступить</h2>
    <ol style="margin-left:18px;color:var(--muted)">
      <li>Зайти на Discord-сервер по <a href="${esc(inv)}" target="_blank" rel="noopener">приглашению</a>.</li>
      <li>Нажать «Подать заявку» и заполнить форму.</li>
      <li>Дождаться решения HR — ответ придёт в ЛС от бота.</li>
    </ol></div>`;
  }
  return rows.map((b) => {
    const h = b.title ? `<h2>${esc(b.title)}</h2>` : '';
    if (b.kind === 'buttons') {
      const btns = (b.content || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0] && a[1])
        .map(([label, url]) => `<a class="btn sm" href="${esc(url)}"${/^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : ''}>${esc(label)}</a>`).join(' ');
      return `<div class="card">${h}<div class="bar">${btns}</div></div>`;
    }
    if (b.kind === 'cards') {
      const cs = (b.content || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((a) => a[0])
        .map(([t2, d]) => `<div class="c"><h3>${esc(t2)}</h3><p>${esc(d || '')}</p></div>`).join('');
      return `<div class="card">${h}<div class="feat">${cs}</div></div>`;
    }
    return `<div class="card">${h}${mdToHtml(b.content || '')}</div>`;
  }).join('');
}

async function panelLanding(user) {
  const rows = await db.all('SELECT * FROM landing_blocks ORDER BY position, id').catch(() => []);
  const kindSel = (cur) => `<select name="kind">${[['text', 'Текст (Discord-разметка)'], ['buttons', 'Кнопки (строка: Текст | URL)'], ['cards', 'Карточки (строка: Заголовок | Описание)']].map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const list = rows.map((b, i) => `<div class="card">
    <form method="POST" action="/admin/landing/save" class="form">${csrfField(user)}<input type="hidden" name="id" value="${b.id}">
      <label>Тип${kindSel(b.kind)}</label>
      <label>Заголовок (можно пусто)<input name="title" value="${esc(b.title || '')}" maxlength="120"></label>
      <label>Содержимое<textarea name="content" rows="5" maxlength="4000">${esc(b.content || '')}</textarea></label>
      <div class="bar">
        <button class="btn sm" type="submit">Сохранить</button>
        <button class="btn ghost sm" formaction="/admin/landing/move" name="dir" value="up" type="submit" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn ghost sm" formaction="/admin/landing/move" name="dir" value="down" type="submit" ${i === rows.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn ghost sm" formaction="/admin/landing/del" style="background:var(--bad)" type="submit" onclick="return confirm('Удалить блок?')">Удалить</button>
      </div>
    </form>
  </div>`).join('');
  return `<div class="card"><h2>Блоки главной страницы</h2>
    <p class="mini">Блоки идут между «Организация в цифрах» и «Текущей агитацией». Если ни одного блока нет — показываются стандартные «Преимущества» и «Как вступить». Заголовок сайта/герой/подвал правятся на вкладке «Админ».</p>
    <form method="POST" action="/admin/landing/add" class="form">${csrfField(user)}
      <label>Тип нового блока${kindSel('text')}</label>
      <label>Заголовок<input name="title" maxlength="120"></label>
      <label>Содержимое<textarea name="content" rows="4" maxlength="4000"></textarea></label>
      <button class="btn sm" type="submit">Добавить блок</button>
    </form>
  </div>${list}`;
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
  const loginsCard = `<div class="card"><h2>Мои входы</h2>
    <div class="tablewrap"><table><tr><th>Когда</th><th>IP</th><th>Браузер</th></tr>
      ${logins.map((l) => `<tr><td class="muted">${fmt(l.at)}</td><td>${esc(l.ip || '—')}</td><td class="mini">${esc((l.ua || '—').slice(0, 90))}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
    </table></div>
    <form method="POST" action="/me/logout_all" style="margin-top:10px" onsubmit="return confirm('Выйти со всех устройств? Текущая сессия тоже завершится.')">${csrfField(user)}<button class="btn sm" style="background:var(--bad)" type="submit">Выйти со всех устройств</button></form>
  </div>`;

  if (!p) {
    return `
      <div class="phead"><img class="avatar" width="72" height="72" src="${esc(av)}" alt=""><h1>Личный кабинет</h1></div>
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
      <div class="muted">Discord: ${esc(user.username)} · ID ${esc(did)} · вступил ${fmt(p.joined_at)} · <a href="/u/${esc(did)}">полный профиль</a> · <a href="/u/${esc(did)}/card">карточка</a></div>
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
    ${badgesCard(bs)}
    <div class="card"><h2>Приглашения</h2>Подтверждённых за всё время: <b>${invRow ? invRow.c : 0}</b></div>
    ${ticketCard}
    ${inviteCard}
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
  ['data', 'База данных'],
];

async function panelBody(client, acc, user, tab, pageNum, qtable, sp) {
  const canData = acc.rank >= LEVELS.owner;
  const canBl = acc.rank >= LEVELS.deputy;
  const canOwner = acc.rank >= LEVELS.owner;
  const isHavirys = user && user.id === OWNER_ID;
  const vis = {
    blacklist: canBl, texts: canOwner, faq_manage: canOwner, reasons: canOwner,
    broadcast: canOwner, settings: canOwner, perms: isHavirys, admin: isHavirys, data: canData,
    role_check: acc.rank >= LEVELS.deputy, hr_payouts: canOwner, landing: isHavirys,
  };
  const tabsHtml = PANEL_TABS
    .filter(([id]) => vis[id] === undefined || vis[id])
    .map(([id, label]) => `<a class="${id === tab ? 'on' : ''}" href="/panel?tab=${id}">${esc(label)}</a>`).join('');

  let body = '';
  if (tab === 'overview') body = await panelOverview();
  else if (tab === 'sla') body = await panelSla(client, user, pageNum);
  else if (tab === 'apps') body = await panelApps(client, user, pageNum);
  else if (tab === 'queues') body = await panelQueues(client, user, pageNum);
  else if (tab === 'contracts_check') body = await panelContractCheck(client, user, pageNum);
  else if (tab === 'role_check' && acc.rank >= LEVELS.deputy) body = await panelRoleCheck(client, user);
  else if (tab === 'members') body = await panelMembers(client, pageNum, user);
  else if (tab === 'contracts') body = await panelContracts(client);
  else if (tab === 'invites') body = await panelInvites(client);
  else if (tab === 'hr_payouts' && canOwner) body = await panelHrPayouts(client);
  else if (tab === 'giveaways') body = await panelGiveaways(client, acc, user);
  else if (tab === 'blacklist' && canBl) body = await panelBlacklist(client, user);
  else if (tab === 'texts' && canOwner) body = await panelTexts(user);
  else if (tab === 'faq_manage' && canOwner) body = (await panelFaqManage(user)) + (await faqFeedbackReport());
  else if (tab === 'reasons' && canOwner) body = await panelReasons(user);
  else if (tab === 'broadcast' && canOwner) body = await panelBroadcast(user);
  else if (tab === 'settings' && canOwner) body = await panelSettings(user);
  else if (tab === 'perms' && isHavirys) body = await panelPerms(user);
  else if (tab === 'admin' && isHavirys) body = await panelAdmin(client, user);
  else if (tab === 'landing' && isHavirys) body = await panelLanding(user);
  else if (tab === 'data' && canData) body = await panelData(client, qtable || 'participants', pageNum, user, sp);
  else body = '<div class="card">Раздел недоступен.</div>';

  return `<h1>Панель управления</h1>
    <div class="muted">Ваш уровень: <b>${esc(acc.level)}</b></div>
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
    manage = `
    <div class="card"><h2>Создать розыгрыш</h2>
      <form method="POST" action="/panel/giveaway/create" class="form">
        ${csrfField(user)}
        <label>Приз<input name="prize" required maxlength="200"></label>
        <label>Число победителей<input name="winners" type="number" min="1" max="50" value="1" required></label>
        <label>Длительность (например 30m, 1h, 2d, 1w)<input name="duration" required maxlength="10"></label>
        <label>ID канала для публикации<input name="channel_id" required pattern="[0-9]+" maxlength="25"></label>
        <label>ID обязательной роли — только эта роль (необязательно)<input name="role_id" pattern="[0-9]*" maxlength="25"></label>
        <label>ID минимальной роли — этот ранг и ВЫШЕ (необязательно)<input name="min_role_id" pattern="[0-9]*" maxlength="25"></label>
        <button class="btn" type="submit">Создать и опубликовать</button>
      </form>
    </div>
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
  if (col === 'role_id') return esc(roleName(client, val));
  if (col === 'appeal_blocked') return val ? 'да' : 'нет';
  if (col === 'rating') return val === 1 ? '👍' : (val === 0 ? '👎' : '—');
  if (/_at$|^until$|^ends_at$|^joined_at$|_login$/.test(col)) return esc(fmt(val));
  const s = String(val);
  return esc(s.length > 160 ? s.slice(0, 160) + '…' : s);
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
    ${canEdit ? `<p class="muted" style="margin-bottom:10px">Режим редактирования (havirys): ✏️ — изменить строку. ${addBtn}</p>` : ''}
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
      if (data.length > 1e6) { aborted = true; req.destroy(); }
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

// Сессия «свежая», если её версия совпадает с web_users.sess_ver.
// Версию кэшируем на 60 сек, чтобы не читать БД на каждый запрос.
const _sessVerCache = new Map(); // discordId -> { at, ver }
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
  return ver === (user.sv || 0);
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
    <td><a href="/u/${esc(p.discord_id)}">${esc(p.name)}</a></td>
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
    }
    const anyVac = passports.some((pp) => pp.vacation_until);
    const anyAfk = passports.some((pp) => pp.afk_since);
    blocks.push(`<form method="POST" action="/u/vacation" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <h3>Выдать отпуск (все паспорта)</h3>
      <label>До какого числа (ДД.ММ.ГГГГ или 7d)<input name="deadline" required maxlength="20"></label>
      <label>Причина<input name="reason" maxlength="200"></label>
      <button class="btn sm" type="submit">Выдать</button></form>`);
    if (anyVac) {
      blocks.push(`<form method="POST" action="/u/vacation_revoke" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Снять отпуск</h3>
        <button class="btn sm" type="submit">Снять со всех паспортов</button></form>`);
    }
    blocks.push(`<form method="POST" action="/u/afk" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
      <h3>Отметить AFK (все паспорта)</h3>
      <label>Дата начала (ДД.ММ.ГГГГ)<input name="date" required maxlength="20"></label>
      <label>Причина<input name="reason" maxlength="200"></label>
      <button class="btn sm" type="submit">Отметить</button></form>`);
    if (anyAfk) {
      blocks.push(`<form method="POST" action="/u/afk_clear" class="form">${csrfField(viewer)}<input type="hidden" name="target" value="${esc(targetId)}">
        <h3>Снять AFK</h3>
        <button class="btn sm" type="submit">Снять со всех паспортов</button></form>`);
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
  const promoRows = promos.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${esc(r.action)}</td><td>${esc((r.details || '').slice(0, 200))}</td></tr>`).join('');
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
        ${siteActs.map((a) => `<tr><td class="muted">${fmt(a.at)}</td><td>${esc(a.action || '')}</td><td class="mini">${esc((a.details || '').slice(0, 160))}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}
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
    <h1>${esc(ident ? ident.name + ' | ' + ident.static : p.name)}</h1>
    <div class="muted">Discord: ${esc(p.discord_tag || targetId)} · ID ${esc(targetId)} · вступил ${fmt(p.joined_at)}</div>
  </div></div>
  ${blBox}
  <div class="card"><h2>Роли на сервере</h2>${roleTags}</div>
  <div class="card"><h2>Паспорта (${passports.length})</h2>
    <div class="tablewrap"><table><tr><th>Имя Фамилия</th><th>Паспорт</th><th>Ранг</th><th>Статус</th></tr>${passRows || '<tr><td colspan="4">—</td></tr>'}</table></div>
  </div>
  <div class="card"><h2>Контракты за ${esc(contracts.formatWeekLabel(range))}</h2>
    <span class="badge ok">✅ ${week.fulfilled.length}</span> <span class="badge bad">❌ ${week.unfulfilled.length}</span>
    &nbsp;·&nbsp; Приглашений подтверждено: <b>${invRow ? invRow.c : 0}</b>
  </div>
  ${badgesCard(bs)}
  <div class="card"><h2>Карточка для Discord</h2>
    <pre id="mcard">${esc((ident ? ident.name + ' | ' + ident.static : p.name) + '\nРанг: ' + roleName(client, (ident && ident.roleId) || p.role_id) + '\nDiscord: <@' + targetId + '>\nКонтракты (всего): ' + bs.fulfilled + '\nЗа неделю: +' + week.fulfilled.length + ' / -' + week.unfulfilled.length + '\nПриглашений: ' + (invRow ? invRow.c : 0) + '\nВступил: ' + fmt(p.joined_at))}</pre>
    <button class="btn sm" type="button" onclick="navigator.clipboard.writeText(document.getElementById('mcard').textContent).then(()=>{this.textContent='Скопировано ✓'})">Скопировать</button>
  </div>
  ${invitedByLine}
  ${notesCard}
  ${extraStaffCards}
  ${actions}
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
    const h = Math.round(((Number(i.value) || 0) / max) * 140);
    return `<div class="col"><div class="val">${esc(i.value)}</div><div class="bar2" style="height:${h}px"></div><div class="cap">${esc(i.label)}</div></div>`;
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
async function dashboardBody(client) {
  const c = (sql, p = []) => db.get(sql, p).then((r) => (r ? r.c : 0));
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();

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

  return `
  <h1>Дашборд</h1>
  <div class="card"><h2>Воронка найма за 30 дней</h2>
    <div class="grid">${tile(total, 'заявок')}${tile(accepted, 'принято')}${tile(rejected, 'отказано')}${tile(pending, 'в очереди')}${tile(stayed, 'досидело 3+ дня')}</div>
    ${barChart([{ label: 'подано', value: total }, { label: 'принято', value: accepted }, { label: 'отказ', value: rejected }, { label: '3+ дня', value: stayed }])}
  </div>
  <div class="card"><h2>Скорость рассмотрения заявок</h2>
    <p class="mini">Среднее время до решения за 30 дней: <b>${avgH} ч</b> · рассмотрено ${reviewed.length} из ${total}</p>
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
    // Статистика отпусков за 30 дней
    const vac = await db.all("SELECT status, until, created_at FROM vacations WHERE created_at >= ?", [since30]).catch(() => []);
    const vAcc = vac.filter((v) => v.status === 'accepted');
    const vRej = vac.filter((v) => v.status === 'rejected').length;
    const avgDays = vAcc.length ? Math.round(vAcc.reduce((s, v) => s + Math.max(0, (new Date(v.until) - new Date(v.created_at)) / 864e5), 0) / vAcc.length) : 0;
    return `<div class="card"><h2>HR за 30 дней (по людям)</h2>
      <div class="tablewrap"><table><tr><th>Сотрудник</th><th>Принял</th><th>Отклонил</th><th>Ср. время</th></tr>${hrRows || '<tr><td colspan="4">—</td></tr>'}</table></div></div>
    <div class="card"><h2>Отпуска за 30 дней</h2><div class="grid">
      ${tile(vac.length, 'заявок')}${tile(vAcc.length, 'одобрено')}${tile(vRej, 'отклонено')}${tile(avgDays + ' дн.', 'средняя длина')}${tile(onVac, 'в отпуске сейчас')}
    </div></div>`;
  })()}
  <p class="bar"><a href="/leaderboards">Лидерборды</a> · <a href="/calendar">Календарь отпусков</a> · <a href="/search">Поиск везде</a> · <a href="/commands">Команды</a> · <a href="/audit">Аудит</a> · <a href="/tools">Экспорт и обслуживание</a> · <a href="/health">Здоровье системы</a> · <a href="/panel">Панель</a></p>`;
}

async function leaderboardsBody(client) {
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

  const ctab = (arr) => arr.slice(0, 20).map((r, i) => `<tr><td>${i + 1}</td><td>${personLink(client, r.discord_id)}</td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  const itab = (arr) => arr.slice(0, 20).map((r, i) => `<tr><td>${i + 1}</td><td>${personLink(client, r.inviter_discord_id)}</td><td>${r.cnt}</td></tr>`).join('');
  return `
  <h1>Лидерборды</h1>
  <div class="card"><h2>Контракты — неделя (${esc(contracts.formatWeekLabel(range))})</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${ctab(cWeek) || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Контракты — всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${ctab(cAll) || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Приглашения — неделя</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Кол-во</th></tr>${itab(iWeek) || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Приглашения — всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Кол-во</th></tr>${itab(iAll) || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Победители розыгрышей (180 дней)</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Побед</th></tr>${gwTop.map(([w, n], i) => `<tr><td>${i + 1}</td><td>${personLink(client, w)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
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
  const sec = (title, rowsHtml, colsN) => `<div class="card"><h2>${esc(title)}</h2><div class="tablewrap"><table>${rowsHtml || `<tr><td colspan="${colsN}">—</td></tr>`}</table></div></div>`;
  return `
  <h1>Поиск: «${esc(q)}»</h1>
  <div class="card"><form method="GET" action="/search" class="form"><label>Запрос<input name="q" value="${esc(q)}" maxlength="80"></label><button class="btn" type="submit">Искать</button></form></div>
  ${sec('Участники (' + P.length + ')', '<tr><th>Имя</th><th>Паспорт</th></tr>' + P.map((r) => `<tr><td><a href="/u/${esc(r.discord_id)}">${esc(r.name)}</a></td><td>№ ${esc(r.static)}</td></tr>`).join(''), 2)}
  ${sec('Заявки (' + A.length + ')', '<tr><th>#</th><th>Имя</th><th>Паспорт</th><th>Статус</th></tr>' + A.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.name || r.discord_tag)}</td><td>${esc(r.static || '—')}</td><td>${esc(ruStatus(r.status))}</td></tr>`).join(''), 4)}
  ${sec('Чёрный список (' + B.length + ')', '<tr><th>#</th><th>Discord ID</th><th>Паспорт</th><th>Причина</th></tr>' + B.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.discord_id || '—')}</td><td>${esc(r.static || '—')}</td><td>${esc(r.reason || '—')}</td></tr>`).join(''), 4)}
  ${sec('Тикеты (' + T.length + ')', '<tr><th>#</th><th>Тема</th><th>Тип</th><th>Статус</th></tr>' + T.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.subject || '—')}</td><td>${esc(TICKET_CAT_RU[r.category] || r.category || '—')}</td><td>${esc(ruStatus(r.status))}</td></tr>`).join(''), 4)}`;
}

async function auditBody(client, sp, pageNum, user) {
  const who = (sp.get('who') || '').trim();
  const act = (sp.get('act') || '').trim();
  const days = parseInt(sp.get('days') || '14', 10) || 14;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const cond = ['at >= ?'];
  const par = [since];
  if (who) { cond.push('(actor_id = ? OR actor_tag LIKE ?)'); par.push(who, `%${who}%`); }
  if (act) { cond.push('action LIKE ?'); par.push(`%${act}%`); }
  const where = 'WHERE ' + cond.join(' AND ');
  const totalRow = await db.get(`SELECT COUNT(*) c FROM audit_log ${where}`, par);
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...par, PAGE_SIZE, pageNum * PAGE_SIZE]);
  const trs = rows.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${esc(r.actor_tag || r.actor_id || '—')}</td><td>${esc(r.action || '')}</td><td>${esc((r.details || '').slice(0, 300))}</td></tr>`).join('');
  const qkeep = qs({ who, act, days });
  const undoable = await db.all("SELECT * FROM undo_actions WHERE done_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 10", [new Date().toISOString()]).catch(() => []);
  const undoCard = undoable.length ? `<div class="card"><h2>Можно отменить (5 мин)</h2>
    ${undoable.map((u2) => `<div class="bar"><span class="mini">${u2.kind === 'rank' ? 'смена ранга' : u2.kind} · ${personLink(client, u2.target_id)} · ${fmt(u2.created_at)}</span>
      <form method="POST" action="/undo" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${u2.id}"><button class="btn ghost sm" type="submit">Отменить</button></form></div>`).join('')}
  </div>` : '';
  return `
  <h1>Аудит</h1>
  ${undoCard}
  <div class="card"><form method="GET" action="/audit" class="form">
    <label>Кто (Discord ID или часть тега)<input name="who" value="${esc(who)}" maxlength="60"></label>
    <label>Действие содержит<input name="act" value="${esc(act)}" maxlength="60"></label>
    <label>За сколько дней<input name="days" type="number" min="1" max="365" value="${days}"></label>
    <button class="btn" type="submit">Применить</button>
    <a class="btn ghost sm" href="/audit.csv?${qkeep}">Экспорт CSV</a>
  </form>
  <div class="bar"><span class="mini">Пресеты:</span>
    <a class="btn ghost sm" href="/audit?act=Увольнение">Увольнения</a>
    <a class="btn ghost sm" href="/audit?act=Повышение">Повышения</a>
    <a class="btn ghost sm" href="/audit?act=ЧС">Изменения ЧС</a>
    <a class="btn ghost sm" href="/audit?act=Розыгрыш">Розыгрыши</a>
    <a class="btn ghost sm" href="/audit?act=сайт">Действия с сайта</a>
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
  const brList = brRows.map((b) => `<tr><td>${esc(badges.LABELS[b.badge_key] || b.badge_key)}</td><td>&lt;@&amp;${esc(b.role_id)}&gt;</td><td class="muted">${fmt(b.created_at)}</td></tr>`).join('');
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
  const parts = [];
  for (const [k, title] of keys) {
    let cur = '';
    try { const row = await contentVersions.getLatestVersion(k); cur = row ? row.content : ''; } catch (_) {}
    const extra = k === 'rules'
      ? `<form method="POST" action="/panel/rules_broadcast" style="margin-top:8px" onsubmit="return confirm('Отправить правила в канал правил и в ЛС всем участникам?')">${csrfField(user)}<button class="btn ghost sm" type="submit">📕 Разослать правила</button></form>`
      : (k === 'agitation' || k === 'hr_info'
        ? `<form method="POST" action="/panel/text/publish" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="key" value="${k}"><button class="btn ghost sm" type="submit">Опубликовать в канал</button></form>`
        : '');
    parts.push(`<div class="card"><h2>${esc(title)}</h2>
      <form method="POST" action="/panel/text/save" class="form">${csrfField(user)}<input type="hidden" name="key" value="${k}">
        <label>Текст<textarea name="content" rows="8" maxlength="6000">${esc(cur)}</textarea></label>
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

async function panelAdmin(client, user) {
  await loadSite(true);
  const g = guildOf(client);
  const v = (k, d) => esc(SITE[k] != null && SITE[k] !== '' ? SITE[k] : (d || ''));

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
      ${['default', 'amoled', 'ocean', 'forest', 'plum'].map((pn) => `<form method="POST" action="/admin/theme_preset" style="display:inline">${csrfField(user)}<input type="hidden" name="preset" value="${pn}"><button class="btn ghost sm" type="submit">${pn === 'default' ? 'стандарт' : pn === 'amoled' ? 'AMOLED' : pn === 'ocean' ? 'океан' : pn === 'forest' ? 'лес' : 'слива'}</button></form>`).join('')}
    </div>
    <p class="mini">Применяется на всех страницах через ~30 сек (кэш). Светлая тема остаётся стандартной.</p>
  </div>

  <div class="card"><h2>Конфигурация сайта (JSON)</h2>
    <a class="btn sm" href="/export/site-config.json">Скачать настройки</a>
    <form method="POST" action="/admin/config_import" class="form" style="margin-top:10px">${csrfField(user)}
      <label>Загрузить (вставьте JSON вида {"site":{...},"channels":{...}})<textarea name="json" rows="4"></textarea></label>
      <button class="btn sm" type="submit">Применить</button>
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
      items.push(`<div class="card">
        <h3>${esc(e.title)}</h3>
        ${mdToHtml((e.content || '').slice(0, 4000))}
        <form method="POST" action="/faq/vote" class="bar" style="margin-top:8px">${csrfField(user)}<input type="hidden" name="id" value="${e.id}">
          <button class="btn ghost sm" name="v" value="1" ${mine && mine.helpful === 1 ? 'disabled' : ''}>👍 ${up ? up.c : 0}</button>
          <button class="btn ghost sm" name="v" value="0" ${mine && mine.helpful === 0 ? 'disabled' : ''}>👎 ${down ? down.c : 0}</button>
          ${mine ? '<span class="mini">ваш голос учтён</span>' : ''}
        </form>
      </div>`);
    }
    blocks.push(`<h2 style="margin-top:16px">${esc(catTitle[cat])}</h2>${items.join('') || '<div class="card">Пусто.</div>'}`);
  }
  return `<h1>FAQ / Гайды</h1>${blocks.join('')}`;
}

// ---------- Бейджи и стрик (расчёт вынесен в badges.js — общий с ботом) ----------
async function computeBadgesAndStreak(client, targetId) {
  try {
    return await badges.compute(targetId);
  } catch (_) {
    return { badges: [], streak: 0, fulfilled: 0, wins: 0 };
  }
}
function badgesCard(bs) {
  if (!bs.badges.length) return `<div class="card"><h2>Бейджи</h2><span class="muted">Пока нет — выполняй контракты и приглашай друзей.</span></div>`;
  return `<div class="card"><h2>Бейджи${bs.streak >= 2 ? ` · 🔥 стрик ${bs.streak} нед.` : ''}</h2>${bs.badges.map((b) => `<span class="pill">${esc(b)}</span>`).join('')}</div>`;
}

// ---------- Розыгрыши: список и участие с сайта ----------
async function giveawaysPublicBody(client) {
  const rows = await db.all("SELECT * FROM giveaways WHERE status = 'active' ORDER BY ends_at ASC");
  const list = [];
  for (const gv of rows) {
    const cnt = await giveaways.countEntries(gv.id);
    list.push(`<div class="card">
      <h3>🎉 ${esc(gv.prize)}</h3>
      <div class="mini">Победителей: ${gv.winners_count} · Участников: ${cnt} · Закончится ${fmt(gv.ends_at)}${gv.required_role_id ? ` · роль <@&${esc(gv.required_role_id)}>` : ''}${gv.min_role_id ? ` · ранг не ниже <@&${esc(gv.min_role_id)}>` : ''}</div>
      <a class="btn sm" href="/g/${gv.id}">Открыть</a>
    </div>`);
  }
  return `<h1>Активные розыгрыши</h1>${list.join('') || '<div class="card">Сейчас розыгрышей нет.</div>'}`;
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
      else if (gv.required_role_id && !m.roles.cache.has(gv.required_role_id)) note = `⛔ Нужна роль <@&${gv.required_role_id}>.`;
      else if (gv.min_role_id && !giveaways.meetsMinRole(m, gv.min_role_id)) note = `⛔ Нужен ранг не ниже <@&${gv.min_role_id}>.`;
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

  return `
  <h1>🎉 ${esc(gv.prize)}</h1>
  <div class="card">
    <div class="mini">Победителей: ${gv.winners_count} · Участников: <b>${cnt}</b> · ${ended ? 'Завершён' : 'Закончится ' + fmt(gv.ends_at)}</div>
    ${gv.winners ? `<p style="margin-top:8px">Победители: ${winnerIds.map((w) => personLink(client, w)).join(', ')}</p>` : ''}
    ${note ? `<p class="mini" style="color:var(--bad);margin-top:8px">${note}</p>` : ''}
    ${canToggle ? `<form method="POST" action="/g/enter" style="margin-top:10px">${csrfField(user)}<input type="hidden" name="id" value="${gv.id}">
      <button class="btn" type="submit">${inside ? '❌ Выйти из розыгрыша' : '🎉 Участвовать'}</button></form>` : ''}
  </div>
  ${listCard}
  ${roulette}
  <p><a href="/giveaways">← ко всем розыгрышам</a></p>`;
}

// ---------- Тикет целиком на сайте ----------
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
        const bodyHtml = esc(m.content || '') + (att ? ' ' + att : '') + (m.embeds.length ? ' <span class="mini">[embed]</span>' : '');
        return `<div style="border-left:2px solid var(--line);padding-left:10px;margin:8px 0">
          <b>${esc(m.member ? m.member.displayName : m.author.username)}</b> <span class="mini">${fmt(new Date(m.createdTimestamp).toISOString())}</span><br>
          <span style="white-space:pre-wrap">${bodyHtml || '<span class="mini">—</span>'}</span></div>`;
      }).join('') || '<span class="muted">Пока пусто.</span>';
    } catch (_) {}
  }
  const closed = t.status !== 'open';
  return `
  <h1>🎫 ${esc(t.subject || 'Тикет')} #${t.id}</h1>
  <div class="muted">${esc(TICKET_CAT_RU[t.category] || t.category || '')} · ${closed ? 'закрыт' : 'открыт'} · автор ${personLink(client, t.opener_id)}</div>
  <div class="card">${msgsHtml}</div>
  ${closed ? '' : `<div class="card"><form method="POST" action="/ticket/post" class="form">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
    <label>Ваше сообщение<textarea name="text" rows="3" required maxlength="1800"></textarea></label>
    <button class="btn" type="submit">Отправить в тикет</button></form></div>`}
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
        <label>Текст<textarea name="content" rows="4" maxlength="3000" required>${esc(e.content)}</textarea></label>
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
        <label>Текст<textarea name="content" rows="3" maxlength="3000" required></textarea></label>
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
async function notificationsBody(user) {
  const rows = await db.all('SELECT * FROM notifications WHERE discord_id = ? ORDER BY id DESC LIMIT 100', [user.id]).catch(() => []);
  const list = rows.map((n) => `<div class="card" style="${n.read_at ? 'opacity:.6' : ''}">
    <div>${esc(n.text)}</div>
    <div class="mini">${fmt(n.created_at)}${n.link ? ` · <a href="${esc(n.link)}">открыть</a>` : ''}</div>
  </div>`).join('');
  return `<div class="bar"><h1 style="margin:0">Уведомления</h1>
    <form method="POST" action="/notifications/read_all">${csrfField(user)}<button class="btn sm" type="submit">Отметить все прочитанными</button></form></div>
    ${list || '<div class="card">Пусто.</div>'}`;
}

// ---------- Карточка профиля для печати ----------
async function profileCardBody(client, targetId) {
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [targetId]).catch(() => null);
  if (!p) return '<div class="card">Участник не найден.</div>';
  const av = await resolveAvatar(client, targetId, 128);
  const passports = await passportsLib.getAllPassports(targetId).catch(() => []);
  const ident = await passportsLib.computeEffectiveIdentity(targetId).catch(() => null);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(targetId, range).catch(() => ({ fulfilled: [], unfulfilled: [] }));
  const bs = await computeBadgesAndStreak(client, targetId);
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [targetId]).catch(() => null);
  const row = (id, label) => `<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" checked onchange="var d=document.querySelector('.pcard [data-sec=&quot;${id}&quot;]');if(d)d.style.display=this.checked?'':'none'"> ${esc(label)}</label>`;
  return `
  <style>@media print{.noprint{display:none!important}} .pcard div[data-sec]{margin:6px 0}</style>
  <h1>Карточка участника</h1>
  <div class="card noprint">
    <p class="mini">Снимите галочки с ненужного, затем «Печать».</p>
    ${row('badges', 'Бейджи')}${row('week', 'Контракты за неделю')}${row('total', 'Всего контрактов')}${row('inv', 'Приглашения')}${row('passports', 'Паспорта')}${row('joined', 'Дата вступления')}
    <button class="btn sm" type="button" onclick="window.print()">Печать</button>
  </div>
  <div class="card pcard">
    <div class="phead"><img class="avatar" width="72" height="72" src="${esc(av)}" alt=""><div>
      <h2 style="margin:0">${esc(ident ? ident.name + ' | ' + ident.static : p.name)}</h2>
      <div class="mini">${esc(roleName(client, (ident && ident.roleId) || p.role_id))}</div>
    </div></div>
    <div data-sec="joined">Вступил: ${fmt(p.joined_at)}</div>
    <div data-sec="passports">Паспорта: ${passports.map((pp) => esc(pp.name) + ' (№ ' + esc(pp.static) + ')').join(', ') || '—'}</div>
    <div data-sec="week">Контракты за неделю: ✅ ${week.fulfilled.length} / ❌ ${week.unfulfilled.length}</div>
    <div data-sec="total">Всего выполнено контрактов: ${bs.fulfilled}</div>
    <div data-sec="inv">Подтверждённых приглашений: ${invRow ? invRow.c : 0}</div>
    <div data-sec="badges">Бейджи: ${bs.badges.join(', ') || '—'}</div>
  </div>
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
    _sessVerCache.delete(user.id); // чтобы другие устройства разлогинились сразу
    await webAudit(client, user, 'Выход со всех устройств (сайт)', '');
    return '/login';
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
    if (acc.rank < LEVELS.hr) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    const appId = parseInt(body.get('id'), 10) || 0;
    const text = (body.get('text') || '').trim().slice(0, 1000);
    if (!text || !(await db.get('SELECT id FROM applications WHERE id = ?', [appId]))) return '/panel?tab=apps&' + qs({ err: 'Пусто или заявка не найдена.' });
    await db.run('INSERT INTO application_comments (application_id, author_id, author_name, text, at) VALUES (?, ?, ?, ?, ?)', [appId, user.id, uname, text, new Date().toISOString()]);
    return '/panel?tab=apps&' + qs({ ok: 'Комментарий добавлен.' });
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
      if (!prize || winners < 1 || !durMs || !/^[0-9]+$/.test(channelId)) return '/panel?tab=giveaways&' + qs({ err: 'Проверьте поля формы (приз, победители, длительность, ID канала).' });
      const endsAt = new Date(Date.now() + durMs);
      const gid = await giveaways.createGiveaway(channelId, prize, winners, user.id, endsAt.toISOString(), roleId, null, minRoleId);
      const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`🎉 ${prize}`)
        .setDescription(`Нажмите на кнопку ниже, чтобы участвовать!\nОрганизатор: <@${user.id}>${roleId ? `\nУсловие: только роль <@&${roleId}>` : ''}${minRoleId ? `\nУсловие: роль <@&${minRoleId}> и выше` : ''}`)
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
    if (pathName === '/panel/row/save') {
      const pk = body.get('pk');
      const setCols = info.filter((ci) => !ci.pk);
      if (!setCols.length) return '/panel?tab=data&table=' + encodeURIComponent(table) + '&' + qs({ err: 'Нет изменяемых столбцов.' });
      const sets = setCols.map((ci) => `${ci.name} = ?`).join(', ');
      const vals = setCols.map((ci) => {
        const raw = body.get('f_' + ci.name);
        return raw === '' || raw == null ? null : raw;
      });
      await db.run(`UPDATE ${table} SET ${sets} WHERE rowid = ?`, [...vals, pk]);
      await webAudit(client, user, 'Правка БД (сайт)', `${table} rowid=${pk}: ${setCols.map((c) => c.name).join(', ')}`);
      return '/panel/row?' + qs({ table, pk, ok: 'Строка сохранена.' });
    }
    if (pathName === '/panel/row/delete') {
      const pk = body.get('pk');
      await db.run(`DELETE FROM ${table} WHERE rowid = ?`, [pk]);
      await webAudit(client, user, 'Удаление строки БД (сайт)', `${table} rowid=${pk}`);
      return '/panel?tab=data&table=' + encodeURIComponent(table) + '&' + qs({ ok: 'Строка удалена.' });
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
      await webAudit(client, user, 'Добавление строки БД (сайт)', `${table}: ${present.map((c) => c.name).join(', ')}`);
      return '/panel?tab=data&table=' + encodeURIComponent(table) + '&' + qs({ ok: 'Строка добавлена.' });
    }
    return '/panel?tab=data&table=' + encodeURIComponent(table);
  }

  // ===== действия над профилем участника =====
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
    if (pathName === '/u/vacation') {
      const deadline = dates.parseDeadline(body.get('deadline') || '');
      if (!deadline) return back + '?' + qs({ err: 'Неверная дата.' });
      const reason = (body.get('reason') || '').trim();
      const passports = await passportsLib.getAllPassports(target);
      for (const pp of passports) {
        await passportsLib.updatePassportFields(target, pp.static, { vacation_until: deadline.toISOString() });
        await history.logStatusGranted('vacation', target, pp.static, pp.name, reason, deadline.toISOString(), user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'Отпуск выдан (сайт)', `<@${target}> до ${dates.formatDateTime(deadline)}${reason ? ' — ' + reason : ''}`);
      return back + '?' + qs({ ok: 'Отпуск выдан.' });
    }
    if (pathName === '/u/vacation_revoke') {
      const passports = await passportsLib.getAllPassports(target);
      for (const pp of passports) {
        if (!pp.vacation_until) continue;
        await passportsLib.updatePassportFields(target, pp.static, { vacation_until: null });
        await history.logStatusRevoked('vacation', target, pp.static, pp.name, user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'Отпуск снят (сайт)', `<@${target}>`);
      return back + '?' + qs({ ok: 'Отпуск снят.' });
    }
    if (pathName === '/u/afk') {
      const date = dates.parseDateOnly(body.get('date') || '');
      if (!date) return back + '?' + qs({ err: 'Неверная дата (ДД.ММ.ГГГГ).' });
      const reason = (body.get('reason') || '').trim();
      const passports = await passportsLib.getAllPassports(target);
      for (const pp of passports) {
        await passportsLib.updatePassportFields(target, pp.static, { afk_since: dates.formatDateOnly(date) });
        await history.logStatusGranted('afk', target, pp.static, pp.name, reason, null, user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'AFK отмечен (сайт)', `<@${target}> с ${dates.formatDateOnly(date)}${reason ? ' — ' + reason : ''}`);
      return back + '?' + qs({ ok: 'AFK отмечен.' });
    }
    if (pathName === '/u/afk_clear') {
      const passports = await passportsLib.getAllPassports(target);
      for (const pp of passports) {
        if (!pp.afk_since) continue;
        await passportsLib.updatePassportFields(target, pp.static, { afk_since: null });
        await history.logStatusRevoked('afk', target, pp.static, pp.name, user.id).catch(() => {});
      }
      await hook('syncStatusRoles')(g, target);
      await hook('safeUpdateMembersList')(g);
      await webAudit(client, user, 'AFK снят (сайт)', `<@${target}>`);
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
    return back;
  }

  // ===== приём/отказ заявки на вступление (HR+) =====
  if (pathName === '/panel/app/accept' || pathName === '/panel/app/reject') {
    if (acc.rank < LEVELS.hr) return '/panel?tab=apps&' + qs({ err: 'Недостаточно прав.' });
    const id = parseInt(body.get('id'), 10) || 0;
    const app = await db.get('SELECT * FROM applications WHERE id = ?', [id]);
    if (!app || app.status !== 'pending') return '/panel?tab=apps&' + qs({ err: 'Заявка уже обработана.' });

    if (pathName === '/panel/app/reject') {
      const reason = (body.get('preset') || '').trim() || (body.get('reason') || '').trim() || 'Без указания причины';
      await db.run("UPDATE applications SET status='rejected', rejected_by=?, reject_reason=?, reviewed_at=? WHERE id=?", [user.id, reason, new Date().toISOString(), id]);
      await dmTo(client, app.discord_id, `❌ Ваша заявка на вступление отклонена. Причина: ${reason}`);
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
    if (acc.rank < LEVELS.hr) return '/panel?tab=queues&' + qs({ err: 'Недостаточно прав.' });
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
    await webAudit(client, user, 'Текст обновлён (сайт)', `${key} (${contentText.length} симв.)`);
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
    await webAudit(client, user, 'Переключатель фичи (сайт)', `${key} → ${body.get('on') === '1' ? 'вкл' : 'выкл'}`);
    return '/panel?tab=settings&' + qs({ ok: 'Готово.' });
  }

  // ===== настройки (Владелец) =====
  if (pathName === '/panel/setting/save') {
    if (acc.rank < LEVELS.owner) return '/panel?tab=settings&' + qs({ err: 'Недостаточно прав.' });
    const key = (body.get('key') || '').trim();
    if (!key) return '/panel?tab=settings&' + qs({ err: 'Пустой ключ.' });
    await db.setSetting(key, (body.get('value') || '').trim());
    await webAudit(client, user, 'Настройка изменена (сайт)', `${key} = ${(body.get('value') || '').slice(0, 100)}`);
    return '/panel?tab=settings&' + qs({ ok: 'Сохранено.' });
  }

  // ===== права команд (только havirys) =====
  if (pathName === '/panel/perm/save' || pathName === '/panel/perm/reset') {
    if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только для владельца-аккаунта.' });
    const name = body.get('name');
    if (!name || !(HOOKS.commandDefaultTiers || {})[name]) return '/panel?tab=perms&' + qs({ err: 'Неизвестная команда.' });
    if (pathName === '/panel/perm/reset') {
      await db.run('DELETE FROM command_permission_overrides WHERE command_name = ?', [name]);
      await webAudit(client, user, 'Право команды сброшено (сайт)', `/${name}`);
      return '/panel?tab=perms&' + qs({ ok: 'Сброшено к значению по умолчанию.' });
    }
    const tier = body.get('tier');
    if (!(HOOKS.tierLabels || {})[tier]) return '/panel?tab=perms&' + qs({ err: 'Неизвестный тир.' });
    await db.run(
      `INSERT INTO command_permission_overrides (command_name, tier) VALUES (?, ?)
       ON CONFLICT(command_name) DO UPDATE SET tier = excluded.tier`,
      [name, tier],
    );
    await webAudit(client, user, 'Право команды изменено (сайт)', `/${name} → ${tier}`);
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
    webAudit(client, user, 'Синхронизация бейдж-ролей (сайт)', 'запущено').catch(() => {});
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
    const startAt = dates.parseDeadline(body.get('start_at') || '') || (function () {
      const d = new Date(body.get('start_at'));
      return Number.isNaN(d.getTime()) ? null : d;
    })();
    if (!prize || winners < 1 || !durMs || !/^[0-9]+$/.test(channelId) || !startAt) {
      return '/panel?tab=giveaways&' + qs({ err: 'Проверьте поля (приз, победители, длительность, ID канала, дата старта).' });
    }
    await db.run(
      `INSERT INTO scheduled_giveaways (prize, winners_count, channel_id, duration_ms, required_role_id, min_role_id, start_at, host_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [prize, winners, channelId, durMs, roleId, minRoleId, startAt.toISOString(), user.id, new Date().toISOString()],
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
    return `/ticket/${tid}?` + qs({ ok: 'Отправлено.' });
  }

  // ===== проверка контракта (HR+) =====
  if (pathName === '/panel/contract/review') {
    if (acc.rank < LEVELS.hr) return '/panel?tab=contracts_check&' + qs({ err: 'Недостаточно прав.' });
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
      await webAudit(client, user, 'FAQ: добавлен гайд (сайт)', `${cat}: ${title}`);
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
      await webAudit(client, user, 'FAQ: удалён гайд (сайт)', `#${eid}`);
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
    await webAudit(client, user, 'Резервная копия БД (сайт)', dest || 'не удалось');
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
      await webAudit(client, user, 'Изменены название/тексты сайта', `brand=${(body.get('brand') || '').slice(0, 60)}`);
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
      await webAudit(client, user, 'Изменена тема сайта', `${n} цвет(ов)`);
      return '/panel?tab=admin&' + qs({ ok: 'Тема применена.' });
    }

    if (pathName === '/admin/theme_reset') {
      await db.run("DELETE FROM settings WHERE key LIKE 'site.color.%'");
      await loadSite(true);
      await webAudit(client, user, 'Сброшена тема сайта', '');
      return '/panel?tab=admin&' + qs({ ok: 'Цвета возвращены к стандартным.' });
    }

    if (pathName === '/admin/bot_nick') {
      if (!g) return '/panel?tab=admin&' + qs({ err: 'Бот недоступен.' });
      const nick = (body.get('nick') || '').trim().slice(0, 32);
      try {
        await g.members.me.setNickname(nick || null);
      } catch (e) { return '/panel?tab=admin&' + qs({ err: 'Не удалось: ' + e.message }); }
      await webAudit(client, user, 'Изменён ник бота на сервере', nick || '(сброшен)');
      return '/panel?tab=admin&' + qs({ ok: 'Ник бота обновлён.' });
    }

    if (pathName.startsWith('/admin/landing/')) {
      if (pathName === '/admin/landing/add') {
        const mx = await db.get('SELECT MAX(position) m FROM landing_blocks');
        await db.run('INSERT INTO landing_blocks (position, kind, title, content, updated_at) VALUES (?, ?, ?, ?, ?)',
          [(mx && mx.m != null ? mx.m : 0) + 1, ['text', 'buttons', 'cards'].includes(body.get('kind')) ? body.get('kind') : 'text', (body.get('title') || '').slice(0, 120), (body.get('content') || '').slice(0, 4000), new Date().toISOString()]);
        return '/panel?tab=landing&' + qs({ ok: 'Блок добавлен.' });
      }
      const bid = parseInt(body.get('id'), 10) || 0;
      const blk = await db.get('SELECT * FROM landing_blocks WHERE id = ?', [bid]);
      if (!blk) return '/panel?tab=landing&' + qs({ err: 'Блок не найден.' });
      if (pathName === '/admin/landing/save') {
        await db.run('UPDATE landing_blocks SET kind = ?, title = ?, content = ?, updated_at = ? WHERE id = ?',
          [['text', 'buttons', 'cards'].includes(body.get('kind')) ? body.get('kind') : blk.kind, (body.get('title') || '').slice(0, 120), (body.get('content') || '').slice(0, 4000), new Date().toISOString(), bid]);
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
      await webAudit(client, user, 'Переинициализация меню Discord (сайт)', '');
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
      await webAudit(client, user, 'Изменена роль Discord (сайт)', `${rid} → «${name}» ${color}`);
      return '/panel?tab=admin&' + qs({ ok: 'Роль обновлена.' });
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
      await webAudit(client, user, 'АВАРИЙНАЯ замена БД (сайт)', `${buf.length} байт записано в ${db.dbPath}. Требуется перезапуск бота.`);
      return '/tools?' + qs({ ok: 'Файл записан. Перезапустите бота, чтобы он перечитал базу.' });
    } catch (e) {
      return '/tools?' + qs({ err: 'Ошибка записи: ' + e.message });
    }
  }

  // ===== уведомления: прочитать всё =====
  if (pathName === '/notifications/read_all') {
    await db.run('UPDATE notifications SET read_at = ? WHERE discord_id = ? AND read_at IS NULL', [new Date().toISOString(), user.id]);
    return '/notifications?' + qs({ ok: 'Отмечено.' });
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

  // ===== пресеты темы + редактор каналов (havirys) =====
  if (pathName === '/admin/theme_preset') {
    if (user.id !== OWNER_ID) return '/panel?' + qs({ err: 'Только владелец-аккаунт.' });
    const PRESETS = {
      default: {},
      amoled: { bg: '#000000', panel: '#0a0a0a', panel2: '#141414', line: '#242424', text: '#f0f0f0', muted: '#8a8a8a', accent: '#4f8cff', accent2: '#79a9ff' },
      ocean: { bg: '#0b1622', panel: '#122232', panel2: '#18314a', line: '#20415f', text: '#e6f0f7', muted: '#8fa9bd', accent: '#1fb6c9', accent2: '#5fd3e2' },
      forest: { bg: '#0e1712', panel: '#15211a', panel2: '#1d2f24', line: '#2a3f31', text: '#e8f2ea', muted: '#94ab9c', accent: '#3fae6b', accent2: '#71cf97' },
      plum: { bg: '#160f1a', panel: '#1e1626', panel2: '#2a1f36', line: '#3a2c49', text: '#f1e9f5', muted: '#a996b3', accent: '#9b59d0', accent2: '#bd8ae0' },
    };
    const pr = PRESETS[body.get('preset')] || null;
    if (!pr) return '/panel?tab=admin&' + qs({ err: 'Неизвестный пресет.' });
    await db.run("DELETE FROM settings WHERE key LIKE 'site.color.%'");
    for (const [k, v] of Object.entries(pr)) await db.setSetting('site.color.' + k, v);
    await loadSite(true);
    await webAudit(client, user, 'Применён пресет темы', body.get('preset'));
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
    await webAudit(client, user, 'Импорт конфигурации сайта (сайт)', `${n} ключ(ей)`);
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
    await webAudit(client, user, 'Изменены ID каналов (сайт)', `${n} шт.`);
    return '/panel?tab=admin&' + qs({ ok: `Обновлено каналов: ${n}.` });
  }

  // ===== синхронизация видимости команд в Discord (havirys) =====
  if (pathName === '/panel/perm/sync') {
    if (user.id !== OWNER_ID) return '/panel?tab=perms&' + qs({ err: 'Только владелец-аккаунт.' });
    if (!g) return '/panel?tab=perms&' + qs({ err: 'Бот недоступен.' });
    hook('syncAllCommandPermissions')(g).catch((e) => console.error('[web] perm sync:', e.message));
    await webAudit(client, user, 'Синхронизация видимости команд (сайт)', '');
    return '/panel?tab=perms&' + qs({ ok: 'Синхронизация запущена (в фоне).' });
  }

  // ===== staff-заметки о участнике (HR+) =====
  if (pathName === '/u/note_add' || pathName === '/u/note_del') {
    if (acc.rank < LEVELS.hr) return '/people?' + qs({ err: 'Недостаточно прав.' });
    const target = (body.get('target') || '').trim();
    const back = '/u/' + target;
    if (pathName === '/u/note_add') {
      const text = (body.get('text') || '').trim().slice(0, 1000);
      if (!/^\d{5,25}$/.test(target) || !text) return back + '?' + qs({ err: 'Пусто.' });
      await db.run('INSERT INTO staff_notes (target_id, author_id, author_name, text, at) VALUES (?, ?, ?, ?, ?)', [target, user.id, uname, text, new Date().toISOString()]);
      await webAudit(client, user, 'Staff-заметка добавлена (сайт)', `<@${target}>`);
      return back + '?' + qs({ ok: 'Заметка добавлена.' });
    }
    await db.run('DELETE FROM staff_notes WHERE id = ?', [parseInt(body.get('id'), 10) || 0]);
    return back + '?' + qs({ ok: 'Заметка удалена.' });
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
      const L = (o) => layout({ notif, ...o }); // layout с колокольчиком

      if (path === '/healthz') return done(200, { 'Content-Type': 'text/plain' }, 'ok');

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
          await db.run('INSERT INTO web_logins (discord_id, ip, ua, at) VALUES (?, ?, ?, ?)', [me.id, ip, (req.headers['user-agent'] || '').slice(0, 300), now]).catch(() => {});
          const cookie = `fc_sess=${makeSession({ id: me.id, username: uname, avatar: me.avatar || '', sv: svRow ? (svRow.sess_ver || 0) : 0 })}; Path=/; Max-Age=${SESSION_DAYS * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`;
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
            <a class="btn" href="/">На главную</a>`;
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
        if (acc.rank < LEVELS.hr) {
          return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Панель управления доступна HR-Менеджеру и выше.</p><a class="btn" href="/me">Мой профиль</a>' }));
        }
        const tab = u.searchParams.get('tab') || 'overview';
        return html(200, L({ title: 'Панель управления', user, level: acc.level, wide: true, body: flash + await panelBody(client, acc, user, tab, pageNum, u.searchParams.get('table'), u.searchParams) }));
      }

      // ----- Аналитика / инструменты -----
      if ((path === '/dashboard' || path === '/leaderboards' || path === '/calendar' || path === '/search') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) return html(403, L({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для HR-Менеджера и выше</h1><a class="btn" href="/me">Мой профиль</a>' }));
        let bodyHtml;
        if (path === '/dashboard') bodyHtml = await dashboardBody(client);
        else if (path === '/leaderboards') bodyHtml = await leaderboardsBody(client);
        else if (path === '/calendar') bodyHtml = await calendarBody(client);
        else bodyHtml = await searchBody(client, u.searchParams.get('q'));
        return html(200, L({ title: 'Аналитика', user, level: acc.level, wide: true, body: flash + bodyHtml }));
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
        return html(200, L({ title: 'Уведомления', user, level: acc.level, body: flash + await notificationsBody(user) }));
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
        if (path === '/export/db.sqlite') {
          if (acc.rank < LEVELS.owner) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Только Владелец');
          try {
            const fs = require('fs');
            const buf = fs.readFileSync(db.dbPath);
            await webAudit(client, user, 'Скачивание БД (сайт)', `${buf.length} байт`);
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
            await webAudit(client, user, 'Экспорт архива .zip (сайт)', `${files.length} файлов, ${(zip.length / 1048576).toFixed(2)} МБ`);
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
