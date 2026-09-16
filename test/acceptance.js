'use strict';

/**
 * 验收脚本（PLAN §10）—— 对**正在运行**的服务跑一遍端到端检查。
 *
 *   node test/acceptance.js
 *   管理员口令从环境变量读：PFXT_PASSWORD=xxxx node test/acceptance.js
 *
 * 注意：会往库里写选票和链接，请在**测试库**上跑，不要对着正式数据跑。
 */

const path = require('node:path');
const Database = require('better-sqlite3');

const BASE = process.env.PFXT_BASE || 'http://127.0.0.1:3000';
const PASSWORD = process.env.PFXT_PASSWORD || '';
const DB_PATH = path.join(__dirname, '..', 'data', 'pfxt.db');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? `  —— ${detail}` : ''));
    console.log(`  ✖ ${name}${detail ? `  —— ${detail}` : ''}`);
  }
}

const eq = (name, actual, expected) =>
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------ HTTP 客户端 ------------------------------ */

let cookie = '';

async function req(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + pathname, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });

  for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const pair = raw.split(';')[0];
    if (pair.startsWith('pfxt_admin=')) cookie = pair;
  }

  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  return { status: res.status, body };
}

/* --------------------------------- 数据 --------------------------------- */

/** 确定性造分：第 b 张票、参赛者下标 ci、维度下标 di */
const scoreOf = (b, ci, di) => 1 + ((ci + di + b) % 5);

function buildScores(contestants, dimensions, ballotIndex) {
  const scores = [];
  contestants.forEach((c, ci) => {
    dimensions.forEach((d, di) => {
      scores.push({ contestantId: c.id, dimensionId: d.id, value: scoreOf(ballotIndex, ci, di) });
    });
  });
  return scores;
}

/* --------------------------------- 主流程 -------------------------------- */

async function main() {
  console.log('评委打分系统 —— 验收检查');
  console.log('目标：' + BASE);

  /* ---------- 匿名性：直接检查数据库文件（PLAN §10） ---------- */
  section('匿名性（直接读库文件）');

  const db = new Database(DB_PATH, { readonly: true });
  const ballotSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ballot'").get();
  const scoreSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='score'").get();
  const ballotCols = db.prepare('PRAGMA table_info(ballot)').all().map((c) => c.name);
  const scoreCols = db.prepare('PRAGMA table_info(score)').all().map((c) => c.name);

  check('ballot 表只有 ballot_id 一列', ballotCols.length === 1 && ballotCols[0] === 'ballot_id', `实际列：${ballotCols.join(', ')}`);
  check('ballot 表没有 code 列', !ballotCols.includes('code'));
  check('ballot 表没有任何时间戳列', !ballotCols.some((c) => /time|_at$|date/i.test(c)));
  check('score 表没有 code / 时间戳列', !scoreCols.some((c) => c === 'code' || /time|_at$/i.test(c)));
  check('ballot 建表语句含 WITHOUT ROWID', /WITHOUT\s+ROWID/i.test(ballotSql.sql));
  check('score 建表语句含 WITHOUT ROWID', /WITHOUT\s+ROWID/i.test(scoreSql.sql));

  // invite 与 ballot 之间不应有任何外键
  const fks = db.prepare('PRAGMA foreign_key_list(ballot)').all();
  check('ballot 表没有指向 invite 的外键', fks.length === 0);
  db.close();

  /* ---------- 鉴权 ---------- */
  section('管理端鉴权');

  if (!PASSWORD) {
    console.log('  ! 未提供 PFXT_PASSWORD，跳过登录相关检查。');
    console.log('    用法：PFXT_PASSWORD=你的口令 node test/acceptance.js');
    return finish();
  }

  const anon = await req('/api/admin/progress');
  eq('未登录访问管理接口被拒绝', anon.status, 401);

  const badLogin = await req('/api/admin/login', { method: 'POST', body: { password: 'definitely-wrong' } });
  eq('错误口令登录被拒绝', badLogin.status, 401);

  const login = await req('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  eq('正确口令登录成功', login.status, 200);

  const afterLogin = await req('/api/admin/progress');
  eq('登录后可访问管理接口', afterLogin.status, 200);

  /* ---------- 配置 ---------- */
  section('配置');

  const config = await req('/api/admin/config');
  eq('读取配置', config.status, 200);
  const contestants = config.body.contestants;
  const dimensions = config.body.dimensions;
  const expectedCells = contestants.length * dimensions.length;
  check(`参赛者 ${contestants.length} 位、维度 ${dimensions.length} 个（共 ${expectedCells} 个评分点）`, contestants.length > 0 && dimensions.length > 0);

  const weightTotal = dimensions.reduce((a, d) => a + d.weight, 0);
  eq('维度权重合计为 100', weightTotal, 100);

  const badWeights = await req('/api/admin/config', {
    method: 'PUT',
    body: {
      activityName: config.body.activityName,
      dimensions: dimensions.map((d) => ({ ...d, weight: 10 })),
      contestants,
    },
  });
  eq('权重合计不等于 100 时保存被拒绝', badWeights.status, 400);

  /* ---------- 生成链接 ---------- */
  section('投票链接');

  const gen = await req('/api/admin/invites', { method: 'POST', body: { count: 8 } });
  eq('批量生成 8 个链接', gen.status, 200);
  const codes = gen.body.created;
  eq('返回的短码数量正确', codes.length, 8);
  check('短码互不重复', new Set(codes).size === codes.length);

  const tooMany = await req('/api/admin/invites', { method: 'POST', body: { count: 0 } });
  eq('生成数量为 0 被拒绝', tooMany.status, 400);

  /* ---------- 作废 ---------- */
  section('作废');

  const revokeTarget = codes[7];
  const revoke = await req(`/api/admin/invites/${revokeTarget}/revoke`, { method: 'POST' });
  eq('作废一个未提交的链接', revoke.status, 200);

  const revokedData = await req(`/api/v/${revokeTarget}/data`);
  eq('作废的链接返回 410', revokedData.status, 410);

  const notFoundData = await req('/api/v/NOSUCHCODE/data');
  eq('不存在的短码返回 404', notFoundData.status, 404);

  /* ---------- opened 幂等（PLAN §9.7） ---------- */
  section('opened 状态幂等');

  const openedCode = codes[6];
  const page1 = await fetch(`${BASE}/v/${openedCode}`);
  eq('打开投票页返回 200', page1.status, 200);

  const afterOpen1 = await req('/api/admin/invites');
  const inv1 = afterOpen1.body.invites.find((i) => i.code === openedCode);
  eq('首次打开后状态变为 opened', inv1.status, 'opened');

  await new Promise((r) => setTimeout(r, 30));
  await fetch(`${BASE}/v/${openedCode}`); // 再打开一次

  const afterOpen2 = await req('/api/admin/invites');
  const inv2 = afterOpen2.body.invites.find((i) => i.code === openedCode);
  eq('重复打开不覆盖首次 opened_at', inv2.opened_at, inv1.opened_at);

  /* ---------- 提交校验 ---------- */
  section('提交校验');

  const c0 = codes[0];
  const partial = await req(`/api/v/${c0}/submit`, { method: 'POST', body: { scores: buildScores(contestants, dimensions, 0).slice(0, 5) } });
  eq('评分点数量不足时被拒绝', partial.status, 400);

  const outOfRange = await req(`/api/v/${c0}/submit`, {
    method: 'POST',
    body: {
      scores: buildScores(contestants, dimensions, 0).map((s, i) => (i === 0 ? { ...s, value: 9 } : s)),
    },
  });
  eq('分值超出 1–5 时被拒绝', outOfRange.status, 400);

  // 长度不变、但把最后一项换成第一项的副本 → 一项重复 + 一项遗漏
  const withDuplicate = buildScores(contestants, dimensions, 0);
  withDuplicate[withDuplicate.length - 1] = { ...withDuplicate[0] };
  const duplicate = await req(`/api/v/${c0}/submit`, { method: 'POST', body: { scores: withDuplicate } });
  eq('重复评分点被拒绝', duplicate.status, 400);

  /* ---------- 计分：一律去分 ---------- */
  section('计分：N = 5（一律去一高一低）');

  for (let b = 0; b < 5; b += 1) {
    const r = await req(`/api/v/${codes[b]}/submit`, {
      method: 'POST',
      body: { scores: buildScores(contestants, dimensions, b) },
    });
    eq(`第 ${b + 1} 张票提交成功`, r.status, 200);
  }

  const res5 = await req('/api/admin/results');
  eq('N = 5', res5.body.n, 5);
  eq('N = 5 时同样去分（保底规则已删除）', res5.body.trimmed, true);
  eq('N = 5 时 k = 3', res5.body.k, 3);

  // 手算核对：参赛者0 × 维度0，value = 1 + ((0+0+b) % 5)，b=0..4 → [1,2,3,4,5]
  // 排序后切首尾 → [2,3,4] = 9，9/3 = 3
  const row0 = res5.body.rows.find((r) => r.contestantId === contestants[0].id);
  const cell0 = row0.margins[dimensions[0].id];
  eq('手算核对 参赛者0 × 维度0 = 3.00', Number(cell0.toFixed(4)), 3);

  /* ---------- 计分：N=6 去分 ---------- */
  section('计分：N = 6（去一高一低）');

  const sixth = await req(`/api/v/${codes[5]}/submit`, {
    method: 'POST',
    body: { scores: buildScores(contestants, dimensions, 5) },
  });
  eq('第 6 张票提交成功', sixth.status, 200);

  const res6 = await req('/api/admin/results');
  eq('N = 6', res6.body.n, 6);
  eq('N = 6 时去分', res6.body.trimmed, true);
  eq('N = 6 时 k = 4', res6.body.k, 4);

  // 手算核对：b=0..5 → [1,2,3,4,5,1]，排序 [1,1,2,3,4,5]，切首尾 → [1,2,3,4] = 10，10/4 = 2.5
  const row0b = res6.body.rows.find((r) => r.contestantId === contestants[0].id);
  const cell0b = row0b.margins[dimensions[0].id];
  eq('手算核对 参赛者0 × 维度0 = 2.50', Number(cell0b.toFixed(4)), 2.5);

  // 加权总分 = U / (100 × k)，且 U = 总分 × 100 × k 必须是整数
  const uTimes100k = row0b.total * 100 * res6.body.k;
  check('总分 × 100 × k 为整数（排名用整数比较）', Math.abs(uTimes100k - Math.round(uTimes100k)) < 1e-9);

  check('名次已生成', res6.body.rows.every((r) => Number.isInteger(r.rank)));
  const ranks = res6.body.rows.map((r) => r.rank);
  check('名次从 1 开始且单调不减', ranks[0] === 1 && ranks.every((r, i) => i === 0 || r >= ranks[i - 1]));
  check('并列名次正确跳号', res6.body.rows.every((r, i, arr) => {
    if (i === 0) return true;
    const prev = arr[i - 1];
    return r.total === prev.total ? r.rank === prev.rank : r.rank === i + 1;
  }));

  /* ---------- 幂等 ---------- */
  section('提交幂等');

  const resubmit = await req(`/api/v/${codes[0]}/submit`, {
    method: 'POST',
    body: { scores: buildScores(contestants, dimensions, 0) },
  });
  eq('重复提交同一链接返回 409', resubmit.status, 409);
  eq('重复提交的错误码正确', resubmit.body.error, 'already_submitted');

  const afterResubmit = await req('/api/admin/results');
  eq('重复提交没有产生额外选票', afterResubmit.body.n, 6);

  /* ---------- 已提交链接不可作废 ---------- */
  section('已提交链接不可作废');

  const revokeSubmitted = await req(`/api/admin/invites/${codes[0]}/revoke`, { method: 'POST' });
  eq('作废已提交的链接返回 409', revokeSubmitted.status, 409);
  eq('错误码说明原因', revokeSubmitted.body.error, 'submitted_locked');

  /* ---------- 有提交后禁止增删 ---------- */
  section('有提交后禁止改参赛者/维度数量');

  const addOne = await req('/api/admin/config', {
    method: 'PUT',
    body: {
      activityName: config.body.activityName,
      dimensions,
      contestants: [...contestants, { id: null, name: '新增', project: '新增项目', intro: '' }],
    },
  });
  eq('有提交后新增参赛者被拒绝', addOne.status, 409);

  const dropOne = await req('/api/admin/config', {
    method: 'PUT',
    body: {
      activityName: config.body.activityName,
      dimensions,
      contestants: contestants.slice(0, -1),
    },
  });
  eq('有提交后删除参赛者被拒绝', dropOne.status, 409);

  const renameOk = await req('/api/admin/config', {
    method: 'PUT',
    body: { activityName: config.body.activityName, dimensions, contestants },
  });
  eq('有提交后仍可改名称/说明/权重', renameOk.status, 200);

  /* ---------- 封盘 ---------- */
  section('封盘');

  const close = await req('/api/admin/close', { method: 'POST' });
  eq('封盘成功', close.status, 200);

  const submitAfterClose = await req(`/api/v/${codes[6]}/submit`, {
    method: 'POST',
    body: { scores: buildScores(contestants, dimensions, 6) },
  });
  eq('封盘后提交被拒绝', submitAfterClose.status, 409);
  eq('封盘后错误码正确', submitAfterClose.body.error, 'closed');

  const resultsAfterClose = await req('/api/admin/results');
  eq('封盘不影响已提交选票的计票', resultsAfterClose.body.n, 6);
  eq('结果里 phase 为 closed', resultsAfterClose.body.phase, 'closed');

  const reopenNoConfirm = await req('/api/admin/reopen', { method: 'POST', body: {} });
  eq('重新开放缺少二次确认被拒绝', reopenNoConfirm.status, 400);

  const reopen = await req('/api/admin/reopen', { method: 'POST', body: { confirm: true } });
  eq('二次确认后重新开放成功', reopen.status, 200);

  /* ---------- 进度 ---------- */
  section('进度');

  const progress = await req('/api/admin/progress');
  eq('进度接口可用', progress.status, 200);
  const { counts, total } = progress.body;
  eq('已提交数与选票数一致', counts.submitted, 6);
  check('四种状态计数之和等于总数', counts.issued + counts.opened + counts.submitted + counts.revoked === total, `${JSON.stringify(counts)} vs ${total}`);
  check('作废数已统计', counts.revoked >= 1);

  /* ---------- 备份 ---------- */
  section('备份');

  const backup = await fetch(BASE + '/api/admin/backup', { headers: { Cookie: cookie }, redirect: 'manual' });
  eq('备份接口返回 200', backup.status, 200);
  const buf = Buffer.from(await backup.arrayBuffer());
  check('备份文件非空且是 SQLite 文件', buf.length > 0 && buf.subarray(0, 15).toString('utf8') === 'SQLite format 3');

  /* ---------- 固定入口 / 自助领取（二维码方案 B） ---------- */
  section('固定入口与自助领取');

  const entryPage = await fetch(`${BASE}/v`);
  eq('GET /v 返回引导页', entryPage.status, 200);

  const claim1 = await req('/api/v/claim', { method: 'POST', body: {} });
  eq('扫码领取成功', claim1.status, 200);
  check('领到 8 位短码', /^[A-Z0-9]{8}$/.test(claim1.body.code || ''), `实际：${claim1.body.code}`);

  const claim2 = await req('/api/v/claim', { method: 'POST', body: { token: claim1.body.code } });
  eq('同一浏览器再扫 → 复用同一个码', claim2.body.code, claim1.body.code);
  eq('复用标记正确', claim2.body.reused, true);

  const claim3 = await req('/api/v/claim', { method: 'POST', body: { token: 'NOSUCHXX' } });
  check('无效 token → 签发新码', claim3.body.code !== 'NOSUCHXX' && claim3.body.reused === false);

  // 关键：已提交的 token 绝不能被换成新的，否则重扫二维码就能再投一票
  const claimSubmitted = await req('/api/v/claim', { method: 'POST', body: { token: codes[0] } });
  eq('已提交的 token 原样返回（堵住重复投票）', claimSubmitted.body.code, codes[0]);
  eq('已提交的 token 标记为复用', claimSubmitted.body.reused, true);

  // 已作废的 token 同理：要让他看到「已作废」，而不是拿到一个能投票的新码
  const claimRevoked = await req('/api/v/claim', { method: 'POST', body: { token: revokeTarget } });
  eq('已作废的 token 原样返回', claimRevoked.body.code, revokeTarget);

  const qrRes = await req('/api/admin/qrcode.svg');
  eq('二维码接口返回 200', qrRes.status, 200);
  check('二维码是 SVG', typeof qrRes.body === 'string' && qrRes.body.startsWith('<svg'));

  const entryInfo = await req('/api/admin/entry');
  eq('入口地址接口可用', entryInfo.status, 200);
  check('入口地址以 /v 结尾', /\/v$/.test(entryInfo.body.preferred || ''), `实际：${entryInfo.body.preferred}`);

  finish();
}

function finish() {
  console.log('');
  console.log('────────────────────────────────────────');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log('');
    console.log('  失败清单：');
    for (const f of failures) console.log('   - ' + f);
  }
  console.log('────────────────────────────────────────');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n验收脚本异常终止：', err);
  process.exit(1);
});
