'use strict';

/**
 * 端到端验收（PLAN §11）。对着一个**正在运行的服务**跑：
 *
 *   npm start                                   # 另一个终端
 *   PFXT_PASSWORD=<启动横幅里打印的口令> npm run acceptance
 *
 * 可选环境变量：
 *   PFXT_BASE       服务地址，默认 http://127.0.0.1:3001（服务端若开了路径前缀会自动接上）
 *   PFXT_BASE_PATH  路径前缀；不设则用 src/net.js 里的默认值
 *   PFXT_TOKEN      请求头令牌；不设则用 src/net.js 里的默认值
 *   PFXT_DB         数据库文件，默认 data/pfxt.db（匿名性结构检查要用）
 *
 * 两道暗号都从 src/net.js 读（与服务端同源），所以不用手工同步 ——
 * 改了服务端的 PFXT_* 之后，验收跟着一起设同样的环境变量即可。
 *
 * ⚠️ 会往库里写场次、选票、短码，并**清空演练数据**。请在测试库上跑，
 *    不要对着正式数据跑。
 */

const fs = require('node:fs');
const path = require('node:path');

// 暗号（路径前缀 + 请求头令牌）与服务端同源取（src/net.js 读同样的环境变量），
// 避免两处各写一份而漂移 —— 跑验收的人不该还要手工同步一遍暗号
const { BASE_PATH, API_TOKEN, TOKEN_HEADER } = require('../src/net');
const PORT = process.env.PORT || 3001;
const BASE = process.env.PFXT_BASE || `http://127.0.0.1:${PORT}` + BASE_PATH;
const PASSWORD = process.env.PFXT_PASSWORD;
const DB_PATH = process.env.PFXT_DB || path.join(__dirname, '..', 'data', 'pfxt.db');

/** 服务端对 GET/HEAD 校验令牌头，本脚本所有直连 fetch 都得带上，否则一律 404 */
const TOKEN_HEADERS = API_TOKEN ? { [TOKEN_HEADER]: API_TOKEN } : {};

if (!PASSWORD) {
  console.error('缺少 PFXT_PASSWORD —— 请填启动横幅里打印的管理员口令。');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    failures.push(name);
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

let cookie = '';

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...TOKEN_HEADERS,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies[0].split(';')[0];

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应（例如 xlsx）保持空对象 */
  }
  return { status: res.status, data, res };
}

/* ============================ 零、前置探测 ============================ */

/**
 * 限流计数存在服务端**进程内存**里，而最后一节「登录限流」会故意把本机 IP 的额度用光。
 * 于是连续跑两次验收时，第二次的登录会全部被 429 挡掉，得到一堆看不懂的失败。
 * 这里先探一次，把原因直接说出来，而不是让人去猜。
 */
async function preflight() {
  // 先探「地址 + 令牌」这对配置。**必须用 GET** —— 服务端的请求头守卫只拦
  // GET/HEAD，拿 POST 去探是探不出令牌问题的（那边根本不受守卫管）。
  const reach = await fetch(BASE + '/api/admin/session', { headers: TOKEN_HEADERS });
  if (reach.status === 404) {
    console.error(
      `\n⚠️  GET ${BASE}/api/admin/session 返回 404 —— 地址或令牌跟服务端对不上。\n` +
        `    服务端当前形态：http://<主机>:${PORT}${BASE_PATH || '（无路径前缀）'}\n` +
        (API_TOKEN ? `    GET 还必须带请求头：${TOKEN_HEADER}: ${API_TOKEN}\n` : '') +
        '    本脚本按 src/net.js 的默认值拼，两边 PFXT_* 环境变量不一致时就会这样。\n'
    );
    process.exit(2);
  }

  const probe = await api('POST', '/api/v/login', { code: 'ZZZZZZZZ' });

  if (probe.status === 429) {
    console.error(
      '\n⚠️  本机 IP 的登录尝试额度已被用光 —— 多半是上一次验收跑完留下的。\n' +
        '    限流计数在服务端进程内存里，重启服务即可清零：\n' +
        '      停掉 npm start，重新起一次，再跑验收。\n'
    );
    process.exit(2);
  }
}

/* ============================ 一、匿名性结构检查 ============================ */

/**
 * ⚠️ 2026-09-18 起选票不再匿名：ballot 带 code 列，可以归属到具体登录码。
 * 这一节原本检查的是「两表无任何关联键」，现在改为检查「结构没被改坏 + 数据最小化」。
 * 旧的匿名约束在 git 提交 e51d91a 里可以查到。
 */
function checkSchema() {
  section('一、结构与数据最小化检查（直接读 db 文件）');

  if (!fs.existsSync(DB_PATH)) {
    check('数据库文件存在', false, DB_PATH);
    return;
  }
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });

  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const sqlOf = (t) =>
    (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t) || {}).sql || '';

  // ---- 三张表的列集合必须精确相等 ----
  check(
    'ballot 列集合严格等于 {ballot_id, code}',
    cols('ballot').sort().join(',') === 'ballot_id,code',
    cols('ballot').join(',')
  );
  check(
    'score 列集合严格等于 {ballot_id, round_id, dimension_id, value}',
    cols('score').sort().join(',') === 'ballot_id,dimension_id,round_id,value',
    cols('score').join(',')
  );
  check(
    'round_submission 列集合严格等于 {round_id, code, submitted_at}',
    cols('round_submission').sort().join(',') === 'code,round_id,submitted_at',
    cols('round_submission').join(',')
  );

  // ---- 数据最小化：选票里除 code 外不许有请求元数据 ----
  const meta = cols('ballot').filter((c) => !['ballot_id', 'code'].includes(c));
  check('ballot 除 ballot_id/code 外没有别的列', meta.length === 0, meta.join(','));
  check(
    'ballot 不记录 IP / User-Agent / 时间戳',
    !cols('ballot').some((c) => /(^|_)(ip|ua|agent|time|timestamp|created|updated|at)($|_)/i.test(c)),
    cols('ballot').join(',')
  );

  // ---- WITHOUT ROWID ----
  for (const t of ['ballot', 'score', 'round_submission']) {
    check(`${t} 建表语句含 WITHOUT ROWID`, /WITHOUT\s+ROWID/i.test(sqlOf(t)));
  }

  // ---- 视图 / 触发器可以绕过上述列集合检查 ----
  const extra = db.prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('view','trigger')`).all();
  check('库里没有 view / trigger', extra.length === 0, extra.map((e) => `${e.type}:${e.name}`).join(','));

  // ---- 一张票对应一条提交记录：多一张少一张都说明逻辑漏了 ----
  const nBallot = db.prepare('SELECT COUNT(*) AS n FROM ballot').get().n;
  const nSub = db.prepare('SELECT COUNT(*) AS n FROM round_submission').get().n;
  check('ballot 行数 == round_submission 行数（每场每码一张票）', nBallot === nSub, `${nBallot} vs ${nSub}`);

  // ---- ★ 新增：选票确实能归属到登录码，且归属结果与提交记录一致 ----
  const rows = db
    .prepare(
      `SELECT b.code AS ballot_code, s.round_id AS round_id, r.code AS sub_code
         FROM ballot b
         JOIN score s ON s.ballot_id = b.ballot_id
         LEFT JOIN round_submission r ON r.round_id = s.round_id AND r.code = b.code
        GROUP BY s.round_id, b.code`
    )
    .all();

  check('★ 每张选票都能归属到一个登录码', rows.length > 0 && rows.every((r) => !!r.ballot_code));
  check(
    '★ 选票的归属与该码的提交记录一一对应',
    rows.every((r) => r.sub_code === r.ballot_code),
    rows.filter((r) => r.sub_code !== r.ballot_code).length + ' 条对不上'
  );

  // ---- ★ 每个 (码, 场次) 的组合只有一张票，不会重复计 ----
  const dup = db
    .prepare(
      `SELECT b.code AS code, s.round_id AS rid, COUNT(DISTINCT b.ballot_id) AS n
         FROM ballot b JOIN score s ON s.ballot_id = b.ballot_id
        GROUP BY b.code, s.round_id HAVING n > 1`
    )
    .all();
  check('★ 同一个码在同一场不会有多张选票', dup.length === 0, JSON.stringify(dup));

  db.close();
}

/* ============================ 二、管理员鉴权 ============================ */

async function checkAuth() {
  section('二、管理员鉴权');

  const wrong = await api('POST', '/api/admin/login', { password: PASSWORD + 'x' });
  check('错误口令 → 401', wrong.status === 401, String(wrong.status));

  const bare = await fetch(BASE + '/api/admin/rounds', { headers: TOKEN_HEADERS });
  check('未登录访问管理接口 → 401', bare.status === 401, String(bare.status));

  const login = await api('POST', '/api/admin/login', { password: PASSWORD });
  check('正确口令 → 200', login.status === 200, JSON.stringify(login.data));
  check('下发了会话 cookie', !!cookie);

  // 会话 cookie 与一份「旧版本残留在 Path=/ 上的同名 cookie」并存时，必须仍然算已登录。
  // 现实中必然出现：cookie 不区分端口，改前缀前的部署在 :3000 上留过一份 Path=/ 的同名 cookie。
  // 早期写法「后者覆盖前者」会取到那份失效的旧 token —— 症状是登录返回 200 却立刻被踢回登录页。
  const dup = await fetch(BASE + '/api/admin/config', {
    headers: { ...TOKEN_HEADERS, Cookie: `pfxt_admin=EXPIRED_OLD_TOKEN; ${cookie}` },
  });
  check('同名 cookie 并存时仍认有效的那一份', dup.status === 200, String(dup.status));

  const onlyStale = await fetch(BASE + '/api/admin/config', {
    headers: { ...TOKEN_HEADERS, Cookie: 'pfxt_admin=EXPIRED_OLD_TOKEN' },
  });
  check('只有失效的旧 cookie → 仍然 401', onlyStale.status === 401, String(onlyStale.status));
}

/* ========================= 二·五、口令前缀把门（PLAN §4） ========================= */

/**
 * 前缀的意义是「扫描器发现不了这有个后台」，所以这里必须验证**不带前缀的
 * 应答与「路径不存在」完全一致** —— 一旦 404 的措辞不同（比如返回 JSON、
 * 或说「缺少前缀」），等于主动告诉对方前缀这回事，藏起来就白藏了。
 */
async function checkBasePath() {
  section('二·五、口令前缀');

  if (!BASE_PATH) {
    console.log('  · 未启用口令前缀（PFXT_BASE_PATH 为空），本节跳过');
    return;
  }

  const origin = BASE.slice(0, BASE.length - BASE_PATH.length);
  const unprefixed = [
    '/',
    '/admin',
    '/v',
    '/api/admin/rounds',
    '/api/v/login',
    '/admin.js',
    '/admin.css',
  ];

  let allClosed = true;
  let firstLeak = '';
  for (const p of unprefixed) {
    const res = await fetch(origin + p, { redirect: 'manual' });
    if (res.status !== 404) {
      allClosed = false;
      if (!firstLeak) firstLeak = `${p} → ${res.status}`;
    }
  }
  check('根路径下的旧地址全部 404（含页面与接口）', allClosed, firstLeak);

  // 404 的措辞必须一致，不能因为「少写前缀」而给出不一样的回应
  const rootBody = await (await fetch(origin + '/admin')).text();
  const bogusBody = await (await fetch(origin + '/this-path-never-exists')).text();
  check('未带前缀与随机路径的 404 响应体一致', rootBody === bogusBody, `${rootBody} / ${bogusBody}`);

  const withPrefix = await fetch(BASE + '/v', { headers: TOKEN_HEADERS });
  check('带前缀的入口页可访问', withPrefix.status === 200, String(withPrefix.status));

  const html = await withPrefix.text();
  check('入口页里的资源路径都带前缀', !/["']\/(common|vote|admin)\.(css|js)["']/.test(html));

  const adminRes = await fetch(BASE + '/admin', { headers: TOKEN_HEADERS });
  const adminHtml = await adminRes.text();
  check('后台页面可访问', adminRes.status === 200, String(adminRes.status));
  check('后台页面按前缀注入 window.PFXT_BASE', adminHtml.includes(`window.PFXT_BASE = '${BASE_PATH}'`));
}

/* ============================ 三、配置与场次控制 ============================ */

let codes = [];
let contestants = [];
let dimensions = [];

async function checkConfigAndRounds() {
  section('三、配置与场次控制');

  const cfg = await api('GET', '/api/admin/config');
  check('读取配置', cfg.data.ok === true, JSON.stringify(cfg.data).slice(0, 120));
  contestants = cfg.data.contestants;
  dimensions = cfg.data.dimensions;
  check('默认名单非空', contestants.length > 0);
  check('默认维度权重合计 100', dimensions.reduce((s, d) => s + d.weight, 0) === 100);

  // 先清掉上一次跑留下的场次，保证从干净状态开始
  await api('POST', '/api/admin/reset', { confirm: 'RESET' });

  const setCount = await api('PUT', '/api/admin/config', {
    activityName: cfg.data.activityName,
    judgeCount: 3,
    contestants: cfg.data.contestants,
    dimensions: cfg.data.dimensions,
  });
  check('设置评委人数', setCount.data.ok === true, JSON.stringify(setCount.data).slice(0, 120));
  check('评委人数已生效', setCount.data.judgeCount === 3, String(setCount.data.judgeCount));

  const tooMany = await api('PUT', '/api/admin/config', {
    activityName: cfg.data.activityName,
    judgeCount: 999,
    contestants: cfg.data.contestants,
    dimensions: cfg.data.dimensions,
  });
  check('评委人数超过上限 → 400', tooMany.status === 400, String(tooMany.status));

  const before = await api('GET', '/api/admin/rounds');
  check('还没开场', before.data.live === null && before.data.rounds.length === 0);

  // 生成短码
  const gen = await api('POST', '/api/admin/invites', { count: 3 });
  check('生成 3 个短码', Array.isArray(gen.data.created) && gen.data.created.length === 3);
  codes = gen.data.created;

  const tooFew = await api('POST', '/api/admin/invites', { count: 0 });
  check('生成数量非法 → 400', tooFew.status === 400);
}

/* ============================ 四、评委登录 ============================ */

async function checkLogin() {
  section('四、评委登录（统一入口 + 手输短码）');

  const bad = await api('POST', '/api/v/login', { code: 'ZZZZZZZZ' });
  check('不存在的短码 → 404', bad.status === 404, String(bad.status));

  const lower = await api('POST', '/api/v/login', { code: codes[0].toLowerCase() });
  check('小写输入也能登录，并回显大写', lower.status === 200 && lower.data.code === codes[0], JSON.stringify(lower.data));

  const spaced = await api('POST', '/api/v/login', { code: ' ' + codes[1] + ' ' });
  check('前后空格会被忽略', spaced.status === 200 && spaced.data.code === codes[1]);

  const dash = await api('POST', '/api/v/login', { code: codes[2].slice(0, 4) + '-' + codes[2].slice(4) });
  check('连字符会被忽略', dash.status === 200 && dash.data.code === codes[2]);

  const empty = await api('POST', '/api/v/login', { code: '' });
  check('空短码 → 400', empty.status === 400, String(empty.status));

  const state = await api('GET', `/api/v/${codes[0]}/state`);
  check('状态查询可用', state.data.ok === true);

  const nf = await api('GET', '/api/v/NOTACODE/state');
  check('未知短码的状态查询 → 404', nf.status === 404, String(nf.status));
}

/* ============================ 五、场次与打分主流程 ============================ */

async function checkMainFlow() {
  section('五、场次与打分主流程');

  const adv1 = await api('POST', '/api/admin/rounds/advance', {});
  check('开第一场', adv1.status === 200 && !!adv1.data.round, JSON.stringify(adv1.data));
  const r1 = adv1.data.round.roundId;

  // 未上场的演讲者姓名，用来做「响应体不含他人」的断言
  const otherNames = contestants.filter((c) => c.name !== adv1.data.round.name).map((c) => c.name);

  const s1 = await api('GET', `/api/v/${codes[0]}/state`);
  check('评委看到当前演讲者', s1.data.current.contestant.name === adv1.data.round.name);
  check('本场未提交', s1.data.current.submitted === false);

  // ★ 核心：响应体里不能出现其他演讲者的任何痕迹
  const rawState = JSON.stringify(s1.data);
  check(
    `★ /state 响应体不含其他演讲者姓名（${otherNames.join('、')}）`,
    otherNames.every((n) => !rawState.includes(n))
  );
  check('★ /state 不返回 contestants 数组', !('contestants' in s1.data));
  check('★ /state 不下发维度权重', s1.data.dimensions.every((d) => !('weight' in d)));

  // 载荷校验
  const scores = dimensions.map((d, i) => ({ dimensionId: d.id, value: (i % 5) + 1 }));

  const noRound = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: 9999, scores });
  check('roundId 不是当前场次 → 409', noRound.status === 409 && noRound.data.error === 'round_closed', JSON.stringify(noRound.data));

  const short = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: r1, scores: scores.slice(1) });
  check('少打一个维度 → 400', short.status === 400, String(short.status));

  const outOfRange = await api('POST', `/api/v/${codes[0]}/submit`, {
    roundId: r1,
    scores: scores.map((s, i) => (i === 0 ? { ...s, value: 9 } : s)),
  });
  check('分值 9 → 400', outOfRange.status === 400, String(outOfRange.status));

  const dupDim = await api('POST', `/api/v/${codes[0]}/submit`, {
    roundId: r1,
    scores: scores.map((s, i) => (i === 0 ? { ...s, dimensionId: scores[1].dimensionId } : s)),
  });
  check('重复维度 → 400', dupDim.status === 400, String(dupDim.status));

  // 正常提交
  const ok1 = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: r1, scores });
  check('提交本场', ok1.status === 200, JSON.stringify(ok1.data));

  const after = await api('GET', `/api/v/${codes[0]}/state`);
  check('提交后 submitted=true', after.data.current.submitted === true);

  const dup = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: r1, scores });
  check('重复提交同一场 → 409 already_submitted', dup.status === 409 && dup.data.error === 'already_submitted', JSON.stringify(dup.data));

  // 只交 2/3 就推进 —— 弃权
  await api('POST', `/api/v/${codes[1]}/submit`, { roundId: r1, scores });

  const adv2 = await api('POST', '/api/admin/rounds/advance', {});
  check('推进到第二场', adv2.status === 200 && adv2.data.round.roundId !== r1);
  const r2 = adv2.data.round.roundId;

  const stale = await api('POST', `/api/v/${codes[2]}/submit`, { roundId: r1, scores });
  check('用旧 roundId 提交 → 409 round_closed', stale.status === 409 && stale.data.error === 'round_closed', JSON.stringify(stale.data));

  const s3 = await api('GET', `/api/v/${codes[2]}/state`);
  check('未投票的评委直接进入新场次', s3.data.current.roundId === r2);
  check('看到的是第二位演讲者', s3.data.current.contestant.name === adv2.data.round.name);

  // 同一短码交第二场 → 产生第二张独立的选票
  const ok2 = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: r2, scores });
  check('同一短码可以交下一场', ok2.status === 200, JSON.stringify(ok2.data));

  // 场次总览
  const overview = await api('GET', '/api/admin/rounds');
  const o1 = overview.data.rounds.find((r) => r.roundId === r1);
  check('第一场已收 2 份', o1.submitted === 2, String(o1.submitted));
  check('第一场标记为薄数据（票数 ≤ 2）', o1.thin === true);
  check('评委人数是 3', overview.data.judgeCount === 3);
  check('未超员时没有告警', overview.data.anomalies.length === 0, JSON.stringify(overview.data.anomalies));

  // ---- ★ 回归：3 票去一高一低后只剩 1 票，但**不能**被标成「仅 1 票」 ----
  //   曾经的 bug：single = keptCount === 1，于是 3 位评委的场次每个格子都说「仅 1 票」，
  //   而票数明明有 3 张。判据必须是「实际收到的票数」。
  //
  //   ⚠️ 2026-09-18 改口径后，去分发生在**评委加权总分**层面而不是单个维度格，
  //      所以这些标记从「每个维度一份」变成了「每场一份」。
  const adv3 = await api('POST', '/api/admin/rounds/advance', {});
  const r3 = adv3.data.round.roundId;
  for (const c of codes) await api('POST', `/api/v/${c}/submit`, { roundId: r3, scores });

  const res3 = await api('GET', '/api/admin/results');
  const row3 = res3.data.rows.find((r) => r.roundId === r3);
  check('★ 3 位评委都交了的场次 n=3', row3 && row3.n === 3, row3 && String(row3.n));
  check('★ 3 票**不能**被标成「仅 1 票」', row3.trim.single === false, String(row3.trim.single));
  check('★ 3 票去分后剩 1 票要单独标记 trimmedToOne', row3.trim.trimmedToOne === true);
  check('★ 3 票的 keptCount 确实是 1（去分后只剩中间那位）', row3.trim.keptCount === 1);

  return { r1, r2, r3 };
}

/* ============================ 六、计分与结果 ============================ */

async function checkResults(r1, r2) {
  section('六、计分与结果');

  const res = await api('GET', '/api/admin/results');
  check('结果接口可用', res.status === 200 && res.data.ok === true, JSON.stringify(res.data).slice(0, 160));

  const row1 = res.data.rows.find((r) => r.roundId === r1);
  const row2 = res.data.rows.find((r) => r.roundId === r2);

  check('第一场 n=2（有人弃权也不报错）', row1 && row1.n === 2, row1 && String(row1.n));
  check('第一场 keptCount=2（票数不足 3，不去分）', row1.trim.keptCount === 2);
  check('第一场没有被标 single', row1.trim.single === false);
  check('第一场标记 thin', row1.thin === true);
  check('第一场不是 blank', row1.blank === false);

  check('第二场 n=1', row2 && row2.n === 1, row2 && String(row2.n));
  check('第二场 keptCount=1', row2.trim.keptCount === 1);
  check('★ 单票场次被标记 single（要如实告知）', row2.trim.single === true);
  check('第二场标记 thin', row2.thin === true);

  check('缩放基准 L 是整数', Number.isSafeInteger(res.data.lcm), String(res.data.lcm));
  check('缩放基准 Lraw 是整数', Number.isSafeInteger(res.data.lcmRaw), String(res.data.lcmRaw));
  check('所有 u 都是安全整数', res.data.rows.filter((r) => !r.blank).every((r) => Number.isSafeInteger(r.u)));
  check(
    '★ 最终得分是四舍五入到 2 位小数的整数刻度（score100）',
    res.data.rows
      .filter((r) => !r.blank)
      .every((r) => Number.isInteger(r.score100) && Math.abs(r.total * 100 - r.score100) < 1e-9)
  );
  check(
    '★ 每个非空场次都有名次和奖级',
    res.data.rows.filter((r) => !r.blank).every((r) => Number.isInteger(r.rank) && r.award),
    JSON.stringify(res.data.rows.map((r) => [r.name, r.rank, r.award]))
  );
  check('完整性交叉核对通过', res.data.integrity.ok === true, JSON.stringify(res.data.integrity));
  check('没有孤儿行', res.data.orphans === 0, String(res.data.orphans));
  check('没有残缺票', res.data.incomplete === 0, String(res.data.incomplete));

  // 每场每码一张票：各场的「实到票数」总和必须等于「已收份数」总和。
  // ⚠️ 别写死数字 —— 上面每加一场，这里的期望值就变了，写死只会得到一条假失败。
  const nBallot = res.data.rows.reduce((s, r) => s + r.n, 0);
  const nSubmitted = res.data.rows.reduce((s, r) => s + r.submitted, 0);
  check('总票数 == 各场已收份数之和', nBallot === nSubmitted, `${nBallot} vs ${nSubmitted}`);

  // Excel 导出
  const xlsx = await fetch(BASE + '/api/admin/results.xlsx', {
    headers: { ...TOKEN_HEADERS, Cookie: cookie },
  });
  const buf = Buffer.from(await xlsx.arrayBuffer());
  check('xlsx 导出 → 200', xlsx.status === 200, String(xlsx.status));
  check('xlsx 是 ZIP 结构（PK 头）', buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b);
}

/* ============================ 六之二、评委明细 ============================ */

/**
 * 选票带 code 之后的新能力：结果里能列出「每个登录码 × 每场 × 每个维度」的分。
 * 这一节同时充当回归保护 —— 它把这个能力钉死，谁把 code 列拿掉都会红。
 */
async function checkJudgeDetail() {
  section('六之二、评委明细（选票带登录码之后的能力）');

  const res = await api('GET', '/api/admin/results');
  const detail = res.data.judgeDetail;

  check('结果里带 judgeDetail', Array.isArray(detail), typeof detail);
  check('明细覆盖所有签发过的登录码', detail.length >= codes.length, `${detail.length} vs ${codes.length}`);
  check('明细按登录码排序且不重复', new Set(detail.map((d) => d.code)).size === detail.length);

  // 找一个真的交过的码，逐格核对它交的分与接口返回是否一致
  const submitted = detail.filter((d) => d.rounds.length > 0);
  check('至少有一个码带明细', submitted.length > 0);

  if (submitted.length) {
    const j = submitted[0];
    check('该码的明细里每个维度都有分', j.rounds.every((r) => Object.keys(r.scores).length > 0));

    const first = j.rounds[0];
    check('明细里的分数都在 1–5', Object.values(first.scores).every((v) => Number.isInteger(v) && v >= 1 && v <= 5));
    check('明细里的维度数等于配置的维度数', Object.keys(first.scores).length === dimensions.length);
    check('该场小计已算出', typeof first.total === 'number' && first.total > 0, String(first.total));

    // 手算核对：Σ(权重 × 分) ÷ 100
    const expect =
      dimensions.reduce((s, d) => s + d.weight * first.scores[d.id], 0) / 100;
    check('该场小计与手算一致', Math.abs(first.total - expect) < 1e-9, `${first.total} vs ${expect}`);
  }

  // 一次都没交的码也要出现在明细里，否则「谁完全没参与」就看不出来
  const idle = detail.filter((d) => d.rounds.length === 0);
  check('未提交过的码也列在明细中', detail.length === submitted.length + idle.length);

  // ---- 两份导出必须是**两份不同的报表** ----
  const grab = async (path) => {
    const r = await fetch(BASE + path, { headers: { ...TOKEN_HEADERS, Cookie: cookie } });
    const buf = Buffer.from(await r.arrayBuffer());
    const xml = buf.toString('utf8');
    return {
      status: r.status,
      isZip: buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b,
      sheets: [...xml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]),
      xml,
    };
  };

  const resultBook = await grab('/api/admin/results.xlsx');
  const detailBook = await grab('/api/admin/detail.xlsx');

  check('结果报表导出 → 200 且是 ZIP', resultBook.status === 200 && resultBook.isZip, String(resultBook.status));
  check('明细报表导出 → 200 且是 ZIP', detailBook.status === 200 && detailBook.isZip, String(detailBook.status));

  check('结果报表含汇总与计分说明', resultBook.sheets.includes('汇总') && resultBook.sheets.includes('计分说明'), resultBook.sheets.join(','));
  check(
    '★ 结果报表含「去分明细」（评委总分口径的审计留痕）',
    resultBook.sheets.includes('去分明细'),
    resultBook.sheets.join(',')
  );

  // 汇总表要突出名次与奖级，维度分挪到「维度明细」去 —— 这条钉住结果页那次改版
  const resultCells = [...resultBook.xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
  check('★ 汇总表有「奖级」列', resultCells.includes('奖级') || resultCells.includes('奖级（暂定）'));
  check(
    '★ 计分说明写的是「按每位评委的加权总分去分」，不再是逐格去分',
    resultCells.some((c) => c.includes('每位评委的加权总分')),
    resultCells.filter((c) => c.includes('加权总分')).slice(0, 2).join(' | ')
  );
  check(
    '★ 计分说明记录了同分顺位与奖级名额',
    resultCells.some((c) => c.includes('第五顺位')) && resultCells.some((c) => c.includes('一等奖 2 名')),
    resultCells.filter((c) => c.includes('顺位')).slice(0, 2).join(' | ')
  );
  check(
    '★ 明细报表不含汇总 / 维度明细 / 计分说明',
    !detailBook.sheets.some((n) => /汇总|维度明细|计分说明/.test(n)),
    detailBook.sheets.join(',')
  );

  // ---- ★ 明细报表：一位演讲者一张工作表 ----
  const roundCount = (await api('GET', '/api/admin/results')).data.rows.length;
  check('★ 明细报表的表数 == 演讲者数', detailBook.sheets.length === roundCount, `${detailBook.sheets.length} vs ${roundCount}`);
  check(
    '★ 每张工作表按「序号. 姓名」命名',
    detailBook.sheets.every((n) => /^\d+\. .+/.test(n)),
    detailBook.sheets.join(' | ')
  );
  check('★ 工作表名 ≤31 字符（Excel 硬限制）', detailBook.sheets.every((n) => n.length <= 31), detailBook.sheets.map((n) => n.length).join(','));
  check(
    '★ 工作表名不含 Excel 禁用字符 : \\ / ? * [ ]',
    detailBook.sheets.every((n) => !/[:\\/?*[\]]/.test(n)),
    detailBook.sheets.join(' | ')
  );
  check('★ 工作表名互不重复', new Set(detailBook.sheets).size === detailBook.sheets.length);

  // 每张表的表头必须是「登录码 + 逐维度 + 小计」，而不是只给个总数
  const headerCells = [...detailBook.xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
  check('★ 明细报表的表头含「登录码」', headerCells.includes('登录码'));
  check('★ 明细报表的表头含「小计」', headerCells.includes('小计'));
  check(
    '★ 明细报表的表头逐维度展开',
    dimensions.every((d) => headerCells.includes(d.name)),
    headerCells.slice(0, 8).join(' / ')
  );
  check('每张表底部有均分行', headerCells.filter((h) => h === '（均分）').length === roundCount, String(headerCells.filter((h) => h === '（均分）').length));
}

/* ============================ 七、重开与重置 ============================ */

async function checkReopenAndReset(r1) {
  section('七、重开一场与一键重置');

  const all = await api('GET', '/api/admin/rounds');
  const first = all.data.rounds.find((r) => r.roundId === r1);

  const reopen = await api('POST', `/api/admin/rounds/${r1}/reopen`, {});
  check('重开一场 → 200', reopen.status === 200, JSON.stringify(reopen.data));
  check('重开的是同一位演讲者', reopen.data.round.contestantId === first.contestantId);
  check('新场次的 seq 更大', reopen.data.round.seq > first.seq, `${reopen.data.round.seq} vs ${first.seq}`);

  const after = await api('GET', '/api/admin/rounds');
  check('同时只有一个 live 场次', after.data.rounds.filter((r) => r.status === 'live').length === 1);

  const res = await api('GET', '/api/admin/results');
  check('被重开顶掉的旧场次进入 superseded', res.data.superseded.some((s) => s.roundId === r1));
  check('旧场次不参与排名', !res.data.rows.some((r) => r.roundId === r1));

  const notFound = await api('POST', '/api/admin/rounds/99999/reopen', {});
  check('重开不存在的场次 → 404', notFound.status === 404, String(notFound.status));

  // 重置
  const noConfirm = await api('POST', '/api/admin/reset', {});
  check('重置需要二次确认', noConfirm.status === 400 && noConfirm.data.error === 'confirm_required');

  const wrongConfirm = await api('POST', '/api/admin/reset', { confirm: 'yes' });
  check('确认字面量不对 → 400', wrongConfirm.status === 400);

  const reset = await api('POST', '/api/admin/reset', { confirm: 'RESET' });
  check('一键重置成功', reset.data.ok === true, JSON.stringify(reset.data.cleared));
  check('场次已清空', reset.data.cleared.rounds > 0);

  const empty = await api('GET', '/api/admin/results');
  check('重置后数据不足', empty.data.insufficient === true);

  // 短码必须保留 —— 否则彩排完得到处重发
  const stillOk = await api('POST', '/api/v/login', { code: codes[0] });
  check('★ 重置后短码仍然有效', stillOk.status === 200, JSON.stringify(stillOk.data));
}

/* ============================ 八、封盘 ============================ */

async function checkPhase() {
  section('八、封盘与重新开放');

  await api('POST', '/api/admin/rounds/advance', {});
  const live = await api('GET', '/api/admin/rounds');
  const rid = live.data.live.roundId;
  const scores = dimensions.map((d) => ({ dimensionId: d.id, value: 3 }));

  await api('POST', '/api/admin/close', {});
  const closedState = await api('GET', `/api/v/${codes[0]}/state`);
  check('封盘后 /state 仍返回当前场次', closedState.data.current && closedState.data.current.roundId === rid);

  const closed = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: rid, scores });
  check('封盘后提交 → 409 closed', closed.status === 409 && closed.data.error === 'closed', JSON.stringify(closed.data));

  const noConfirm = await api('POST', '/api/admin/reopen', {});
  check('重新开放需要二次确认', noConfirm.status === 400);

  await api('POST', '/api/admin/reopen', { confirm: true });
  const reopened = await api('POST', `/api/v/${codes[0]}/submit`, { roundId: rid, scores });
  check('重新开放后同一场次仍可提交', reopened.status === 200, JSON.stringify(reopened.data));
}

/* ============================ 九、限流（必须放最后） ============================ */

async function checkRateLimit() {
  section('九、登录限流（放最后：会把本机 IP 的额度用光）');

  let hitLimit = false;
  let attempts = 0;
  for (let i = 0; i < 80; i += 1) {
    const r = await api('POST', '/api/v/login', { code: 'ZZZZZZZZ' });
    attempts += 1;
    if (r.status === 429) {
      hitLimit = true;
      break;
    }
  }
  check('连续错误登录最终被限流', hitLimit, `试了 ${attempts} 次仍未限流`);

  const blocked = await api('POST', '/api/v/login', { code: 'ZZZZZZZZ' });
  check('限流后仍返回 429', blocked.status === 429, String(blocked.status));
}

/* ============================ 主流程 ============================ */

(async () => {
  console.log(`验收目标：${BASE}`);
  console.log(`数据库：${DB_PATH}`);
  console.log('⚠️  会写入并清空演练数据，请勿对正式数据运行。');

  try {
    await preflight();
    await checkAuth();
    await checkBasePath();
    await checkConfigAndRounds();
    await checkLogin();
    const { r1, r2 } = await checkMainFlow();
    await checkResults(r1, r2);
    await checkReopenAndReset(r1);
    await checkPhase();
    await checkJudgeDetail();
    checkSchema();
    await checkRateLimit();
  } catch (err) {
    console.error('\n执行中断：', err);
    fail += 1;
  }

  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log('  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})();
