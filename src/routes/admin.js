'use strict';

/**
 * 管理端路由（PLAN §6.2）—— 口令鉴权。
 * 会话存在内存里：进程重启即全部登出（一次性活动场景，够用且不可被伪造）。
 */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DB_PATH, DATA_DIR, getSetting, setSetting, readConfig } = require('../db');
const { verifyPassword } = require('../seed');
const { computeResults, pickEffectiveRounds, MAX_JUDGES } = require('../scoring');
const { randomCode } = require('../codes');
const { entryUrls } = require('../net');
const { buildXlsx } = require('../xlsx');
const rounds = require('../rounds');
const qrcode = require('qrcode-generator');

const router = express.Router();

const SESSION_COOKIE = 'pfxt_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_INVITES_PER_BATCH = 500;
const PORT = Number(process.env.PORT) || 3000;

/* ------------------------------- 会话 ------------------------------- */

const sessions = new Map(); // token -> 过期时间戳

function issueSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized', message: '请先登录。' });
  }
  next();
}

/* ----------------------------- 登录限流 ----------------------------- */

const loginAttempts = new Map(); // ip -> { count, firstAt }
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) loginAttempts.set(ip, { count: 1, firstAt: now });
  else rec.count += 1;
}

/* ------------------------------ 语句 ------------------------------- */

const selectInvite = db.prepare('SELECT code, created_at, revoked FROM invite WHERE code = ?');
// PLAN §9：submitted_at 列已不存在 —— 提交是「每场一次」的，改由 round_submission 回答
const listInvites = db.prepare(`
  SELECT i.code, i.created_at, i.revoked,
         (SELECT COUNT(*)        FROM round_submission s WHERE s.code = i.code) AS rounds_submitted,
         (SELECT MAX(s.submitted_at) FROM round_submission s WHERE s.code = i.code) AS last_submitted_at
    FROM invite i
   ORDER BY i.created_at, i.code`);
const insertInvite = db.prepare('INSERT INTO invite (code, created_at) VALUES (?, ?)');
const revokeInvite = db.prepare('UPDATE invite SET revoked = 1 WHERE code = ?');
const countRoundsForCode = db.prepare('SELECT COUNT(*) AS n FROM round_submission WHERE code = ?');
const countRoundsForContestant = db.prepare('SELECT COUNT(*) AS n FROM round WHERE contestant_id = ?');

const updateContestant = db.prepare('UPDATE contestant SET seq = ?, name = ?, project = ?, intro = ? WHERE id = ?');
const insertContestant = db.prepare('INSERT INTO contestant (seq, name, project, intro) VALUES (?, ?, ?, ?)');
const deleteContestant = db.prepare('DELETE FROM contestant WHERE id = ?');
const selectContestantIds = db.prepare('SELECT id FROM contestant');

const updateDimension = db.prepare('UPDATE dimension SET seq = ?, name = ?, weight = ?, detail = ? WHERE id = ?');
const insertDimension = db.prepare('INSERT INTO dimension (seq, name, weight, detail) VALUES (?, ?, ?, ?)');
const deleteDimension = db.prepare('DELETE FROM dimension WHERE id = ?');
const selectDimensionIds = db.prepare('SELECT id FROM dimension');

const contestantIds = () => selectContestantIds.all().map((r) => r.id);
const dimensionIds = () => selectDimensionIds.all().map((r) => r.id);

const countCodes = db.prepare('SELECT COUNT(*) AS n FROM invite');
const countRevokedCodes = db.prepare('SELECT COUNT(*) AS n FROM invite WHERE revoked = 1');
const countCodesThatSubmitted = db.prepare('SELECT COUNT(DISTINCT code) AS n FROM round_submission');

/* ----------------------------- 工具 ------------------------------- */

const bad = (res, message, status = 400, error = 'invalid_request') =>
  res.status(status).json({ ok: false, error, message });

/* ------------------------------ 登录 ------------------------------- */

router.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) {
    return bad(res, '尝试次数过多，请 5 分钟后再试。', 429, 'too_many_attempts');
  }

  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !password) return bad(res, '请输入口令。');

  const stored = getSetting('admin_password_hash');
  if (!stored || !verifyPassword(password, stored)) {
    noteFailure(ip);
    return bad(res, '口令不正确。', 401, 'bad_credentials');
  }

  loginAttempts.delete(ip);
  const token = issueSession();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

router.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/api/admin/session', (req, res) => res.json({ ok: true, authed: isAuthed(req) }));

/* ------------------------------ 配置 ------------------------------- */

router.get('/api/admin/config', requireAdmin, (req, res) => {
  const config = readConfig();
  res.json({
    ok: true,
    ...config,
    // 开赛后维度与权重就锁死了（PLAN §8.2），前端据此禁用对应输入框
    started: rounds.hasAnyRound(),
  });
});

router.put('/api/admin/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const activityName = typeof body.activityName === 'string' ? body.activityName.trim() : '';
  const inContestants = Array.isArray(body.contestants) ? body.contestants : null;
  const inDimensions = Array.isArray(body.dimensions) ? body.dimensions : null;

  // 评委人数是「已收 X / N」的分母。短码是后台批量签发、一对一发放的，
  // 无法从库里反推真实评委数，所以必须人工设定。
  // 上限 MAX_JUDGES 不是随便定的 —— 计分的 LCM 缩放量级证明依赖它（PLAN §6.3）。
  const judgeCount = body.judgeCount === undefined ? null : body.judgeCount;
  if (judgeCount !== null) {
    if (!Number.isInteger(judgeCount) || judgeCount < 1 || judgeCount > MAX_JUDGES) {
      return bad(res, `评委人数必须是 1–${MAX_JUDGES} 的整数。`);
    }
  }

  if (!activityName) return bad(res, '活动名称不能为空。');
  if (!inDimensions || !inDimensions.length) return bad(res, '至少需要 1 个评分维度。');
  if (!inContestants || !inContestants.length) return bad(res, '至少需要 1 个参赛者。');

  // 维度校验：名称非空、权重为整数且合计 = 100（PLAN §6）
  const dimensions = [];
  let weightTotal = 0;
  for (const d of inDimensions) {
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    const detail = typeof d.detail === 'string' ? d.detail.trim() : '';
    if (!name) return bad(res, '维度名称不能为空。');
    if (!Number.isInteger(d.weight)) return bad(res, `维度「${name}」的权重必须是整数。`);
    if (d.weight < 0 || d.weight > 100) return bad(res, `维度「${name}」的权重必须在 0–100 之间。`);
    weightTotal += d.weight;
    dimensions.push({ id: d.id ?? null, name, weight: d.weight, detail });
  }
  if (weightTotal !== 100) return bad(res, `维度权重合计必须等于 100，当前为 ${weightTotal}。`);

  const contestants = [];
  for (const c of inContestants) {
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const project = typeof c.project === 'string' ? c.project.trim() : '';
    const intro = typeof c.intro === 'string' ? c.intro.trim() : '';
    if (!name) return bad(res, '参赛者姓名不能为空。');
    if (!project) return bad(res, `参赛者「${name}」的项目名不能为空。`);
    contestants.push({ id: c.id ?? null, name, project, intro });
  }

  // 开赛后的锁定（PLAN §8.2）。
  // 判据从「有没有选票」改成「有没有开过场」—— 开了场就意味着已经有评委会看到打分页，
  // 此时再改权重会让已完成场次的分值被追溯性地改变。
  if (rounds.hasAnyRound()) {
    const existingD = new Set(dimensionIds());
    const nextD = new Set(dimensions.filter((d) => d.id != null).map((d) => d.id));

    if (dimensions.some((d) => d.id == null)) {
      return bad(res, '比赛已经开始，不能再新增评分维度。', 409, 'config_locked');
    }
    if (nextD.size !== existingD.size || [...existingD].some((id) => !nextD.has(id))) {
      return bad(res, '比赛已经开始，不能再删除评分维度。', 409, 'config_locked');
    }

    // 权重冻结：否则可以在场次之间偷改权重，追溯性改变已完成场次的分值
    for (const d of dimensions) {
      const cur = db.prepare('SELECT weight FROM dimension WHERE id = ?').get(d.id);
      if (cur && cur.weight !== d.weight) {
        return bad(res, '比赛已经开始，不能再修改维度权重。', 409, 'config_locked');
      }
    }

    // 参赛者：允许改名、允许中途加人（临时补位是真实需求），
    // 但**不允许删除已经上过场的** —— 那会让 round 关联不到人、分数变成孤儿。
    const nextC = new Set(contestants.filter((c) => c.id != null).map((c) => c.id));
    for (const id of contestantIds()) {
      if (nextC.has(id)) continue;
      if (countRoundsForContestant.get(id).n > 0) {
        return bad(
          res,
          '这位演讲者已经上过场，不能删除。要退出请不要再给他开场次。',
          409,
          'config_locked'
        );
      }
    }
  }

  // 校验 id 合法性
  const existingC = new Set(contestantIds());
  const existingD = new Set(dimensionIds());
  for (const c of contestants) if (c.id != null && !existingC.has(c.id)) return bad(res, '存在无效的参赛者 ID。');
  for (const d of dimensions) if (d.id != null && !existingD.has(d.id)) return bad(res, '存在无效的维度 ID。');

  db.transaction(() => {
    setSetting('activity_name', activityName);
    if (judgeCount !== null) setSetting('judge_count', judgeCount);

    const keepC = [];
    contestants.forEach((c, i) => {
      const seq = i + 1;
      if (c.id == null) keepC.push(insertContestant.run(seq, c.name, c.project, c.intro).lastInsertRowid);
      else {
        updateContestant.run(seq, c.name, c.project, c.intro, c.id);
        keepC.push(c.id);
      }
    });
    for (const id of existingC) if (!keepC.includes(id)) deleteContestant.run(id);

    const keepD = [];
    dimensions.forEach((d, i) => {
      const seq = i + 1;
      if (d.id == null) keepD.push(insertDimension.run(seq, d.name, d.weight, d.detail).lastInsertRowid);
      else {
        updateDimension.run(seq, d.name, d.weight, d.detail, d.id);
        keepD.push(d.id);
      }
    });
    for (const id of existingD) if (!keepD.includes(id)) deleteDimension.run(id);
  })();

  res.json({ ok: true, ...readConfig() });
});

/* ---------------------------- 邀请链接 ----------------------------- */

router.get('/api/admin/invites', requireAdmin, (req, res) => {
  res.json({ ok: true, invites: listInvites.all() });
});

/** 固定入口地址（二维码方案 B） */
router.get('/api/admin/entry', requireAdmin, (req, res) => {
  const urls = entryUrls(PORT);
  res.json({ ok: true, urls, preferred: urls.length ? urls[0].url : null });
});

/** 入口二维码。只接受本机探测到的 IP，避免变成任意内容的二维码生成器。 */
router.get('/api/admin/qrcode.svg', requireAdmin, (req, res) => {
  const urls = entryUrls(PORT);
  if (!urls.length) {
    return bad(
      res,
      '没有可用的入口地址，无法生成二维码。请设置环境变量 PFXT_PUBLIC_URL，或确认本机已连上网。',
      503,
      'no_entry_url'
    );
  }

  const wanted = String(req.query.ip || '');
  const target = urls.find((u) => u.ip === wanted) || urls[0];

  const qr = qrcode(0, 'M'); // 0 = 自动选版本，M = 15% 纠错
  qr.addData(target.url);
  qr.make();

  res.type('image/svg+xml');
  res.set('Cache-Control', 'no-store');
  res.send(qr.createSvgTag({ cellSize: 6, margin: 4 }));
});

router.post('/api/admin/invites', requireAdmin, (req, res) => {
  const count = req.body && req.body.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_INVITES_PER_BATCH) {
    return bad(res, `生成数量必须是 1–${MAX_INVITES_PER_BATCH} 的整数。`);
  }

  const created = [];
  const now = Date.now();
  db.transaction(() => {
    let guard = 0;
    while (created.length < count) {
      if ((guard += 1) > count * 100) throw new Error('短码空间耗尽，请调大 CODE_LENGTH');
      const code = randomCode();
      try {
        insertInvite.run(code, now);
        created.push(code);
      } catch (err) {
        if (!String(err.code || '').startsWith('SQLITE_CONSTRAINT')) throw err;
      }
    }
  })();

  res.json({ ok: true, created });
});

router.post('/api/admin/invites/:code/revoke', requireAdmin, (req, res) => {
  const { code } = req.params;
  const invite = selectInvite.get(code);
  if (!invite) return bad(res, '登录码不存在。', 404, 'not_found');

  // 交过票就不能作废 —— 选票已与身份脱钩，无法定位该删哪张票。
  // 强行作废只会造成「标记作废但票仍在计」的矛盾。
  if (countRoundsForCode.get(code).n > 0) {
    return bad(
      res,
      '这个登录码已经提交过评分。选票已与身份脱钩、无法定位删除，因此不可作废；强行作废只会造成「标记作废但票仍在计」的矛盾。',
      409,
      'submitted_locked'
    );
  }
  if (invite.revoked) return res.json({ ok: true, alreadyRevoked: true });

  revokeInvite.run(code);
  res.json({ ok: true });
});

/* ---------------------------- 场次控制 ----------------------------- */

const judgeCountOf = () => Number(getSetting('judge_count', '11')) || 11;

/** 场次总览：当前场次、每场已收/未收、异常告警。取代了旧版的 /progress。 */
router.get('/api/admin/rounds', requireAdmin, (req, res) => {
  const judgeCount = judgeCountOf();
  const all = rounds.listRounds();
  const live = all.find((r) => r.status === 'live') || null;

  const view = all.map((r) => ({
    roundId: r.id,
    seq: r.seq,
    status: r.status, // live | closed
    contestantId: r.contestant_id,
    name: r.name,
    project: r.project,
    submitted: r.submitted,
    judgeCount,
    // 票数不多于 2 的场次结论不可靠，结果页和这里都要标注（PLAN §5.3）
    thin: r.submitted > 0 && r.submitted <= 2,
    // 提交数超过设定的评委人数 —— 现场一定出了状况（多半是清缓存换了新码多投）
    over: r.submitted > judgeCount,
  }));

  const totalCodes = countCodes.get().n;
  const revoked = countRevokedCodes.get().n;

  const anomalies = [];
  for (const r of view) {
    if (r.over) {
      anomalies.push(`第 ${r.seq} 场收到 ${r.submitted} 份评分，超过设定的评委人数 ${judgeCount}。`);
    }
  }
  const unstarted = readConfig().contestants.filter(
    (c) => !all.some((r) => r.contestant_id === c.id)
  ).length;

  res.json({
    ok: true,
    phase: getSetting('phase', 'open'),
    activityName: getSetting('activity_name', '内部项目评比'),
    judgeCount,
    live: live
      ? {
          roundId: live.id,
          seq: live.seq,
          contestantId: live.contestant_id,
          name: live.name,
          project: live.project,
          submitted: live.submitted,
        }
      : null,
    rounds: view,
    codes: {
      total: totalCodes,
      revoked,
      active: totalCodes - revoked,
      everSubmitted: countCodesThatSubmitted.get().n,
    },
    unstartedContestants: unstarted,
    anomalies,
  });
});

/** 开始下一场。可带 contestantId 指定演讲者（临时调序 / 补位）。 */
router.post('/api/admin/rounds/advance', requireAdmin, (req, res) => {
  const body = req.body || {};
  const contestantId = Number.isInteger(body.contestantId) ? body.contestantId : null;

  try {
    const r = rounds.advance(contestantId);
    res.json({
      ok: true,
      round: { roundId: r.id, seq: r.seq, contestantId: r.contestant_id, name: r.name },
    });
  } catch (err) {
    if (err instanceof rounds.RoundError) return bad(res, err.message, err.status, err.code);
    throw err;
  }
});

/**
 * 重开一场（PLAN §5.4）。
 * 不是把旧场次改回 live —— 那会让已交过的评委被允许再交一张、票数凭空翻倍。
 * 而是为同一位演讲者**新建一场**，计分时只取 seq 最大的那场。
 */
router.post('/api/admin/rounds/:id/reopen', requireAdmin, (req, res) => {
  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId)) return bad(res, '场次编号不正确。');

  try {
    const r = rounds.reopenRound(roundId);
    res.json({
      ok: true,
      round: { roundId: r.id, seq: r.seq, contestantId: r.contestant_id, name: r.name },
      message: `${r.name} 已重开新的一场，原来的那一场作废不再计分。已经交过的评委需要重新打一次。`,
    });
  } catch (err) {
    if (err instanceof rounds.RoundError) return bad(res, err.message, err.status, err.code);
    throw err;
  }
});

/**
 * 清空演练数据（PLAN §8.3）。彩排完必定要用，否则只能手工删库，更危险。
 * 保留演讲者、维度、登录码、管理员设置。
 */
router.post('/api/admin/reset', requireAdmin, (req, res) => {
  if (!(req.body && req.body.confirm === 'RESET')) {
    return bad(res, '清空演练数据需要二次确认。', 400, 'confirm_required');
  }
  const cleared = rounds.resetAll();
  res.json({
    ok: true,
    cleared,
    message:
      '场次与选票已清空。演讲者、维度、登录码、管理员设置都保留，登录码可以继续使用。',
  });
});

/* ------------------------------ 结果 ------------------------------- */

/** 组装计分输入。results 与 results.xlsx 共用，避免两处逻辑漂移。 */
function computeCurrentResults() {
  const config = readConfig();
  const all = rounds.listRounds();

  // 同一演讲者重开过多场时，只取 seq 最大的那场参与排名
  const { effective, supersededIds } = pickEffectiveRounds(
    all.map((r) => ({ id: r.id, contestantId: r.contestant_id, seq: r.seq }))
  );

  const byRoundId = new Map(all.map((r) => [r.id, r]));
  const roundInputs = effective.map((r) => {
    const row = byRoundId.get(r.id);
    return {
      id: row.id,
      seq: row.seq,
      contestantId: row.contestant_id,
      contestantSeq: row.contestant_seq,
      contestantName: row.name,
      contestantProject: row.project,
    };
  });

  const scoreRows = db
    .prepare('SELECT ballot_id, round_id, dimension_id, value FROM score')
    .all();

  const byBallot = new Map();
  for (const s of scoreRows) {
    let arr = byBallot.get(s.ballot_id);
    if (!arr) byBallot.set(s.ballot_id, (arr = []));
    arr.push(s);
  }

  const result = computeResults({
    rounds: roundInputs,
    dimensions: config.dimensions,
    ballots: [...byBallot.values()],
  });

  // 交叉核对：round_submission 是「已收」，score 是「实到票」。
  // 两者不等说明有并发写入没走事务，属于必须暴露的异常（PLAN §11）。
  const submittedByRound = new Map(all.map((r) => [r.id, r.submitted]));
  const mismatches = result.rounds
    .filter((row) => !row.blank && submittedByRound.get(row.roundId) !== row.n)
    .map((row) => ({
      roundId: row.roundId,
      name: row.name,
      submitted: submittedByRound.get(row.roundId),
      ballots: row.n,
    }));

  return { config, all, supersededIds, submittedByRound, result, mismatches };
}

router.get('/api/admin/results', requireAdmin, (req, res) => {
  let computed;
  try {
    computed = computeCurrentResults();
  } catch (err) {
    return bad(res, err.message, 500, 'scoring_failed');
  }

  const { config, all, supersededIds, submittedByRound, result, mismatches } = computed;
  const judgeCount = judgeCountOf();

  res.json({
    ok: true,
    phase: config.phase,
    activityName: config.activityName,
    judgeCount,
    lcm: result.lcm,
    orphans: result.orphans,
    insufficient: result.insufficient,
    dimensions: config.dimensions,
    // 「已收 X / N」的 X 取自 round_submission，与选票张数分开报，便于交叉核对
    rows: result.rounds.map((row) => ({
      ...row,
      submitted: submittedByRound.get(row.roundId) ?? 0,
      judgeCount,
    })),
    // 被重开顶掉的旧场次：后台置灰展示，不计分（PLAN §5.4）
    superseded: all
      .filter((r) => supersededIds.has(r.id))
      .map((r) => ({ roundId: r.id, seq: r.seq, name: r.name, submitted: r.submitted })),
    integrity: {
      ok: mismatches.length === 0,
      mismatches,
      message: mismatches.length
        ? '有场次的「已收份数」与库里的选票张数对不上，请核查。'
        : null,
    },
  });
});

/* ---------------------------- 导出 Excel ---------------------------- */

const num = (v, digits = 4) => (v === null || v === undefined ? '—' : Number(v.toFixed(digits)));

/** 把计分结果摊平成两个工作表 + 一张说明页 */
function buildResultSheets(data) {
  const dims = data.dimensions;
  const rows = data.rows;

  // ---- Sheet 1：汇总（与页面上的排名表一致）----
  const summary = [
    ['名次', '演讲者', '项目', ...dims.map((d) => `${d.name}（${d.weight}%）`), '加权总分', '本场票数'],
    ...rows.map((r) => [
      r.blank ? '—' : r.rank,
      r.name,
      r.project,
      ...dims.map((d) => num(r.margins[d.id])),
      num(r.total),
      r.n,
    ]),
  ];

  // ---- Sheet 2：维度明细（每位演讲者 × 每个维度）----
  const detail = [
    [
      '演讲者',
      '项目',
      '维度',
      '权重',
      '1分票数',
      '2分票数',
      '3分票数',
      '4分票数',
      '5分票数',
      '去分方式',
      '去掉的最高分',
      '去掉的最低分',
      '去分后票数',
      '去分后总分',
      '该维度均分',
      '备注',
    ],
  ];
  for (const r of rows) {
    for (const d of dims) {
      const info = r.details[d.id];
      if (!info) continue;

      const mode =
        info.keptCount === 0
          ? '无票'
          : info.keptCount === 1
            ? '仅 1 票，不去分'
            : info.trimmed
              ? '去一高一低'
              : '票数不足 3，不去分';

      const note = [];
      if (info.single) note.push('⚠️ 该维度只有 1 票，等于由一位评委决定');
      if (info.keptCount === 2) note.push('只有 2 票，未去分');

      detail.push([
        r.name,
        r.project,
        d.name,
        d.weight,
        info.counts[1],
        info.counts[2],
        info.counts[3],
        info.counts[4],
        info.counts[5],
        mode,
        info.removedHigh,
        info.removedLow,
        info.keptCount,
        info.sum,
        num(info.margin),
        note.join('；'),
      ]);
    }
  }

  // ---- Sheet 3：计分说明（含匿名边界的书面记录）----
  const thinRounds = rows.filter((r) => r.thin);
  const thinText = thinRounds.length
    ? `第 ${thinRounds.map((r) => r.seq).join('、')} 场收到的有效票数不超过 2 张，结论不可靠，请谨慎解读。`
    : '无';

  const info = [
    ['项目', '内容'],
    ['活动名称', data.activityName || ''],
    ['导出时间', new Date().toLocaleString('zh-CN', { hour12: false })],
    ['评委人数（设定值）', data.judgeCount],
    ['场次数', rows.length],
    ['缩放基准 L（各格保留票数的最小公倍数）', data.lcm],
    ['计分口径', '每一位演讲者单独计分：每个维度按**实际收到的票数**处理'],
    ['　· 3 票及以上', '升序排序，去掉一个最高分和一个最低分，其余取平均'],
    ['　· 正好 2 票', '两个分数直接取平均（去分会把分数去光，故不去分）'],
    ['　· 只有 1 票', '直接采用该分数，并在明细页标注「仅 1 票」'],
    ['　· 一张票都没有', '该场不计分，名次栏显示「—」，不影响其它场次'],
    ['维度权重', dims.map((d) => `${d.name} ${d.weight}%`).join(' / ')],
    ['加权总分算法', 'Σ(维度均分 × 权重) ÷ 100，取值范围 1.00–5.00'],
    ['排名规则', '按统一缩放后的**整数**加权分降序比较，并列名次相同、下一名跳号'],
    ['薄数据场次', thinText],
    ['', ''],
    [
      '⚠️ 匿名说明',
      '本表不含、也无法推算「哪位评委给谁打了多少分」。登录码与选票在数据库层面没有任何关联键，' +
        '系统只记录「某个登录码在第几场提交过」，不记录「提交了什么」。这是设计约定，不是导出时的取舍。',
    ],
    [
      '⚠️ 必须如实告知的边界',
      '① 如果某一场只有一位评委提交，那一场唯一的选票必然出自这位评委 —— 这是「一场一投 + 主持人随时切换」' +
        '模式的固有性质，无法通过技术手段消除，因此本表对票数≤2 的场次逐条标注。' +
        '② 系统记录了每个登录码的提交时刻，因此提交的先后顺序是可查的。选票本身没有任何时间戳，' +
        '无法把某张票对应到某人，但在场次颗粒度上，先后顺序并非完全不可观察。',
    ],
  ];

  return [
    { name: '汇总', rows: summary },
    { name: '维度明细', rows: detail },
    { name: '计分说明', rows: info },
  ];
}

router.get('/api/admin/results.xlsx', requireAdmin, (req, res) => {
  let computed;
  try {
    computed = computeCurrentResults();
  } catch (err) {
    return bad(res, err.message, 500, 'scoring_failed');
  }

  const { config, submittedByRound, result } = computed;

  // 只有「全场次都空白」才拒绝导出；个别场次票少或没票不该挡住导出（PLAN §6.2）
  if (result.insufficient) {
    return bad(res, '还没有任何有效选票，无法导出。', 409, 'no_data');
  }

  const sheets = buildResultSheets({
    activityName: config.activityName,
    dimensions: config.dimensions,
    judgeCount: judgeCountOf(),
    lcm: result.lcm,
    rows: result.rounds.map((row) => ({
      ...row,
      submitted: submittedByRound.get(row.roundId) ?? 0,
    })),
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `评分结果-${stamp}.xlsx`;

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="result.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildXlsx(sheets));
});

/* ------------------------------ 封盘 ------------------------------- */

router.post('/api/admin/close', requireAdmin, (req, res) => {
  setSetting('phase', 'closed');
  res.json({ ok: true, phase: 'closed' });
});

router.post('/api/admin/reopen', requireAdmin, (req, res) => {
  if (!(req.body && req.body.confirm === true)) {
    return bad(res, '重新开放需要二次确认。', 400, 'confirm_required');
  }
  setSetting('phase', 'open');
  res.json({ ok: true, phase: 'open' });
});

/* ------------------------------ 备份 ------------------------------- */

router.get('/api/admin/backup', requireAdmin, async (req, res) => {
  // 用 SQLite 在线备份 API —— 直接拷 .db 在 WAL 模式下会漏掉未 checkpoint 的事务
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(DATA_DIR, `pfxt-backup-${stamp}.db`);
  try {
    await db.backup(tmp);
    res.download(tmp, 'pfxt.db', (err) => {
      fs.unlink(tmp, () => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  } catch (err) {
    fs.unlink(tmp, () => {});
    bad(res, '备份失败：' + err.message, 500, 'backup_failed');
  }
});

module.exports = router;
