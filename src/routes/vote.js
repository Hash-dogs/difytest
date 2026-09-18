'use strict';

/**
 * 评委端路由（PLAN §7 / §9）—— 无需登录，靠持有短码。
 *
 * ⚠️ 匿名性：本文件的提交事务里，写入 ballot / score 的只有分数本身。
 *    禁止把 code、IP、User-Agent、请求时间写进这两张表（PLAN §5.2.4）。
 *    code 只写进 round_submission，那是另一张表，与选票无关联键。
 *
 * ⚠️ 本模型固有的边界（PLAN §5.3）：某一场若只有 1 个评委提交，那张票必然是他的。
 *    无法回避，只能靠「薄数据」标注把事实摆到明面上。
 */

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSetting } = require('../db');
const { getLiveRound, hasSubmitted } = require('../rounds');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const selectInvite = db.prepare('SELECT code, revoked FROM invite WHERE code = ?');
const insertBallot = db.prepare('INSERT INTO ballot (ballot_id) VALUES (?)');
const insertScore = db.prepare(
  'INSERT INTO score (ballot_id, round_id, dimension_id, value) VALUES (?, ?, ?, ?)'
);
const insertSubmission = db.prepare(
  'INSERT INTO round_submission (round_id, code, submitted_at) VALUES (?, ?, ?)'
);
const readPhase = db.prepare(`SELECT value FROM setting WHERE key = 'phase'`);
const readDimensions = db.prepare('SELECT id, seq, name, detail FROM dimension ORDER BY seq, id');
const countContestants = db.prepare('SELECT COUNT(*) AS n FROM contestant');

class SubmitError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ----------------------------- 短码登录 ----------------------------- */

/**
 * PLAN §7.1：短码由后台**预先批量签发**、管理员一对一发给评委，
 * 评委在统一入口 `/v` 手输。这相对旧版是流程变化 —— 旧版是扫码后
 * 服务器当场签发新码（/api/v/claim），那个接口现已删除。
 *
 * ⚠️ 短码因此从「随机标识」变成了「持有即可用的凭据」：
 *    旧版猜不中可以直接领一个新的，现在猜中就能冒名投票。
 *
 * 限流额度说明（**不是 10 次**，刻意的）：
 *   现场 20 个评委多半连同一个公司 WiFi，出口 NAT 后是同一个公网 IP。
 *   按 10 次/10 分钟算，几个人手滑打错就能把全场锁在门外。
 *   真正的防线是短码空间 32^8 ≈ 1.1e12（暴力枚举不可行），
 *   限流只是挡住脚本扫描的减速带，所以给足余量并把失败写进日志。
 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 60;
const loginFailures = new Map(); // ip -> { count, firstAt }

function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) return true;
  return rec.count < LOGIN_MAX_FAILURES;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, firstAt: now });
    return;
  }
  rec.count += 1;
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

/** 短码规范化：去空白与连字符、统一大写。字符集本就不含 I/O/0/1，无需做易混映射。 */
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ------------------------------- 页面 ------------------------------- */

/** GET /v —— 统一入口：短码输入页（二维码指向这里） */
router.get('/v', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'entry.html'));
});

/**
 * GET /v/:code —— 投票页。
 * 短码无效时**也返回页面**，由前端调 /state 后显示对应的阻断屏，
 * 这样评委看到的是一句能读懂的中文，而不是浏览器的 404。
 */
router.get('/v/:code', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'vote.html'));
});

/* ------------------------------- 接口 ------------------------------- */

/** POST /api/v/login —— 校验短码，通过则前端记下它 */
router.post('/api/v/login', (req, res) => {
  const ip = req.ip || 'unknown';

  if (!loginAllowed(ip)) {
    return res.status(429).json({
      ok: false,
      error: 'too_many_attempts',
      message: '尝试次数过多，请稍后再试；或直接联系主持人核对登录码。',
    });
  }

  const code = normalizeCode(req.body && req.body.code);
  if (!code) {
    return res.status(400).json({ ok: false, error: 'invalid_payload', message: '请填写登录码。' });
  }

  const invite = selectInvite.get(code);

  if (!invite) {
    noteLoginFailure(ip);
    console.warn(`[login] 无效登录码尝试 ip=${ip} code=${code}`);
    return res.status(404).json({
      ok: false,
      error: 'not_found',
      message: '登录码不正确，请核对主持人发给你的那串字符。',
    });
  }
  if (invite.revoked) {
    noteLoginFailure(ip);
    return res.status(410).json({
      ok: false,
      error: 'revoked',
      message: '这个登录码已被作废，请联系主持人。',
    });
  }

  clearLoginFailures(ip);
  res.json({ ok: true, code });
});

/**
 * GET /api/v/:code/state —— 评委端唯一的数据来源。
 *
 * ⚠️ PLAN §7.2：响应体**只含当前这一场的演讲者**，绝不返回 contestants 数组。
 *    验收里会用 JSON.stringify 断言响应体不含其他演讲者的姓名。
 *    同时不返回维度权重 —— 评委不需要看到权重，那只会让打分时先在心里加权一遍。
 */
router.get('/api/v/:code/state', (req, res) => {
  const code = normalizeCode(req.params.code);
  const invite = selectInvite.get(code);

  if (!invite) {
    return res.status(404).json({ ok: false, error: 'not_found', message: '登录码无效。' });
  }
  if (invite.revoked) {
    return res.status(410).json({ ok: false, error: 'revoked', message: '该登录码已被作废。' });
  }

  const live = getLiveRound();
  const phase = getSetting('phase', 'open');

  res.json({
    ok: true,
    phase,
    activityName: getSetting('activity_name', '内部项目评比'),
    judgeCount: Number(getSetting('judge_count', '11')) || 11,
    contestantCount: countContestants.get().n,
    dimensions: readDimensions.all(),
    // 只有一个演讲者，且只有名字/项目/简介 —— 没有分数，也没有别人
    current: live
      ? {
          roundId: live.id,
          seq: live.seq,
          submitted: hasSubmitted(live.id, code),
          contestant: { name: live.name, project: live.project, intro: live.intro },
        }
      : null,
  });
});

/** POST /api/v/:code/submit —— 提交本场评分 */
router.post('/api/v/:code/submit', (req, res) => {
  const code = normalizeCode(req.params.code);

  const invite = selectInvite.get(code);
  if (!invite) {
    return res.status(404).json({ ok: false, error: 'not_found', message: '登录码无效。' });
  }
  if (invite.revoked) {
    return res.status(410).json({ ok: false, error: 'revoked', message: '该登录码已被作废，无法提交。' });
  }
  if (getSetting('phase', 'open') !== 'open') {
    return res.status(409).json({ ok: false, error: 'closed', message: '投票已结束，无法提交。' });
  }

  const body = req.body || {};
  const roundId = body.roundId;
  const rawScores = body.scores;

  if (!Number.isInteger(roundId) || !Array.isArray(rawScores)) {
    return res.status(400).json({ ok: false, error: 'invalid_payload', message: '提交数据格式不正确。' });
  }

  const dimensions = readDimensions.all();
  const expected = new Set(dimensions.map((d) => d.id));

  // 校验：恰好 |D| 条，无重复、无遗漏，value ∈ [1,5] 整数
  if (rawScores.length !== expected.size) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_payload',
      message: `需要打完 ${expected.size} 个维度，收到 ${rawScores.length} 个。`,
    });
  }

  const pairs = [];
  const seen = new Set();
  for (const item of rawScores) {
    const dimensionId = item && item.dimensionId;
    const value = item && item.value;

    if (!Number.isInteger(dimensionId) || !expected.has(dimensionId)) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '存在无效的评分维度。' });
    }
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '分值必须是 1–5 的整数。' });
    }
    if (seen.has(dimensionId)) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '存在重复的评分维度。' });
    }
    seen.add(dimensionId);
    pairs.push({ dimensionId, value });
  }

  const submitTx = db.transaction(() => {
    // 竞态防护（沿用旧 §9.8 的写法）：校验通过之后管理员可能刚好切了场，
    // 所以事务内必须重新确认「这一场还是不是正在进行的那一场」。
    const live = getLiveRound();
    if (!live || live.id !== roundId) {
      throw new SubmitError(409, 'round_closed', '本场已经结束，你的评分没有提交（记为弃权）。');
    }
    const phase = readPhase.get();
    if (!phase || phase.value !== 'open') {
      throw new SubmitError(409, 'closed', '投票已结束，无法提交。');
    }
    if (hasSubmitted(roundId, code)) {
      throw new SubmitError(409, 'already_submitted', '本场你已经提交过了，无需重复提交。');
    }

    const ballotId = crypto.randomUUID();
    insertBallot.run(ballotId); // ⚠️ 只写 ballot_id，不写任何请求元数据
    for (const p of pairs) insertScore.run(ballotId, roundId, p.dimensionId, p.value);

    // 主键 (round_id, code) 冲突是并发双击的最后一道防线
    insertSubmission.run(roundId, code, Date.now());
  });

  try {
    submitTx();
  } catch (err) {
    if (err instanceof SubmitError) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res
        .status(409)
        .json({ ok: false, error: 'already_submitted', message: '本场你已经提交过了，无需重复提交。' });
    }
    throw err;
  }

  res.json({ ok: true });
});

module.exports = router;
