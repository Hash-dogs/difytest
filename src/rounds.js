'use strict';

/**
 * 场次读写工具（PLAN §5.4 / §8）。
 *
 * 「一场」= 一位演讲者的一个时段。管理员决定何时开下一场，未提交的评委记为弃权。
 *
 * ⚠️ 匿名性：本文件只碰 round / round_submission，**绝不**读写 ballot / score。
 *    round_submission 是「谁交了第几场」的唯一来源，它与选票之间没有关联键。
 */

const { db } = require('./db');

class RoundError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SELECT_LIVE = `
  SELECT r.id, r.contestant_id, r.seq, r.status, r.opened_at,
         c.name, c.project, c.intro, c.seq AS contestant_seq
    FROM round r
    JOIN contestant c ON c.id = r.contestant_id
   WHERE r.status = 'live'
   LIMIT 1`;

const SELECT_ALL = `
  SELECT r.id, r.contestant_id, r.seq, r.status, r.opened_at, r.closed_at,
         c.name, c.project, c.intro, c.seq AS contestant_seq,
         (SELECT COUNT(*) FROM round_submission s WHERE s.round_id = r.id) AS submitted
    FROM round r
    JOIN contestant c ON c.id = r.contestant_id
   ORDER BY r.seq, r.id`;

const SELECT_ONE = `
  SELECT r.id, r.contestant_id, r.seq, r.status, r.opened_at, r.closed_at,
         c.name, c.project, c.intro, c.seq AS contestant_seq,
         (SELECT COUNT(*) FROM round_submission s WHERE s.round_id = r.id) AS submitted
    FROM round r
    JOIN contestant c ON c.id = r.contestant_id
   WHERE r.id = ?`;

// 下一位：名单里按 seq 排、还没上过场的人
const SELECT_NEXT_CONTESTANT = `
  SELECT c.id
    FROM contestant c
   WHERE NOT EXISTS (SELECT 1 FROM round r WHERE r.contestant_id = c.id)
   ORDER BY c.seq, c.id
   LIMIT 1`;

const MAX_ROUND_SEQ = `SELECT COALESCE(MAX(seq), 0) AS n FROM round`;

const CLOSE_LIVE = `UPDATE round SET status = 'closed', closed_at = ? WHERE status = 'live'`;
const INSERT_ROUND = `INSERT INTO round (contestant_id, seq, status, opened_at) VALUES (?, ?, 'live', ?)`;

const SELECT_SUBMISSION = `SELECT submitted_at FROM round_submission WHERE round_id = ? AND code = ?`;
const SELECT_SUBMITTED_CODES = `SELECT code, submitted_at FROM round_submission WHERE round_id = ? ORDER BY submitted_at, code`;
const SELECT_MISSING_CODES = `
  SELECT code FROM invite
   WHERE revoked = 0
     AND code NOT IN (SELECT code FROM round_submission WHERE round_id = ?)
   ORDER BY code`;
const COUNT_ROUNDS_FOR_CONTESTANT = `SELECT COUNT(*) AS n FROM round WHERE contestant_id = ?`;

const stmt = {
  live: db.prepare(SELECT_LIVE),
  all: db.prepare(SELECT_ALL),
  one: db.prepare(SELECT_ONE),
  nextContestant: db.prepare(SELECT_NEXT_CONTESTANT),
  maxSeq: db.prepare(MAX_ROUND_SEQ),
  closeLive: db.prepare(CLOSE_LIVE),
  insertRound: db.prepare(INSERT_ROUND),
  submission: db.prepare(SELECT_SUBMISSION),
  submittedCodes: db.prepare(SELECT_SUBMITTED_CODES),
  missingCodes: db.prepare(SELECT_MISSING_CODES),
  countForContestant: db.prepare(COUNT_ROUNDS_FOR_CONTESTANT),
};

/* --------------------------------- 读 --------------------------------- */

/** 当前进行中的场次，没有则 null */
const getLiveRound = () => stmt.live.get() || null;

const listRounds = () => stmt.all.all();

const getRound = (id) => stmt.one.get(id) || null;

/** 该短码在本场是否已经提交过 */
const hasSubmitted = (roundId, code) => !!stmt.submission.get(roundId, code);

const submittedCodes = (roundId) => stmt.submittedCodes.all(roundId);

/** 还没交的短码（用于后台催票）。已作废的码不算。 */
const missingCodes = (roundId) => stmt.missingCodes.all(roundId).map((r) => r.code);

/** 是否已经开过场 —— 用来决定配置能否再改（PLAN §8.2） */
const hasAnyRound = () => stmt.maxSeq.get().n > 0;

/* --------------------------------- 写 --------------------------------- */

/** 把当前 live 场次关掉（没有就什么都不做）。必须在事务里调用。 */
function closeLive(now = Date.now()) {
  return stmt.closeLive.run(now).changes;
}

/**
 * 推进到下一场。
 *
 * @param {number|null} contestantId 指定演讲者；不传则按名单顺序取下一个没上过场的
 * @throws {RoundError} 404 contestant_not_found / 409 no_more_rounds
 */
function advance(contestantId = null) {
  const now = Date.now();

  const tx = db.transaction(() => {
    let target = contestantId;

    if (target === null || target === undefined) {
      const next = stmt.nextContestant.get();
      if (!next) {
        throw new RoundError(409, 'no_more_rounds', '名单里已经没有还没上场的演讲者了。');
      }
      target = next.id;
    } else {
      const exists = db.prepare('SELECT id FROM contestant WHERE id = ?').get(target);
      if (!exists) throw new RoundError(404, 'contestant_not_found', '找不到这位演讲者。');
    }

    closeLive(now);
    const seq = stmt.maxSeq.get().n + 1;
    const info = stmt.insertRound.run(target, seq, now);
    return stmt.one.get(info.lastInsertRowid);
  });

  return tx();
}

/**
 * 重开一场（PLAN §5.4）。
 *
 * ⚠️ 不是把旧场次的 status 改回 live —— 那会让已经交过的评委被允许再交一张，
 *    票数凭空翻倍，而且新旧票在库里分不开。
 *    正确做法是**为同一位演讲者新建一场**，计分时只取 seq 最大的那场。
 */
function reopenRound(roundId) {
  const old = getRound(roundId);
  if (!old) throw new RoundError(404, 'round_not_found', '找不到这一场。');
  return advance(old.contestant_id);
}

/**
 * 清空演练数据（PLAN §8.3）。
 * 清掉场次、提交记录、选票、评分、**全部登录码**；保留演讲者、维度、设置。
 *
 * ⚠️ 登录码是**删除**而不是标记作废（2026-09-22 变更）。
 *    原先设计是保留短码好让彩排的码继续用，但彩排期间发出的码可能已经落到
 *    非正式评委手上、或散在测试设备里，正式场次应当只认新签发的码。
 *    删掉之后 invite 表为空，登录码页会回到「还没有登录码」，需要重新批量生成发放；
 *    仍在用旧码的浏览器会拿到「登录码无效」。
 *
 * ⚠️ 本文件其余函数只碰 round / round_submission（见文件头），resetAll 是**唯一例外** ——
 *    它是整库重置入口，绕不开 ballot / score / invite。
 */
function resetAll() {
  const tx = db.transaction(() => {
    const rounds = db.prepare('SELECT COUNT(*) AS n FROM round').get().n;
    const submissions = db.prepare('SELECT COUNT(*) AS n FROM round_submission').get().n;
    const ballots = db.prepare('SELECT COUNT(*) AS n FROM ballot').get().n;
    const scores = db.prepare('SELECT COUNT(*) AS n FROM score').get().n;
    const codes = db.prepare('SELECT COUNT(*) AS n FROM invite').get().n;

    // 顺序无所谓（没建外键），但先删子表更符合直觉。
    // invite 必须在 round_submission 之后删：作废单个码时会拒绝「交过任一场」的码
    // （见 routes/admin.js），整表删除没有这个约束，但保持同样的先后次序不容易踩坑。
    db.prepare('DELETE FROM round_submission').run();
    db.prepare('DELETE FROM score').run();
    db.prepare('DELETE FROM ballot').run();
    db.prepare('DELETE FROM round').run();
    db.prepare('DELETE FROM invite').run();

    return { rounds, submissions, ballots, scores, codes };
  });

  return tx();
}

module.exports = {
  RoundError,
  getLiveRound,
  listRounds,
  getRound,
  hasSubmitted,
  submittedCodes,
  missingCodes,
  hasAnyRound,
  advance,
  reopenRound,
  resetAll,
  countRoundsForContestant: (contestantId) => stmt.countForContestant.get(contestantId).n,
};
