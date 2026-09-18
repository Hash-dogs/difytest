'use strict';

/**
 * 端到端验收（PLAN §11）。对着一个**正在运行的服务**跑：
 *
 *   npm start                                   # 另一个终端
 *   PFXT_PASSWORD=<启动横幅里打印的口令> npm run acceptance
 *
 * 可选环境变量：
 *   PFXT_BASE   服务地址，默认 http://127.0.0.1:3000
 *   PFXT_DB     数据库文件，默认 data/pfxt.db（匿名性结构检查要用）
 *
 * ⚠️ 会往库里写场次、选票、短码，并**清空演练数据**。请在测试库上跑，
 *    不要对着正式数据跑。
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.PFXT_BASE || 'http://127.0.0.1:3000';
const PASSWORD = process.env.PFXT_PASSWORD;
const DB_PATH = process.env.PFXT_DB || path.join(__dirname, '..', 'data', 'pfxt.db');

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

function checkAnonymity() {
  section('一、匿名性结构检查（直接读 db 文件）');

  if (!fs.existsSync(DB_PATH)) {
    check('数据库文件存在', false, DB_PATH);
    return;
  }
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });

  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const sqlOf = (t) =>
    (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t) || {}).sql || '';

  // ---- ballot：只允许一列、无时间戳 ----
  const ballotCols = cols('ballot');
  check('ballot 只有 ballot_id 一列', ballotCols.length === 1 && ballotCols[0] === 'ballot_id', ballotCols.join(','));
  check('ballot 没有任何时间戳列', !ballotCols.some((c) => /time|_at$|date/i.test(c)));

  // ---- score：列集合精确匹配，且不含 code / 时间戳 ----
  const scoreCols = cols('score').sort().join(',');
  check(
    'score 列集合严格等于 {ballot_id, round_id, dimension_id, value}',
    scoreCols === 'ballot_id,dimension_id,round_id,value',
    scoreCols
  );
  check('score 不含 code / createdAt', !cols('score').includes('code') && !cols('score').includes('created_at'));

  // ---- round_submission：列集合精确匹配、无 ballot_id ----
  const subCols = cols('round_submission').sort().join(',');
  check(
    'round_submission 列集合严格等于 {round_id, code, submitted_at}',
    subCols === 'code,round_id,submitted_at',
    subCols
  );
  check('round_submission 不含 ballot_id', !cols('round_submission').includes('ballot_id'));

  // ---- WITHOUT ROWID ----
  for (const t of ['ballot', 'score', 'round_submission']) {
    check(`${t} 建表语句含 WITHOUT ROWID`, /WITHOUT\s+ROWID/i.test(sqlOf(t)));
  }

  // ---- ballot_id 不得出现在其它表里 ----
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name);
  const leaky = tables
    .filter((t) => t !== 'ballot' && t !== 'score')
    .filter((t) => cols(t).includes('ballot_id'));
  check('除 ballot/score 外没有表带 ballot_id', leaky.length === 0, leaky.join(','));

  // ---- 不得存在指向 ballot 的外键 ----
  const fkToBallot = [];
  for (const t of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
      if (fk.table === 'ballot') fkToBallot.push(t);
    }
  }
  check('没有任何表建立指向 ballot 的外键', fkToBallot.length === 0, fkToBallot.join(','));

  // ---- 视图 / 触发器可以绕过上述所有检查 ----
  const extra = db.prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('view','trigger')`).all();
  check('库里没有 view / trigger', extra.length === 0, extra.map((e) => `${e.type}:${e.name}`).join(','));

  // ---- 一张票对应一条提交记录：多一张少一张都说明逻辑漏了 ----
  const nBallot = db.prepare('SELECT COUNT(*) AS n FROM ballot').get().n;
  const nSub = db.prepare('SELECT COUNT(*) AS n FROM round_submission').get().n;
  check('ballot 行数 == round_submission 行数（每场每码一张票）', nBallot === nSub, `${nBallot} vs ${nSub}`);

  db.close();
}

/* ============================ 二、管理员鉴权 ============================ */

async function checkAuth() {
  section('二、管理员鉴权');

  const wrong = await api('POST', '/api/admin/login', { password: PASSWORD + 'x' });
  check('错误口令 → 401', wrong.status === 401, String(wrong.status));

  const bare = await fetch(BASE + '/api/admin/rounds');
  check('未登录访问管理接口 → 401', bare.status === 401, String(bare.status));

  const login = await api('POST', '/api/admin/login', { password: PASSWORD });
  check('正确口令 → 200', login.status === 200, JSON.stringify(login.data));
  check('下发了会话 cookie', !!cookie);
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

  return { r1, r2 };
}

/* ============================ 六、计分与结果 ============================ */

async function checkResults(r1, r2) {
  section('六、计分与结果');

  const res = await api('GET', '/api/admin/results');
  check('结果接口可用', res.status === 200 && res.data.ok === true, JSON.stringify(res.data).slice(0, 160));

  const row1 = res.data.rows.find((r) => r.roundId === r1);
  const row2 = res.data.rows.find((r) => r.roundId === r2);

  check('第一场 n=2（有人弃权也不报错）', row1 && row1.n === 2, row1 && String(row1.n));
  check('第一场每个维度 keptCount=2（不去分）', dimensions.every((d) => row1.details[d.id].keptCount === 2));
  check('第一场没有 single 单元格', dimensions.every((d) => row1.details[d.id].single === false));
  check('第一场标记 thin', row1.thin === true);
  check('第一场不是 blank', row1.blank === false);

  check('第二场 n=1', row2 && row2.n === 1, row2 && String(row2.n));
  check('第二场每个维度 keptCount=1', dimensions.every((d) => row2.details[d.id].keptCount === 1));
  check('★ 单票单元格被标记 single（要如实告知）', dimensions.every((d) => row2.details[d.id].single === true));
  check('第二场标记 thin', row2.thin === true);

  check('缩放基准 L 是整数', Number.isSafeInteger(res.data.lcm), String(res.data.lcm));
  check('所有 u 都是安全整数', res.data.rows.filter((r) => !r.blank).every((r) => Number.isSafeInteger(r.u)));
  check('完整性交叉核对通过', res.data.integrity.ok === true, JSON.stringify(res.data.integrity));
  check('没有孤儿行', res.data.orphans === 0, String(res.data.orphans));

  // 每场每码一张票 → 上面两张场次共 3 张票
  const nBallot = res.data.rows.reduce((s, r) => s + r.n, 0);
  check('共 3 张选票', nBallot === 3, String(nBallot));

  // Excel 导出
  const xlsx = await fetch(BASE + '/api/admin/results.xlsx', { headers: { Cookie: cookie } });
  const buf = Buffer.from(await xlsx.arrayBuffer());
  check('xlsx 导出 → 200', xlsx.status === 200, String(xlsx.status));
  check('xlsx 是 ZIP 结构（PK 头）', buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b);
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
    await checkConfigAndRounds();
    await checkLogin();
    const { r1, r2 } = await checkMainFlow();
    await checkResults(r1, r2);
    await checkReopenAndReset(r1);
    await checkPhase();
    checkAnonymity();
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
