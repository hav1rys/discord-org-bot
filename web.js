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

const OWNER_ID = config.OWNER_USER_ID; // havirys — полный доступ, включая редактор БД

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
`;

function topbar(user, level) {
  const brand = `<a class="brand" href="/"><b>Freelance</b> Company</a>`;
  if (!user) {
    return `<div class="top"><div class="left"><a class="btn sm" href="/login">Войти через Discord</a></div><div class="right">${brand}</div></div>`;
  }
  const nav = ['<a href="/me">Мой профиль</a>'];
  if (LEVELS[level] < LEVELS.member) nav.push('<a href="/apply">Подать заявку</a>');
  if (LEVELS[level] >= LEVELS.hr) nav.push('<a href="/panel">Панель управления</a>');
  return `<div class="top">
    <div class="left nav">${nav.join('')}<a href="/logout">Выйти</a></div>
    <div class="right">${brand}</div>
  </div>`;
}

function layout(opts) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${STYLE}</style></head><body>
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
  const roleTags = acc.roleNames.length ? acc.roleNames.map((n) => `<span class="pill">${esc(n)}</span>`).join('') : '<span class="muted">нет ролей на сервере</span>';

  if (!p) {
    return `
      <h1>Личный кабинет</h1>
      <div class="card">
        <b>${esc(user.username)}</b> — вход выполнен, но вы <b>не состоите в организации</b>.
        <div class="muted" style="margin-top:6px">Уровень доступа: ${esc(acc.level)}. Роли на сервере: ${roleTags}</div>
      </div>
      <a class="btn" href="/apply">Подать заявку на вступление</a>`;
  }

  const passports = await passportsLib.getAllPassports(did);
  const range = contracts.getWeekRange(0);
  const week = await contracts.getUserWeekStats(did, range);
  const invRow = await db.get("SELECT COUNT(*) c FROM invitations WHERE inviter_discord_id = ? AND status='confirmed'", [did]);
  const passRows = passports.map((pp) => `<tr>
    <td>${esc(pp.name)}</td>
    <td><span class="pill">№ ${esc(pp.static)}</span></td>
    <td>${esc(roleName(client, pp.role_id))}</td>
    <td>${pp.vacation_until ? '🏖️ отпуск до ' + fmt(pp.vacation_until) : (pp.afk_since ? '💤 AFK с ' + esc(pp.afk_since) : '—')}</td>
  </tr>`).join('');

  return `
    <h1>${esc(p.name)}</h1>
    <div class="muted">Discord: ${esc(user.username)} · ID ${esc(did)} · вступил ${fmt(p.joined_at)}</div>
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
    <div class="card"><h2>Приглашения</h2>Подтверждённых за всё время: <b>${invRow ? invRow.c : 0}</b></div>
    ${memberForms(user)}`;
}

// ---------- Панель управления ----------
const PANEL_TABS = [
  ['overview', 'Обзор'],
  ['members', 'Участники'],
  ['contracts', 'Контракты'],
  ['invites', 'Приглашения'],
  ['giveaways', 'Розыгрыши'],
  ['blacklist', 'Чёрный список'],
  ['data', 'База данных'],
];

async function panelBody(client, acc, user, tab, pageNum, qtable) {
  const canData = acc.rank >= LEVELS.owner;
  const canBl = acc.rank >= LEVELS.deputy;
  const tabsHtml = PANEL_TABS
    .filter(([id]) => (id !== 'data' || canData) && (id !== 'blacklist' || canBl))
    .map(([id, label]) => `<a class="${id === tab ? 'on' : ''}" href="/panel?tab=${id}">${esc(label)}</a>`).join('');

  let body = '';
  if (tab === 'overview') body = await panelOverview();
  else if (tab === 'members') body = await panelMembers(client, pageNum);
  else if (tab === 'contracts') body = await panelContracts();
  else if (tab === 'invites') body = await panelInvites();
  else if (tab === 'giveaways') body = await panelGiveaways(client, acc, user);
  else if (tab === 'blacklist' && canBl) body = await panelBlacklist(client, user);
  else if (tab === 'data' && canData) body = await panelData(client, qtable || 'participants', pageNum, user);
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
      <td>${esc(p.name)}</td>
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
    const activeRows = active.map((g) => `<tr>
      <td>#${g.id} ${esc(g.prize)}</td>
      <td class="muted">${fmt(g.ends_at)}</td>
      <td>
        <form method="POST" action="/panel/giveaway/end" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><button class="btn ghost sm" type="submit">Завершить сейчас</button></form>
        <form method="POST" action="/panel/giveaway/cancel" style="display:inline">${csrfField(user)}<input type="hidden" name="id" value="${g.id}"><button class="btn ghost sm" type="submit">Отменить</button></form>
      </td>
    </tr>`).join('');
    manage = `
    <div class="card"><h2>Создать розыгрыш</h2>
      <form method="POST" action="/panel/giveaway/create" class="form">
        ${csrfField(user)}
        <label>Приз<input name="prize" required maxlength="200"></label>
        <label>Число победителей<input name="winners" type="number" min="1" max="50" value="1" required></label>
        <label>Длительность (например 30m, 1h, 2d, 1w)<input name="duration" required maxlength="10"></label>
        <label>ID канала для публикации<input name="channel_id" required pattern="[0-9]+" maxlength="25"></label>
        <label>ID обязательной роли (необязательно)<input name="role_id" pattern="[0-9]*" maxlength="25"></label>
        <button class="btn" type="submit">Создать и опубликовать</button>
      </form>
    </div>
    <div class="card"><h2>Активные розыгрыши</h2>
      <div class="tablewrap"><table><tr><th>Розыгрыш</th><th>Конец</th><th>Действия</th></tr>${activeRows || '<tr><td colspan="3">—</td></tr>'}</table></div>
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

async function panelData(client, table, pageNum, user) {
  const def = DATA_TABLES[table];
  if (!def) return '<div class="card">Неизвестная таблица.</div>';
  const [title, cols] = def;
  const canEdit = !!(user && user.id === OWNER_ID);
  const picker = Object.entries(DATA_TABLES)
    .map(([k, v]) => `<a class="${k === table ? 'on' : ''}" href="/panel?tab=data&table=${k}">${esc(v[0])}</a>`).join('');
  let total = 0;
  try {
    const t = await db.get(`SELECT COUNT(*) c FROM ${table}`);
    total = t ? t.c : 0;
  } catch (_) {}
  let rows = [];
  try {
    rows = await db.all(`SELECT rowid AS __rid, * FROM ${table} ORDER BY rowid DESC LIMIT ? OFFSET ?`, [PAGE_SIZE, pageNum * PAGE_SIZE]);
  } catch (e) {
    return `<div class="card">Ошибка чтения таблицы: ${esc(e.message)}</div>`;
  }
  const head = (canEdit ? '<th></th>' : '') + cols.map(([, label]) => `<th>${esc(label)}</th>`).join('');
  const trs = rows.map((r) => {
    const editCell = canEdit ? `<td><a class="btn ghost sm" href="/panel/row?table=${table}&pk=${encodeURIComponent(r.__rid)}">✏️</a></td>` : '';
    return '<tr>' + editCell + cols.map(([key]) => `<td>${cell(client, key, r[key])}</td>`).join('') + '</tr>';
  }).join('');
  const addBtn = canEdit ? `<a class="btn sm" href="/panel/row/new?table=${table}">➕ Добавить строку</a>` : '';
  return `
  <div class="tabs">${picker}</div>
  <div class="card"><h2>${esc(title)} — всего ${total}</h2>
    ${canEdit ? `<p class="muted" style="margin-bottom:10px">Режим редактирования (havirys): ✏️ — изменить строку. ${addBtn}</p>` : ''}
    <div class="tablewrap"><table><tr>${head}</tr>${trs || '<tr><td>—</td></tr>'}</table></div>
    ${pager(`/panel?tab=data&table=${table}`, pageNum, total)}
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
function applyBody(user) {
  return `
  <h1>Заявка на вступление</h1>
  <div class="card">
    <p class="muted">Заполните форму — заявка уйдёт HR-Менеджерам в Discord. Ответ придёт в личные сообщения от бота.</p>
    <form method="POST" action="/apply" class="form">
      ${csrfField(user)}
      <label>Имя Фамилия персонажа<input name="name" required maxlength="60"></label>
      <label>№ Паспорта (только цифры)<input name="static" required pattern="[0-9]+" maxlength="12"></label>
      <label>LVL персонажа<input name="lvl" type="number" min="1" max="100" required></label>
      <label>Навыки / опыт<textarea name="skills" rows="3" maxlength="600"></textarea></label>
      <label>Кто пригласил (необязательно)<input name="invited_by" maxlength="60"></label>
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

// ---------- Обработка POST ----------
async function handlePost(client, pathName, user, body, acc) {
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
    const invited = (body.get('invited_by') || '').trim();
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
    await webAudit(client, user, 'Заявка на вступление (сайт)', `#${app.id} — ${name}, № ${stat}, LVL ${lvl}`);
    return '/me?' + qs({ ok: 'Заявка отправлена на рассмотрение.' });
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
  if (pathName.startsWith('/panel/giveaway/')) {
    if (acc.rank < LEVELS.owner) return '/panel?tab=giveaways&' + qs({ err: 'Недостаточно прав.' });
    if (pathName === '/panel/giveaway/create') {
      const prize = (body.get('prize') || '').trim().slice(0, 200);
      const winners = parseInt(body.get('winners'), 10) || 0;
      const durMs = giveaways.parseDuration((body.get('duration') || '').trim());
      const channelId = (body.get('channel_id') || '').trim();
      const roleId = (body.get('role_id') || '').trim() || null;
      if (!prize || winners < 1 || !durMs || !/^[0-9]+$/.test(channelId)) return '/panel?tab=giveaways&' + qs({ err: 'Проверьте поля формы (приз, победители, длительность, ID канала).' });
      const endsAt = new Date(Date.now() + durMs);
      const gid = await giveaways.createGiveaway(channelId, prize, winners, user.id, endsAt.toISOString(), roleId, null);
      const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`🎉 ${prize}`)
        .setDescription(`Нажмите на кнопку ниже, чтобы участвовать!\nОрганизатор: <@${user.id}>${roleId ? `\nУсловие: только роль <@&${roleId}>` : ''}`)
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

  return '/';
}

// ---------- Сервер ----------
function start(client) {
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const done = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };
    const html = (code, body, extra = {}) => done(code, { 'Content-Type': 'text/html; charset=utf-8', ...extra }, body);
    const redirect = (loc, extra = {}) => done(302, { Location: loc, ...extra }, '');

    try {
      const u = new URL(req.url, baseUrl());
      const path = u.pathname;
      const user = readSession(req.headers.cookie);
      const pageNum = Math.max(0, parseInt(u.searchParams.get('page') || '0', 10) || 0);
      const flash = flashBanner(u);

      if (path === '/healthz') return done(200, { 'Content-Type': 'text/plain' }, 'ok');

      // ----- POST: все действия записи -----
      if (req.method === 'POST') {
        const acc = user ? await accessFor(client, user.id) : { rank: 0, level: 'guest' };
        const body = await readBody(req);
        const loc = await handlePost(client, path, user, body, acc);
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
          const cookie = `fc_sess=${makeSession({ id: me.id, username: uname, avatar: me.avatar || '' })}; Path=/; Max-Age=${SESSION_DAYS * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`;
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
        return html(200, layout({ title: 'Заявка на вступление', user, level, body: flash + applyBody(user) }));
      }

      if (path === '/me') {
        if (!user) return redirect('/login');
        const level = (await accessFor(client, user.id)).level;
        return html(200, layout({ title: 'Личный кабинет', user, level, body: flash + await meBody(client, user) }));
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
        return html(200, layout({ title: 'Панель управления', user, level: acc.level, wide: true, body: flash + await panelBody(client, acc, user, tab, pageNum, u.searchParams.get('table')) }));
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
