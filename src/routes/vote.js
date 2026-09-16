'use strict';

/**
 * 评委端路由（PLAN §6.1）—— 无需登录。
 *
 * ⚠️ 匿名性：本文件的提交事务里，写入 ballot / score 的只有分数本身。
 *    禁止把 code、IP、User-Agent、请求时间写进这两张表（PLAN §5.2.4）。
 */

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSetting } = require('../db');
const { randomCode } = require('../codes');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const selectInviteStatus = db.prepare('SELECT status FROM invite WHERE code = ?');
const insertInvite = db.prepare('INSERT INTO invite (code, status, created_at) VALUES (?, ?, ?)');
// 幂等：只有 issued → opened 这一次跃迁，重复打开不会覆盖首次 opened_at（PLAN §9.7）
const markOpened = db.prepare(
  `UPDATE invite SET status = 'opened', opened_at = ? WHERE code = ? AND status = 'issued'`
);
const insertBallot = db.prepare('INSERT INTO ballot (ballot_id) VALUES (?)');
const insertScore = db.prepare(
  'INSERT INTO score (ballot_id, contestant_id, dimension_id, value) VALUES (?, ?, ?, ?)'
);
// PLAN §6.1 幂等关键：影响行数为 0 就说明这码已经投过了
const claimInvite = db.prepare(
  `UPDATE invite SET status = 'submitted', submitted_at = ?
   WHERE code = ? AND status IN ('issued', 'opened')`
);
const readPhase = db.prepare(`SELECT value FROM setting WHERE key = 'phase'`);

const readDimensions = db.prepare('SELECT id, seq, name, weight, detail FROM dimension ORDER BY seq, id');
const readContestants = db.prepare('SELECT id, seq, name, project, intro FROM contestant ORDER BY seq, id');

class SubmitError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------- 固定入口 / 自助领取 ------------------------- */

/**
 * 方案 B：二维码只印一个固定地址 /v，不承担身份。
 * 评委扫码后由服务器**当场签发**一个 token，存在该评委的浏览器里。
 *
 * ⚠️ 已知取舍（已确认接受）：token 只存在于 localStorage，
 *    清缓存 / 换浏览器 / 换设备都会领到新 token，也就等于可以再投一次。
 *    因此这里只能防「同一个浏览器重复领」，防不住「故意清缓存刷票」。
 *    另外：因为不记录「这个 token 是谁」，后台**无法催票**，只能看到总数。
 */

const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_MAX_PER_IP = 100; // 明显高于真实评委数，只用来挡住脚本批量建行
const claimLog = new Map(); // ip -> { count, firstAt }

function claimAllowed(ip) {
  const now = Date.now();
  const rec = claimLog.get(ip);
  if (!rec || now - rec.firstAt > CLAIM_WINDOW_MS) {
    claimLog.set(ip, { count: 1, firstAt: now });
    return true;
  }
  rec.count += 1;
  return rec.count <= CLAIM_MAX_PER_IP;
}

function createInvite() {
  const now = Date.now();
  for (let i = 0; i < 100; i += 1) {
    const code = randomCode();
    try {
      insertInvite.run(code, 'issued', now);
      return code;
    } catch (err) {
      if (!String(err.code || '').startsWith('SQLITE_CONSTRAINT')) throw err;
    }
  }
  throw new Error('短码空间耗尽，请调大 CODE_LENGTH');
}

/** GET /v —— 固定入口页（二维码指向这里） */
router.get('/v', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'entry.html'));
});

/**
 * POST /api/v/claim —— 领取（或找回）本浏览器的 token
 *
 * 带 token 来且该 token 在库里存在 → 原样奉还。
 * 这一条很关键：已提交的 token 也要原样返回，否则评委重新扫码会拿到新 token
 * 从而投出第二张票；作废的 token 同理，要让他看到「已作废」而不是拿到新的。
 */
router.post('/api/v/claim', (req, res) => {
  if (getSetting('phase', 'open') !== 'open') {
    return res.status(409).json({ ok: false, error: 'closed', message: '投票已结束，无法再领取评分链接。' });
  }

  const provided = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
  if (provided) {
    const existing = selectInviteStatus.get(provided);
    if (existing) return res.json({ ok: true, code: provided, reused: true });
  }

  const ip = req.ip || 'unknown';
  if (!claimAllowed(ip)) {
    return res.status(429).json({ ok: false, error: 'too_many_claims', message: '领取过于频繁，请稍后再试。' });
  }

  res.json({ ok: true, code: createInvite(), reused: false });
});

/** GET /v/:code —— 返回投票页；顺带把 issued 置为 opened（幂等） */
router.get('/v/:code', (req, res) => {
  try {
    markOpened.run(Date.now(), req.params.code);
  } catch {
    /* 记录打开状态失败不该挡住评委投票 */
  }
  res.sendFile(path.join(PUBLIC_DIR, 'vote.html'));
});

/** GET /api/v/:code/data —— 投票页所需的全部配置 */
router.get('/api/v/:code/data', (req, res) => {
  const invite = selectInviteStatus.get(req.params.code);

  if (!invite) {
    return res.status(404).json({ ok: false, error: 'not_found', message: '链接无效，请向组织者确认地址。' });
  }
  if (invite.status === 'revoked') {
    return res.status(410).json({ ok: false, error: 'revoked', message: '该链接已被组织者作废，无法继续使用。' });
  }

  res.json({
    ok: true,
    status: invite.status, // issued | opened | submitted
    phase: getSetting('phase', 'open'),
    activityName: getSetting('activity_name', '内部项目评比'),
    dimensions: readDimensions.all(),
    contestants: readContestants.all(),
  });
});

/** POST /api/v/:code/submit —— 提交选票 */
router.post('/api/v/:code/submit', (req, res) => {
  const { code } = req.params;

  const invite = selectInviteStatus.get(code);
  if (!invite) {
    return res.status(404).json({ ok: false, error: 'not_found', message: '链接无效。' });
  }
  if (invite.status === 'revoked') {
    return res.status(410).json({ ok: false, error: 'revoked', message: '该链接已被作废，无法提交。' });
  }
  // 本地已提交但 localStorage 被清空的边界（PLAN §7.2）
  if (invite.status === 'submitted') {
    return res
      .status(409)
      .json({ ok: false, error: 'already_submitted', message: '本链接已提交过，无需重复提交。' });
  }
  if (getSetting('phase', 'open') !== 'open') {
    return res.status(409).json({ ok: false, error: 'closed', message: '投票已结束，无法提交。' });
  }

  const rawScores = req.body && req.body.scores;
  if (!Array.isArray(rawScores)) {
    return res.status(400).json({ ok: false, error: 'invalid_payload', message: '提交数据格式不正确。' });
  }

  // 校验 3：恰好 |C| × |D| 条，无重复、无遗漏，value ∈ [1,5] 整数
  const contestants = readContestants.all();
  const dimensions = readDimensions.all();
  const expected = new Set();
  for (const c of contestants) for (const d of dimensions) expected.add(`${c.id}:${d.id}`);

  if (rawScores.length !== expected.size) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_payload',
      message: `需要 ${expected.size} 个评分点，收到 ${rawScores.length} 个。`,
    });
  }

  const pairs = [];
  const seen = new Set();
  for (const item of rawScores) {
    const contestantId = item && item.contestantId;
    const dimensionId = item && item.dimensionId;
    const value = item && item.value;

    if (!Number.isInteger(contestantId) || !Number.isInteger(dimensionId)) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '存在非法的参赛者或维度。' });
    }
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '分值必须是 1–5 的整数。' });
    }

    const key = `${contestantId}:${dimensionId}`;
    if (!expected.has(key)) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '存在无效的参赛者/维度组合。' });
    }
    if (seen.has(key)) {
      return res.status(400).json({ ok: false, error: 'invalid_payload', message: '存在重复的评分点。' });
    }
    seen.add(key);
    pairs.push({ contestantId, dimensionId, value });
  }

  const submitTx = db.transaction(() => {
    // 封盘竞态（PLAN §9.8）：在事务内重新确认，避免「校验通过后恰好被封盘」
    const phase = readPhase.get();
    if (!phase || phase.value !== 'open') {
      throw new SubmitError(409, 'closed', '投票已结束，无法提交。');
    }

    const ballotId = crypto.randomUUID();
    insertBallot.run(ballotId); // ⚠️ 只写 ballot_id，不写任何请求元数据
    for (const p of pairs) insertScore.run(ballotId, p.contestantId, p.dimensionId, p.value);

    const info = claimInvite.run(Date.now(), code);
    if (info.changes === 0) {
      // 并发双击：另一路已经把它置为 submitted，回滚整张票
      throw new SubmitError(409, 'already_submitted', '本链接已提交过，无需重复提交。');
    }
  });

  try {
    submitTx();
  } catch (err) {
    if (err instanceof SubmitError) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
    throw err;
  }

  res.json({ ok: true });
});

module.exports = router;
