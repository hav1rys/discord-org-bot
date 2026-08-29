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
      const member = await guild.members.fetch(discordId);
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
  gap:14px;padding:12px 20px;background:rgba(15,16,19,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
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
h1{font-size:26px;line-height:1.25;margin-bottom:6px}
h2{font-size:16px;margin-bottom:12px;color:#cfcfd8}
.hero{background:linear-gradient(160deg,#1b1e2e,#141519 60%);border:1px solid var(--line);border-radius:18px;padding:34px 26px;margin:16px 0}
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
.badge.ok{color:var(--ok);border-color:#1f5c43}
.badge.bad{color:var(--bad);border-color:#5c2626}
.badge.warn{color:var(--warn);border-color:#5c4d1f}
.pill{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:2px 8px;font-size:12.5px;margin:2px 4px 2px 0}
.feat{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.feat .c{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:16px}
.feat .c h3{font-size:15px;margin-bottom:6px}
.feat .c p{color:var(--muted);font-size:13.5px}
.foot{margin-top:34px;color:#63636e;font-size:12.5px;text-align:center}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 4px}
.tabs a{padding:7px 12px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);font-weight:600;font-size:13px}
.tabs a.on{color:#fff;background:var(--accent);border-color:var(--accent)}
.pager{display:flex;gap:8px;align-items:center;margin-top:12px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:13px;color:var(--muted);max-height:280px;overflow:auto}
.form label{display:block;margin:10px 0;font-size:13.5px;color:#cfcfd8}
.form input,.form select,.form textarea{display:block;width:100%;margin-top:5px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:9px 11px;color:var(--text);font:inherit}
.form input:focus,.form select:focus,.form textarea:focus{outline:1px solid var(--accent);border-color:var(--accent)}
.form input[readonly]{opacity:.5}
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

function topbar(user, level) {
  const brand = `<a class="brand" href="/"><b>Freelance</b> Company</a>`;
  if (!user) {
    return `<div class="top"><div class="left">${THEME_TOGGLE}<a class="btn sm" href="/login">Войти через Discord</a></div><div class="right">${brand}</div></div>`;
  }
  const nav = ['<a href="/me">Мой профиль</a>'];
  if (LEVELS[level] < LEVELS.member) nav.push('<a href="/apply">Подать заявку</a>');
  if (LEVELS[level] >= LEVELS.member) nav.push('<a href="/people">Участники</a>');
  nav.push('<a href="/giveaways">Розыгрыши</a>');
  nav.push('<a href="/faq">FAQ</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/dashboard">Дашборд</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel">Панель</a>');
  return `<div class="top">
    <div class="left nav">${nav.join('')}<a href="/logout">Выйти</a></div>
    <div class="right">${THEME_TOGGLE}${brand}</div>
  </div>`;
}

function layout(opts) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${STYLE}</style><script>${CLIENT_SCRIPT}</script></head><body>
${topbar(opts.user, opts.level || 'guest')}
<div class="wrap${opts.wide ? ' wide' : ''}">${opts.body}
<div class="foot">${esc(config.SITE_BRAND)} · сайт работает на том же сервере, что и Discord-бот</div>
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
    webUsers: await c('SELECT COUNT(*) c FROM web_users'),
    weekLabel: contracts.formatWeekLabel(range),
  };
}

async function landingBody(st) {
  const inv = esc(config.SITE_DISCORD_INVITE);
  let ag = '';
  try {
    const row = await contentVersions.getLatestVersion('agitation');
    ag = (row ? row.content : content.DEFAULT_AGITATION) || '';
  } catch (_) { ag = content.DEFAULT_AGITATION; }
  return `
  <div class="hero">
    <h1>Организация «${esc(config.SITE_BRAND)}»</h1>
    <p>Выполнение контрактов на GTA5RP. Контракты от 50 векселей, возможность брать их самостоятельно, офис в Rockford HilIs ВС и помощь в прокачке навыков.</p>
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

  <div class="card">
    <h2>Преимущества</h2>
    <div class="feat">
      <div class="c"><h3>Контракты от 50 векселей</h3><p>Без x2. Берёшь сам, когда удобно.</p></div>
      <div class="c"><h3>Офис в Rockford HilIs ВС</h3><p>Вексели сдаются там же.</p></div>
      <div class="c"><h3>Помощь в прокачке</h3><p>Поддержка по навыкам и профессиям.</p></div>
      <div class="c"><h3>Наборы при активности</h3><p>Можно брать наборы контрактов при минимальном онлайне.</p></div>
    </div>
  </div>

  <div class="card">
    <h2>Как вступить</h2>
    <ol style="margin-left:18px;color:var(--muted)">
      <li>Зайти на Discord-сервер по <a href="${inv}" target="_blank" rel="noopener">приглашению</a>.</li>
      <li>В канале вступления нажать «Подать заявку» и заполнить форму (Имя Фамилия, паспорт, LVL, навыки).</li>
      <li>Дождаться решения HR — ответ придёт в личные сообщения от бота.</li>
    </ol>
    <p class="muted" style="margin-top:10px">Требования: 5+ LVL персонажа, минимальные навыки, минимальный онлайн в неделю.</p>
  </div>

  <div class="card">
    <h2>Текущая агитация</h2>
    <pre>${esc(ag).slice(0, 4000)}</pre>
  </div>`;
}

async function meBody(client, user) {
  const did = user.id;
  const acc = await accessFor(client, did);
  const p = await db.get('SELECT * FROM participants WHERE discord_id = ?', [did]);
  const av = await resolveAvatar(client, did, 96);
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

  const passports = await passportsLib.getAllPassports(did);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(did, range);
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [did]);
  const bs = await computeBadgesAndStreak(client, did, p, invRow ? invRow.c : 0);
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
      <div class="muted">Discord: ${esc(user.username)} · ID ${esc(did)} · вступил ${fmt(p.joined_at)} · <a href="/u/${esc(did)}">полный профиль</a></div>
    </div></div>
    <div class="card"><h2>Роли на сервере</h2>${roleTags}</div>
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
    ${memberForms(user)}`;
}

// ---------- Панель управления ----------
const PANEL_TABS = [
  ['overview', 'Обзор'],
  ['sla', 'SLA'],
  ['apps', 'Заявки'],
  ['queues', 'Очереди'],
  ['members', 'Участники'],
  ['contracts', 'Контракты'],
  ['invites', 'Приглашения'],
  ['giveaways', 'Розыгрыши'],
  ['blacklist', 'Чёрный список'],
  ['texts', 'Тексты'],
  ['broadcast', 'Рассылка'],
  ['settings', 'Настройки'],
  ['perms', 'Права команд'],
  ['data', 'База данных'],
];

async function panelBody(client, acc, user, tab, pageNum, qtable, sp) {
  const canData = acc.rank >= LEVELS.owner;
  const canBl = acc.rank >= LEVELS.deputy;
  const canOwner = acc.rank >= LEVELS.owner;
  const isHavirys = user && user.id === OWNER_ID;
  const vis = {
    blacklist: canBl, texts: canOwner, broadcast: canOwner, settings: canOwner,
    perms: isHavirys, data: canData,
  };
  const tabsHtml = PANEL_TABS
    .filter(([id]) => vis[id] === undefined || vis[id])
    .map(([id, label]) => `<a class="${id === tab ? 'on' : ''}" href="/panel?tab=${id}">${esc(label)}</a>`).join('');

  let body = '';
  if (tab === 'overview') body = await panelOverview();
  else if (tab === 'sla') body = await panelSla(client, user);
  else if (tab === 'apps') body = await panelApps(client, user);
  else if (tab === 'queues') body = await panelQueues(client, user);
  else if (tab === 'members') body = await panelMembers(client, pageNum);
  else if (tab === 'contracts') body = await panelContracts();
  else if (tab === 'invites') body = await panelInvites();
  else if (tab === 'giveaways') body = await panelGiveaways(client, acc, user);
  else if (tab === 'blacklist' && canBl) body = await panelBlacklist(client, user);
  else if (tab === 'texts' && canOwner) body = await panelTexts(user);
  else if (tab === 'broadcast' && canOwner) body = await panelBroadcast(user);
  else if (tab === 'settings' && canOwner) body = await panelSettings(user);
  else if (tab === 'perms' && isHavirys) body = await panelPerms(user);
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

async function panelMembers(client, pageNum) {
  const totalRow = await db.get('SELECT COUNT(*) c FROM participants');
  const total = totalRow ? totalRow.c : 0;
  const rows = await db.all('SELECT * FROM participants ORDER BY name LIMIT ? OFFSET ?', [PAGE_SIZE, pageNum * PAGE_SIZE]);
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
  return `<div class="card"><h2>Участники — всего ${total}</h2>
    <div class="tablewrap"><table>
      <tr><th>Имя Фамилия</th><th>Паспорта</th><th>Ранги</th><th>Контракты нед.</th><th>Статус</th><th>Вступил</th></tr>
      ${out.join('')}
    </table></div>
    ${pager('/panel?tab=members', pageNum, total)}
  </div>`;
}

async function panelContracts() {
  const all = await contracts.getAllTimeLeaderboard();
  const week = await contracts.getWeekLeaderboard(contracts.getWeekRange(0));
  const rowsAll = all.slice(0, 25).map((r, i) => `<tr><td>${i + 1}</td><td>&lt;@${esc(r.discord_id)}&gt;</td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  const rowsWeek = week.slice(0, 25).map((r, i) => `<tr><td>${i + 1}</td><td>&lt;@${esc(r.discord_id)}&gt;</td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  return `
  <div class="card"><h2>Топ за неделю (${esc(contracts.formatWeekLabel(contracts.getWeekRange(0)))})</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${rowsWeek || '<tr><td colspan="3">—</td></tr>'}</table></div></div>
  <div class="card"><h2>Топ за всё время</h2>
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Контракты</th></tr>${rowsAll || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
}

async function panelInvites() {
  const all = await invitations.getAllTimeLeaderboard();
  const week = await invitations.getWeekLeaderboard(contracts.getWeekRange(0));
  const rows = (arr) => arr.slice(0, 25).map((r, i) => `<tr><td>${i + 1}</td><td>&lt;@${esc(r.inviter_discord_id)}&gt;</td><td>${r.cnt}</td></tr>`).join('');
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
      const cnt = await giveaways.countEntries(g.id);
      activeRows.push(`<tr>
        <td>#${g.id} ${esc(g.prize)}</td>
        <td class="muted">${fmt(g.ends_at)}</td>
        <td>${cnt}</td>
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
      <td>${g.winners ? g.winners.split(',').filter(Boolean).map((w) => '&lt;@' + esc(w) + '&gt;').join(', ') : '—'}</td>
      <td><form method="POST" action="/panel/giveaway/reroll" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><button class="btn ghost sm" type="submit">🎲 Реролл</button></form></td>
    </tr>`).join('');
    const gwbl = await giveaways.getBlacklist();
    const gwblRows = gwbl.map((b) => `<tr><td>&lt;@${esc(b.discord_id)}&gt;</td><td>${esc(b.reason || '—')}</td>
      <td><form method="POST" action="/panel/gwbl/remove" style="display:inline">${csrfField(user)}<input type="hidden" name="did" value="${esc(b.discord_id)}"><button class="btn ghost sm" type="submit">убрать</button></form></td></tr>`).join('');
    const sched = await db.all("SELECT * FROM scheduled_giveaways WHERE status='pending' ORDER BY start_at ASC").catch(() => []);
    const schedRows = sched.map((s) => `<tr><td>${esc(s.prize)}</td><td class="muted">${fmt(s.start_at)}</td><td>${s.winners_count}</td>
      <td><form method="POST" action="/panel/giveaway/schedule_cancel" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${s.id}"><button class="btn ghost sm" type="submit">отменить</button></form></td></tr>`).join('');
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
    <td>${g.winners ? g.winners.split(',').filter(Boolean).map((w) => '&lt;@' + esc(w) + '&gt;').join(', ') : '—'}</td>
  </tr>`).join('');
  const wr = await giveaways.getEndedWinnersSince(since);
  const wc = new Map();
  for (const r of wr) for (const w of (r.winners || '').split(',').filter(Boolean)) wc.set(w, (wc.get(w) || 0) + 1);
  const top = [...wc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([w, n], i) => `<tr><td>${i + 1}</td><td>&lt;@${esc(w)}&gt;</td><td>${n}</td></tr>`).join('');
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
async function sessionFresh(user) {
  if (!user) return false;
  try {
    const row = await db.get('SELECT sess_ver FROM web_users WHERE discord_id = ?', [user.id]);
    return !row || (row.sess_ver || 0) === (user.sv || 0);
  } catch (_) { return true; }
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
      <button class="btn" type="submit">Отправить заявку</button>
    </form>
  </div>`;
}

function memberForms(user) {
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
  </div>`;
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
async function resolveAvatar(client, id, size = 96) {
  const g = guildOf(client);
  if (g) {
    try {
      const m = await g.members.fetch(id);
      return m.displayAvatarURL({ extension: 'png', size });
    } catch (_) {}
  }
  const wu = await db.get('SELECT avatar FROM web_users WHERE discord_id = ?', [id]).catch(() => null);
  return avatarUrl(id, wu && wu.avatar, size);
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
      const m = await g.members.fetch(targetId);
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

  const nickRows = nicks.map((n) => `<tr><td class="muted">${fmt(n.at)}</td><td>${esc(n.old_nick || '—')}</td><td>${esc(n.new_nick || '—')}</td><td class="muted">${n.changed_by && n.changed_by !== 'unknown' ? '&lt;@' + esc(n.changed_by) + '&gt;' : '—'}</td></tr>`).join('');
  const promoRows = promos.map((r) => `<tr><td class="muted">${fmt(r.at)}</td><td>${esc(r.action)}</td><td>${esc((r.details || '').slice(0, 200))}</td></tr>`).join('');
  const invitedByLine = invitedByRow
    ? `<div class="card"><h2>Пригласил</h2>&lt;@${esc(invitedByRow.inviter_discord_id)}&gt; · ${fmt(invitedByRow.joined_at)}</div>`
    : '';

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
  <div class="card"><h2>Статусы сейчас</h2>
    <div class="grid">${tile(onVac, 'в отпуске')}${tile(onAfk, 'AFK')}</div>
  </div>
  <p class="bar"><a href="/leaderboards">Лидерборды</a> · <a href="/calendar">Календарь отпусков</a> · <a href="/search">Поиск везде</a> · <a href="/audit">Аудит</a> · <a href="/tools">Экспорт и обслуживание</a> · <a href="/health">Здоровье системы</a> · <a href="/panel">Панель</a></p>`;
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

  const ctab = (arr) => arr.slice(0, 20).map((r, i) => `<tr><td>${i + 1}</td><td><a href="/u/${esc(r.discord_id)}">&lt;@${esc(r.discord_id)}&gt;</a></td><td>✅ ${r.fulfilled} / ❌ ${r.unfulfilled}</td></tr>`).join('');
  const itab = (arr) => arr.slice(0, 20).map((r, i) => `<tr><td>${i + 1}</td><td><a href="/u/${esc(r.inviter_discord_id)}">&lt;@${esc(r.inviter_discord_id)}&gt;</a></td><td>${r.cnt}</td></tr>`).join('');
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
    <div class="tablewrap"><table><tr><th>#</th><th>Discord</th><th>Побед</th></tr>${gwTop.map(([w, n], i) => `<tr><td>${i + 1}</td><td>&lt;@${esc(w)}&gt;</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</table></div></div>`;
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

async function auditBody(client, sp, pageNum) {
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
  return `
  <h1>Аудит</h1>
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
  <div class="card"><h2>ID ролей</h2><pre>${esc(rolesTxt)}</pre></div>
  <div class="card"><h2>ID каналов</h2><pre>${esc(chansTxt)}</pre></div>
  ${isOwnerTools ? `<div class="card"><h2>Загрузить базу (замена файла)</h2>
    <form method="POST" action="/panel/db/restore" class="form" onsubmit="return confirm('ЗАМЕНИТЬ рабочую базу данных содержимым из поля ниже? Это необратимо. Бот перечитает файл только после перезапуска.')">
      ${csrfField({ id: OWNER_ID })}
      <label>Base64 файла .sqlite<textarea name="b64" rows="4" required></textarea></label>
      <button class="btn" style="background:var(--bad)" type="submit">Заменить базу</button>
    </form>
    <p class="mini">Только для аварийного восстановления. Резервные копии бот кладёт на диск и в канал бэкапов.</p>
  </div>` : ''}`;
}

// ---------- Панель: новые вкладки ----------
async function panelSla(client, user) {
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
  for (const [table, title] of defs) {
    const rows = await db.all(`SELECT id, discord_id, discord_tag, assigned_to, created_at FROM ${table} WHERE status='pending' ORDER BY created_at ASC`).catch(() => []);
    if (!rows.length) continue;
    const trs = rows.map((r) => {
      const ageH = Math.floor((Date.now() - new Date(r.created_at)) / 3600000);
      const stale = (r.created_at || '') < cutoff;
      return `<tr style="${stale ? 'background:rgba(255,107,107,.10)' : ''}">
        <td>#${r.id}</td>
        <td><a href="/u/${esc(r.discord_id)}">${esc(r.discord_tag || r.discord_id)}</a></td>
        <td>${ageH} ч ${stale ? '<span class="badge bad">SLA</span>' : ''}</td>
        <td>${r.assigned_to ? '&lt;@' + esc(r.assigned_to) + '&gt;' : claimBtn(table, r.id)}</td>
      </tr>`;
    }).join('');
    blocks.push(`<div class="card"><h2>${esc(title)} (${rows.length})</h2><div class="tablewrap"><table><tr><th>#</th><th>Заявитель</th><th>Возраст</th><th>Ответственный</th></tr>${trs}</table></div></div>`);
  }
  const tickets = await db.all("SELECT id, subject, assigned_to, created_at FROM tickets WHERE status='open' ORDER BY created_at ASC").catch(() => []);
  if (tickets.length) {
    const trs = tickets.map((t) => {
      const ageH = Math.floor((Date.now() - new Date(t.created_at)) / 3600000);
      const stale = (t.created_at || '') < cutoff;
      return `<tr style="${stale ? 'background:rgba(255,107,107,.10)' : ''}"><td>#${t.id}</td><td>${esc(t.subject || '—')}</td><td>${ageH} ч ${stale ? '<span class="badge bad">SLA</span>' : ''}</td><td>${t.assigned_to ? '&lt;@' + esc(t.assigned_to) + '&gt;' : claimBtn('tickets', t.id)}</td></tr>`;
    }).join('');
    blocks.push(`<div class="card"><h2>Открытые тикеты (${tickets.length})</h2><div class="tablewrap"><table><tr><th>#</th><th>Тема</th><th>Возраст</th><th>Ответственный</th></tr>${trs}</table></div></div>`);
  }
  return `<div class="card"><h2>SLA — порог ${config.REVIEW_SLA_HOURS || 24} ч</h2><p class="mini">Красным подсвечено то, что висит дольше порога без решения.</p></div>${blocks.join('') || '<div class="card">Всё в пределах SLA 👍</div>'}`;
}

async function panelApps(client, user) {
  const rows = await db.all("SELECT * FROM applications WHERE status='pending' ORDER BY id ASC LIMIT 50");
  const presetSel = await rejectPresetSelect('application');
  const cards = [];
  for (const a of rows) {
    const comments = await db.all('SELECT * FROM application_comments WHERE application_id = ? ORDER BY id ASC', [a.id]).catch(() => []);
    const thread = comments.map((c) => `<div class="mini" style="border-left:2px solid var(--line);padding-left:8px;margin:4px 0"><b>${esc(c.author_name || c.author_id)}</b> · ${fmt(c.at)}<br>${esc(c.text)}</div>`).join('');
    cards.push(`<div class="card">
    <b>Заявка #${a.id}</b> — <a href="/u/${esc(a.discord_id)}">&lt;@${esc(a.discord_id)}&gt;</a> (${esc(a.discord_tag || '')})
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
  return `<div class="card"><h2>Заявки на вступление (${rows.length})</h2><p class="mini">Приём с сайта выполняет полный онбординг: роли, ник, профиль-канал, ЛС с правилами.</p></div>${cards.join('') || '<div class="card">Очередь пуста.</div>'}`;
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
async function panelQueues(client, user) {
  const out = [];
  const presetByKey = {};
  for (const key of Object.keys(QUEUE_DEFS)) presetByKey[key] = await rejectPresetSelect(key === 'hr_app' ? 'hr_application' : key);
  for (const [key, [table, title]] of Object.entries(QUEUE_DEFS)) {
    const st = key === 'codeword' ? "status='pending'" : "status='pending'";
    const rows = await db.all(`SELECT * FROM ${table} WHERE ${st} ORDER BY id ASC LIMIT 30`).catch(() => []);
    const cards = rows.map((r) => {
      let info = '';
      if (key === 'passport') info = `${esc(r.name)} · № ${esc(r.static)}`;
      else if (key === 'data_change') info = `№ ${esc(r.target_static)}: «${esc(r.old_name)}» → «${esc(r.new_name)}»`;
      else if (key === 'hr_app') info = `часов/нед: ${esc(r.hours_per_week)} · обучать готов: ${esc(r.training_ready)}`;
      else if (key === 'appeal') info = esc((r.text || '—').slice(0, 300));
      else if (key === 'codeword') info = `${esc(r.name)} · № ${esc(r.static)} · <a href="${esc(r.screenshot_url || r.message_url || '#')}" target="_blank" rel="noopener">скрин</a>`;
      return `<div class="card">
        <b>#${r.id}</b> — <a href="/u/${esc(r.discord_id)}">&lt;@${esc(r.discord_id)}&gt;</a> · ${fmt(r.created_at || r.submitted_at)}
        <div class="mini">${info}</div>
        <div class="bar">
          <form method="POST" action="/panel/queue/approve" style="display:inline">${csrfField(user)}<input type="hidden" name="q" value="${key}"><input type="hidden" name="id" value="${r.id}"><button class="btn sm" type="submit">✅ Одобрить</button></form>
          <form method="POST" action="/panel/queue/reject" style="display:inline">${csrfField(user)}<input type="hidden" name="q" value="${key}"><input type="hidden" name="id" value="${r.id}">${presetByKey[key] || ''}<input name="reason" placeholder="причина отказа" maxlength="200" style="max-width:180px"><button class="btn sm" style="background:var(--bad)" type="submit">❌</button></form>
        </div>
      </div>`;
    }).join('');
    out.push(`<div class="card"><h2>${esc(title)} (${rows.length})</h2></div>${cards || '<div class="card">Пусто.</div>'}`);
  }
  return out.join('');
}

async function panelTexts(user) {
  const keys = [['rules', 'Свод правил'], ['agitation', 'Агитация'], ['hr_info', 'HR-вакансия']];
  const parts = [];
  for (const [k, title] of keys) {
    let cur = '';
    try { const row = await contentVersions.getLatestVersion(k); cur = row ? row.content : ''; } catch (_) {}
    parts.push(`<div class="card"><h2>${esc(title)}</h2>
      <form method="POST" action="/panel/text/save" class="form">${csrfField(user)}<input type="hidden" name="key" value="${k}">
        <label>Текст<textarea name="content" rows="8" maxlength="6000">${esc(cur)}</textarea></label>
        <button class="btn" type="submit">Сохранить новую версию</button>
      </form></div>`);
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

async function panelSettings(user) {
  const rows = await db.all('SELECT key, value FROM settings ORDER BY key').catch(() => []);
  const list = rows.map((s) => `<form method="POST" action="/panel/setting/save" class="form" style="border-bottom:1px solid var(--line);padding-bottom:10px">
    ${csrfField(user)}<input type="hidden" name="key" value="${esc(s.key)}">
    <label>${esc(s.key)}<input name="value" value="${esc(s.value == null ? '' : s.value)}"></label>
    <button class="btn sm" type="submit">Сохранить</button>
  </form>`).join('');
  return `<div class="card"><h2>Настройки (settings)</h2>${list || '<p class="mini">Пока пусто.</p>'}
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
    <div class="tablewrap"><table><tr><th>Команда</th><th>Текущий тир</th><th>Изменить</th></tr>${rows}</table></div>
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
        <div class="mini" style="white-space:pre-wrap">${esc((e.content || '').slice(0, 3000))}</div>
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

async function giveawayPageBody(client, user, gid) {
  const gv = await giveaways.getGiveaway(gid);
  if (!gv) return '<div class="card">Розыгрыш не найден.</div><p><a href="/giveaways">← ко всем</a></p>';
  const cnt = await giveaways.countEntries(gv.id);
  const inside = await giveaways.hasEntry(gv.id, user.id);
  const ended = gv.status !== 'active';
  let note = '';
  const g = guildOf(client);
  if (!ended && g) {
    try {
      const m = await g.members.fetch(user.id);
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
    ${gv.winners ? `<p style="margin-top:8px">Победители: ${winnerIds.map((w) => '&lt;@' + esc(w) + '&gt;').join(', ')}</p>` : ''}
    ${note ? `<p class="mini" style="color:var(--bad);margin-top:8px">${note}</p>` : ''}
    ${canToggle ? `<form method="POST" action="/g/enter" style="margin-top:10px">${csrfField(user)}<input type="hidden" name="id" value="${gv.id}">
      <button class="btn" type="submit">${inside ? '❌ Выйти из розыгрыша' : '🎉 Участвовать'}</button></form>` : ''}
  </div>
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
  <div class="muted">${esc(TICKET_CAT_RU[t.category] || t.category || '')} · ${closed ? 'закрыт' : 'открыт'} · автор <a href="/u/${esc(t.opener_id)}">&lt;@${esc(t.opener_id)}&gt;</a></div>
  <div class="card">${msgsHtml}</div>
  ${closed ? '' : `<div class="card"><form method="POST" action="/ticket/post" class="form">${csrfField(user)}<input type="hidden" name="id" value="${t.id}">
    <label>Ваше сообщение<textarea name="text" rows="3" required maxlength="1800"></textarea></label>
    <button class="btn" type="submit">Отправить в тикет</button></form></div>`}
  <p><a href="/me">← в кабинет</a></p>`;
}

// ---------- Обработка POST ----------
async function handlePost(client, pathName, user, body, acc, cookieHeader) {
  if (!user) return '/login';
  if (!csrfOk(user, body.get('_csrf'))) return '/me?' + qs({ err: 'Сессия формы устарела — откройте форму заново.' });
  const g = guildOf(client);
  const uname = user.username || user.id;

  // ===== заявка на вступление =====
  if (pathName === '/apply') {
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

  // ===== аварийная замена БД (havirys) =====
  if (pathName === '/panel/db/restore') {
    if (user.id !== OWNER_ID) return '/tools?' + qs({ err: 'Только для владельца-аккаунта.' });
    const b64 = (body.get('b64') || '').trim();
    if (b64.length < 100) return '/tools?' + qs({ err: 'Похоже, файл не вставлен.' });
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3 ') return '/tools?' + qs({ err: 'Это не файл SQLite.' });
      const fs = require('fs');
      fs.writeFileSync(db.dbPath + '.incoming', buf);
      fs.renameSync(db.dbPath + '.incoming', db.dbPath);
      await webAudit(client, user, 'АВАРИЙНАЯ замена БД (сайт)', `${buf.length} байт записано в ${db.dbPath}. Требуется перезапуск бота.`);
      return '/tools?' + qs({ ok: 'Файл записан. Перезапустите бота, чтобы он перечитал базу.' });
    } catch (e) {
      return '/tools?' + qs({ err: 'Ошибка записи: ' + e.message });
    }
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

      if (path === '/healthz') return done(200, { 'Content-Type': 'text/plain' }, 'ok');

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
        return html(200, layout({ title: config.SITE_BRAND, user, level, body: flash + await landingBody(await orgStats()) }));
      }

      if (path === '/login') {
        if (!process.env.CLIENT_ID) return html(500, layout({ title: 'Ошибка', body: '<h1>CLIENT_ID не задан</h1>' }));
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
          return html(502, layout({ title: 'Ошибка входа', body: `<h1>Не удалось войти через Discord</h1><p class="muted">${esc(err.message)}</p><a class="btn" href="/">На главную</a>` }));
        }
      }

      if (path === '/apply' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const level = (await accessFor(client, user.id)).level;
        if (await db.get('SELECT id FROM participants WHERE discord_id = ?', [user.id])) return redirect('/me');
        return html(200, layout({ title: 'Заявка на вступление', user, level, body: flash + applyBody(user, getCookie(req.headers.cookie, 'fc_ref')) }));
      }

      if (path === '/me') {
        if (!user) return redirect('/login');
        const level = (await accessFor(client, user.id)).level;
        return html(200, layout({ title: 'Личный кабинет', user, level, body: flash + await meBody(client, user) }));
      }

      if (path === '/people' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ только для участников</h1><a class="btn" href="/apply">Подать заявку</a>' }));
        return html(200, layout({ title: 'Участники', user, level: acc.level, wide: true, body: flash + await peopleBody(client, acc, u.searchParams.get('q'), pageNum, user) }));
      }

      if (path.startsWith('/u/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.member) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ только для участников</h1><a class="btn" href="/apply">Подать заявку</a>' }));
        return html(200, layout({ title: 'Профиль', user, level: acc.level, wide: true, body: flash + await profileBody(client, user, acc, decodeURIComponent(path.slice(3))) }));
      }

      if (path === '/panel/row' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (user.id !== OWNER_ID) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Редактор БД доступен только владельцу (havirys).</p>' }));
        return html(200, layout({ title: 'Правка строки', user, level: acc.level, wide: true, body: flash + await rowEditBody(client, user, u.searchParams.get('table'), u.searchParams.get('pk')) }));
      }

      if (path === '/panel/row/new' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (user.id !== OWNER_ID) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Редактор БД доступен только владельцу (havirys).</p>' }));
        return html(200, layout({ title: 'Новая строка', user, level: acc.level, wide: true, body: flash + await rowNewBody(client, user, u.searchParams.get('table')) }));
      }

      if (path === '/panel') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) {
          return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Доступ запрещён</h1><p class="muted">Панель управления доступна HR-Менеджеру и выше.</p><a class="btn" href="/me">Мой профиль</a>' }));
        }
        const tab = u.searchParams.get('tab') || 'overview';
        return html(200, layout({ title: 'Панель управления', user, level: acc.level, wide: true, body: flash + await panelBody(client, acc, user, tab, pageNum, u.searchParams.get('table'), u.searchParams) }));
      }

      // ----- Аналитика / инструменты -----
      if ((path === '/dashboard' || path === '/leaderboards' || path === '/calendar' || path === '/search') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.hr) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Раздел для HR-Менеджера и выше</h1><a class="btn" href="/me">Мой профиль</a>' }));
        let bodyHtml;
        if (path === '/dashboard') bodyHtml = await dashboardBody(client);
        else if (path === '/leaderboards') bodyHtml = await leaderboardsBody(client);
        else if (path === '/calendar') bodyHtml = await calendarBody(client);
        else bodyHtml = await searchBody(client, u.searchParams.get('q'));
        return html(200, layout({ title: 'Аналитика', user, level: acc.level, wide: true, body: flash + bodyHtml }));
      }

      if (path === '/audit' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.deputy) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Аудит — Зам. Владелец и выше</h1>' }));
        return html(200, layout({ title: 'Аудит', user, level: acc.level, wide: true, body: flash + await auditBody(client, u.searchParams, pageNum) }));
      }

      if (path === '/tools' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.owner) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Инструменты — Admin / Владелец</h1>' }));
        return html(200, layout({ title: 'Инструменты', user, level: acc.level, wide: true, body: flash + await toolsBody(client, acc, user) }));
      }

      if (path === '/health' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        if (acc.rank < LEVELS.owner) return html(403, layout({ title: 'Нет доступа', user, level: acc.level, body: '<h1>Только для Владельца</h1>' }));
        return html(200, layout({ title: 'Здоровье системы', user, level: acc.level, wide: true, body: flash + await healthBody(client) }));
      }

      if (path === '/faq' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        return html(200, layout({ title: 'FAQ', user, level: acc.level, wide: true, body: flash + await faqBody(client, acc, user) }));
      }

      if (path === '/giveaways' && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        return html(200, layout({ title: 'Розыгрыши', user, level: acc.level, wide: true, body: flash + await giveawaysPublicBody(client) }));
      }

      if (path.startsWith('/g/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        const gid = parseInt(decodeURIComponent(path.slice(3)), 10) || 0;
        return html(200, layout({ title: 'Розыгрыш', user, level: acc.level, wide: true, body: flash + await giveawayPageBody(client, user, gid) }));
      }

      if (path.startsWith('/ticket/') && req.method === 'GET') {
        if (!user) return redirect('/login');
        const acc = await accessFor(client, user.id);
        const tid = parseInt(decodeURIComponent(path.slice(8)), 10) || 0;
        return html(200, layout({ title: 'Тикет', user, level: acc.level, wide: true, body: flash + await ticketPageBody(client, user, acc, tid) }));
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
        return done(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
      }

      return html(404, layout({ title: '404', body: '<h1>404</h1><a class="btn" href="/">На главную</a>' }));
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
