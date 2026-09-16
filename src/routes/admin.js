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
const { computeResults } = require('../scoring');
const { randomCode } = require('../codes');
const { entryUrls } = require('../net');
const { buildXlsx } = require('../xlsx');
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

const selectInvite = db.prepare('SELECT code, status, created_at, opened_at, submitted_at FROM invite WHERE code = ?');
const listInvites = db.prepare('SELECT code, status, created_at, opened_at, submitted_at FROM invite ORDER BY created_at, code');
const insertInvite = db.prepare('INSERT INTO invite (code, status, created_at) VALUES (?, ?, ?)');
const revokeInvite = db.prepare(`UPDATE invite SET status = 'revoked' WHERE code = ? AND status IN ('issued', 'opened')`);

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

const countSubmitted = db.prepare(`SELECT COUNT(*) AS n FROM invite WHERE status = 'submitted'`);
const countByStatus = db.prepare('SELECT status, COUNT(*) AS n FROM invite GROUP BY status');

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
  res.json({ ok: true, ...config, submittedCount: countSubmitted.get().n });
});

router.put('/api/admin/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const activityName = typeof body.activityName === 'string' ? body.activityName.trim() : '';
  const inContestants = Array.isArray(body.contestants) ? body.contestants : null;
  const inDimensions = Array.isArray(body.dimensions) ? body.dimensions : null;

  if (!activityName) return bad(res, '活动名称不能为空。');
  if (!inDimensions || !inDimensions.length) return bad(res, '至少需要 1 个评分维度。');
  if (!inContestants || !inContestants.length) return bad(res, '至少需要 1 个参赛者。');

  // 维度校验：名称非空、权重为整数且合计 = 100（PLAN §9.10）
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

  // 已有提交后禁止增删参赛者/维度（PLAN §6.2、§9.10）——否则历史票会对不上
  const submittedCount = countSubmitted.get().n;
  if (submittedCount > 0) {
    const existingC = new Set(contestantIds());
    const existingD = new Set(dimensionIds());
    const nextC = new Set(contestants.filter((c) => c.id != null).map((c) => c.id));
    const nextD = new Set(dimensions.filter((d) => d.id != null).map((d) => d.id));

    if (contestants.some((c) => c.id == null)) {
      return bad(res, `已有 ${submittedCount} 张选票提交，不能再新增参赛者。`, 409, 'config_locked');
    }
    if (dimensions.some((d) => d.id == null)) {
      return bad(res, `已有 ${submittedCount} 张选票提交，不能再新增评分维度。`, 409, 'config_locked');
    }
    if (nextC.size !== existingC.size || [...existingC].some((id) => !nextC.has(id))) {
      return bad(res, `已有 ${submittedCount} 张选票提交，不能再删除参赛者。`, 409, 'config_locked');
    }
    if (nextD.size !== existingD.size || [...existingD].some((id) => !nextD.has(id))) {
      return bad(res, `已有 ${submittedCount} 张选票提交，不能再删除评分维度。`, 409, 'config_locked');
    }
  }

  // 校验 id 合法性
  const existingC = new Set(contestantIds());
  const existingD = new Set(dimensionIds());
  for (const c of contestants) if (c.id != null && !existingC.has(c.id)) return bad(res, '存在无效的参赛者 ID。');
  for (const d of dimensions) if (d.id != null && !existingD.has(d.id)) return bad(res, '存在无效的维度 ID。');

  db.transaction(() => {
    setSetting('activity_name', activityName);

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
    return bad(res, '没有检测到局域网 IPv4 地址，无法生成二维码。请确认电脑已连上内网。', 503, 'no_lan_address');
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
        insertInvite.run(code, 'issued', now);
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
  if (!invite) return bad(res, '链接不存在。', 404, 'not_found');

  // PLAN §6.2：submitted 不可作废 —— 选票已与身份脱钩，无法定位该删哪张票
  if (invite.status === 'submitted') {
    return bad(
      res,
      '该链接已提交选票。选票已与身份脱钩、无法定位删除，因此不可作废；强行作废只会造成「标记作废但票仍在计」的矛盾。',
      409,
      'submitted_locked'
    );
  }
  if (invite.status === 'revoked') return res.json({ ok: true, alreadyRevoked: true });

  revokeInvite.run(code);
  res.json({ ok: true });
});

/* ---------------------------- 进度 / 结果 --------------------------- */

router.get('/api/admin/progress', requireAdmin, (req, res) => {
  const counts = { issued: 0, opened: 0, submitted: 0, revoked: 0 };
  for (const row of countByStatus.all()) {
    if (row.status in counts) counts[row.status] = row.n;
  }

  const codes = { issued: [], opened: [], submitted: [], revoked: [] };
  for (const row of listInvites.all()) {
    if (row.status in codes) codes[row.status].push(row.code);
  }

  res.json({
    ok: true,
    phase: getSetting('phase', 'open'),
    activityName: getSetting('activity_name', '内部项目评比'),
    counts,
    total: counts.issued + counts.opened + counts.submitted + counts.revoked,
    codes, // 「已打开未提交」正是催票的关键信号（PLAN §7.3）
  });
});

router.get('/api/admin/results', requireAdmin, (req, res) => {
  const config = readConfig();

  let rows;
  try {
    rows = db.prepare('SELECT ballot_id, contestant_id, dimension_id, value FROM score').all();
  } catch (err) {
    return bad(res, '读取选票失败：' + err.message, 500, 'internal');
  }

  const byBallot = new Map();
  for (const r of rows) {
    let arr = byBallot.get(r.ballot_id);
    if (!arr) byBallot.set(r.ballot_id, (arr = []));
    arr.push(r);
  }

  let result;
  try {
    result = computeResults({
      contestants: config.contestants,
      dimensions: config.dimensions,
      ballots: [...byBallot.values()],
    });
  } catch (err) {
    return bad(res, err.message, 500, 'scoring_failed');
  }

  const submittedCount = countSubmitted.get().n;

  res.json({
    ok: true,
    phase: config.phase,
    activityName: config.activityName,
    n: result.n,
    k: result.k,
    trimmed: result.trimmed,
    insufficient: result.insufficient,
    dimensions: config.dimensions,
    rows: result.rows,
    integrity: {
      ok: submittedCount === result.n,
      submittedCount,
      ballotCount: result.n,
      message:
        submittedCount === result.n
          ? null
          : `已标记提交 ${submittedCount} 个链接，但库里有 ${result.n} 张选票，两者不一致，请核查。`,
    },
  });
});

/* ---------------------------- 导出 Excel ---------------------------- */

/** 把计分结果摊平成两个工作表 + 一张说明页 */
function buildResultSheets(data) {
  const dims = data.dimensions;
  const rows = data.rows;

  // ---- Sheet 1：汇总（与页面上的排名表一致）----
  const summary = [
    ['名次', '参赛者', '项目', ...dims.map((d) => `${d.name}（${d.weight}%）`), '加权总分'],
    ...rows.map((r) => [
      r.rank,
      r.name,
      r.project,
      ...dims.map((d) => Number((r.margins[d.id] ?? 0).toFixed(4))),
      Number((r.total ?? 0).toFixed(4)),
    ]),
  ];

  // ---- Sheet 2：维度明细（每个参赛者 × 每个维度）----
  const detail = [
    [
      '参赛者',
      '项目',
      '维度',
      '权重',
      '1分票数',
      '2分票数',
      '3分票数',
      '4分票数',
      '5分票数',
      '去掉的最高分',
      '去掉的最低分',
      '去分后票数',
      '去分后总分',
      '该维度均分',
    ],
  ];
  for (const r of rows) {
    for (const d of dims) {
      const info = r.details[d.id];
      if (!info) continue;
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
        info.removedHigh,
        info.removedLow,
        info.keptCount,
        info.sum,
        Number(info.margin.toFixed(4)),
      ]);
    }
  }

  // ---- Sheet 3：计分说明（含匿名边界的书面记录）----
  const kText =
    data.k >= 1
      ? `每维度去掉一个最高分和一个最低分后，以 ${data.k} 张计平均`
      : `去掉一高一低后已无剩余分数（有效票数 ${data.n} 张，需至少 3 张才能计分）`;
  const info = [
    ['项目', '内容'],
    ['活动名称', data.activityName || ''],
    ['导出时间', new Date().toLocaleString('zh-CN', { hour12: false })],
    ['有效选票数 N', data.n],
    ['每单元格保留票数 k', data.k],
    ['计分口径', kText],
    ['维度权重', dims.map((d) => `${d.name} ${d.weight}%`).join(' / ')],
    ['加权总分算法', 'Σ(维度均分 × 权重) ÷ 100，取值范围 1.00–5.00'],
    ['排名规则', '按整数加权分降序，并列名次相同、下一名跳号'],
    ['', ''],
    [
      '⚠️ 匿名说明',
      '本表不含、也无法推算「哪位评委打了什么分」。邀请码与选票在数据库层面没有任何关联键，' +
        '系统只记录「某个链接是否已提交」，不记录「提交了什么」。这是设计约定，不是导出时的取舍。',
    ],
  ];

  return [
    { name: '汇总', rows: summary },
    { name: '维度明细', rows: detail },
    { name: '计分说明', rows: info },
  ];
}

router.get('/api/admin/results.xlsx', requireAdmin, (req, res) => {
  const config = readConfig();

  let scoreRows;
  try {
    scoreRows = db.prepare('SELECT ballot_id, contestant_id, dimension_id, value FROM score').all();
  } catch (err) {
    return bad(res, '读取选票失败：' + err.message, 500, 'internal');
  }

  const byBallot = new Map();
  for (const r of scoreRows) {
    let arr = byBallot.get(r.ballot_id);
    if (!arr) byBallot.set(r.ballot_id, (arr = []));
    arr.push(r);
  }

  let result;
  try {
    result = computeResults({
      contestants: config.contestants,
      dimensions: config.dimensions,
      ballots: [...byBallot.values()],
    });
  } catch (err) {
    return bad(res, err.message, 500, 'scoring_failed');
  }

  if (result.insufficient) {
    return bad(res, '还没有任何有效选票，无法导出。', 409, 'no_data');
  }

  const sheets = buildResultSheets({
    activityName: config.activityName,
    dimensions: config.dimensions,
    rows: result.rows,
    n: result.n,
    k: result.k,
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
