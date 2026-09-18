'use strict';

/**
 * 数据库入口：建库、建表、启动期结构断言、setting 读写 helper。
 *
 * ⚠️ 2026-09-18 变更：**选票不再匿名。改动前必读。**
 *
 *   业务方要求结果页能列出「每个登录码 × 每位演讲者 × 每个维度」的评分，
 *   因此 `ballot` 表现在带 `code` 列，选票与登录码之间**可以 join**，
 *   管理员能够还原「谁给谁打了多少分」。
 *
 *   这是**刻意的产品决定**，不是疏漏。在此之前的版本（见 git 提交 e51d91a）
 *   用 8 条断言保证「两表无任何关联键」，那套设计与理由留在 git 历史里备查。
 *
 *   相应地，启动期断言从「保证匿名」改为「保证结构不被改坏 + 数据最小化」：
 *     1. ballot 列集合严格等于 {ballot_id, code}
 *     2. score 列集合严格等于 {ballot_id, round_id, dimension_id, value}
 *     3. round_submission 列集合严格等于 {round_id, code, submitted_at}
 *     4. ballot / score / round_submission 必须 WITHOUT ROWID
 *     5. ballot 禁止出现任何时间戳列 —— code 是业务要的，但**请求元数据**
 *        （IP / User-Agent / 提交时刻）没有理由落库
 *     6. 提交接口只允许把 code 写进 ballot，禁止写 IP / UA / 时间
 *     7. 库里禁止出现 view / trigger —— 它们能绕过上面的列集合检查
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'pfxt.db');

/** 当前 schema 版本。写在 PRAGMA user_version 里，用来识别老库。
 *  3 = 选票带登录码（2026-09-18 起不再匿名）；2 = 上一版匿名结构。 */
const SCHEMA_VERSION = 3;

const SCHEMA = `
-- 演讲者（后台可配）
CREATE TABLE IF NOT EXISTS contestant (
  id       INTEGER PRIMARY KEY,
  seq      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  project  TEXT    NOT NULL,
  intro    TEXT    NOT NULL DEFAULT ''
);

-- 评分维度（后台可配）
CREATE TABLE IF NOT EXISTS dimension (
  id       INTEGER PRIMARY KEY,
  seq      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  weight   INTEGER NOT NULL,
  detail   TEXT    NOT NULL DEFAULT ''
);

-- 短码表：只回答「这个码是否存在 / 是否作废 / 交过哪几场」，绝不指向选票。
-- PLAN §9：submitted_at 已移除 —— 提交是「每场一次」的，记在 round_submission 上。
CREATE TABLE IF NOT EXISTS invite (
  code       TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

-- 场次：一位演讲者一个时段。
-- 同一演讲者可以有多场（重开场景，PLAN §5.4），计分只取 seq 最大的那一场。
CREATE TABLE IF NOT EXISTS round (
  id            INTEGER PRIMARY KEY,
  contestant_id INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  status        TEXT    NOT NULL,      -- live | closed
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER
);

-- 提交记录：与 ballot 无任何关联键。这是「谁交了第几场」的唯一来源。
CREATE TABLE IF NOT EXISTS round_submission (
  round_id     INTEGER NOT NULL,
  code         TEXT    NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, code)
) WITHOUT ROWID;

-- 选票表。
-- ⚠️ code 列是**刻意**的：业务要求结果页列出每位评委的打分，选票与登录码因此可 join。
--    但除了 code 之外禁止再加任何请求元数据（IP / User-Agent / 时间戳）——
--    那些对业务没有价值，只会平白扩大暴露面。
CREATE TABLE IF NOT EXISTS ballot (
  ballot_id TEXT PRIMARY KEY,
  code      TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ballot_code ON ballot(code);

-- 评分行：用 round_id 归属场次。
-- ⚠️ 不用 contestant_id —— 重开场景下同一演讲者会有多场，就分不开了。
CREATE TABLE IF NOT EXISTS score (
  ballot_id    TEXT    NOT NULL,
  round_id     INTEGER NOT NULL,
  dimension_id INTEGER NOT NULL,
  value        INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  PRIMARY KEY (ballot_id, round_id, dimension_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 同时最多只能有一个「进行中」的场次。
-- 部分唯一索引让这条不变量由数据库保证，而不是靠 advance() 自觉 ——
-- 管理员连点两次、或以后加了别的入口，都不可能造出两个 live 场次。
CREATE UNIQUE INDEX IF NOT EXISTS round_single_live ON round(status) WHERE status = 'live';
`;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* --------------------------- 建表 / 老库识别 --------------------------- */

const tableExists = (name) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/**
 * 老库识别（PLAN §10）。
 *
 * 「一次性打完所有人」那版的库里，invite 有 status 列、score 用 contestant_id 归属，
 * 与场次模型语义不兼容 —— 旧选票无法映射到任何场次。**不做自动迁移**：
 * 迁移一个只值 4 天工期的临时活动库，风险远大于收益，而且静默转换会让人以为数据还在。
 *
 * 所以这里选择**拒绝启动**，并把话说清楚。
 */
function initSchema() {
  const existing = tableExists('invite') || tableExists('ballot') || tableExists('score');
  const userVersion = db.pragma('user_version', { simple: true });

  if (!existing) {
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return { created: true };
  }

  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(
      '数据库版本不符（库版本 ' + userVersion + '，需要 ' + SCHEMA_VERSION + '），已拒绝启动。\n' +
        '  版本 2 及更早的库里，选票不记录登录码，**无法补上** —— 已经投出去的票\n' +
        '  永久不可归属到具体评委，这是选票不再匿名之前的历史数据。\n' +
        '  处理方式：备份 data/pfxt.db 后删掉它再启动 ——\n' +
        '    · 演讲者名单与维度会用同一份默认值重新写入\n' +
        '    · 管理员口令会重新生成并打印在启动横幅里\n' +
        '    · 已签发的登录码会丢失，需要重新生成发放\n' +
        '  如果你确实要保留旧库，请另存一份，不要原地改名。'
    );
  }

  db.exec(SCHEMA); // 幂等，补齐可能缺失的表
  return { created: false };
}

const initResult = initSchema();

/* ---------------------------- 启动期结构断言 ---------------------------- */

/** 每张表的列集合必须**严格等于**这里声明的集合（不是「不多于」，是「就是这些」）。 */
const EXPECTED_COLUMNS = {
  // code 是业务要求的（结果页要列出每位评委的打分）；除它之外不许再加任何列
  ballot: ['ballot_id', 'code'],
  score: ['ballot_id', 'round_id', 'dimension_id', 'value'],
  round_submission: ['round_id', 'code', 'submitted_at'],
};

const MUST_WITHOUT_ROWID = ['ballot', 'score', 'round_submission'];

/** 选票里出现这些列，说明有人把请求元数据写进去了 —— 业务不需要，纯属扩大暴露面。 */
const FORBIDDEN_IN_BALLOT = /(^|_)(ip|ua|agent|time|timestamp|created|updated|at)($|_)/i;

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/**
 * 启动期断言：即使 db 文件是别人手工建的 / 被改过，也要保证表结构没被改坏。
 *
 * ⚠️ 它**不再**保证匿名 —— 从 2026-09-18 起选票带登录码，本来就不匿名了。
 *    现在守的是两件事：结构一致（列集合精确相等），以及数据最小化
 *    （选票里除 code 外不许出现请求元数据）。
 */
function assertSchemaIntegrity() {
  const problems = [];

  // 1) 关键表的列集合必须精确匹配（只查「有没有多余列」会漏掉「少了列」的情况）
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = columnsOf(table);
    if (!actual.length) {
      problems.push(`缺少 ${table} 表`);
      continue;
    }
    if (!sameSet(actual, expected)) {
      problems.push(
        `${table} 表列集合异常：[${actual.join(', ')}]，只允许是 [${expected.join(', ')}]`
      );
    }
  }

  // 2) WITHOUT ROWID
  for (const table of MUST_WITHOUT_ROWID) {
    const row = db
      .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', table);
    if (!row || !/WITHOUT\s+ROWID/i.test(row.sql)) {
      problems.push(`${table} 表缺少 WITHOUT ROWID`);
    }
  }

  // 3) 数据最小化：选票里只该有 ballot_id 与 code，不该有 IP / UA / 时间戳
  for (const col of columnsOf('ballot')) {
    if (col === 'ballot_id' || col === 'code') continue;
    if (FORBIDDEN_IN_BALLOT.test(col)) {
      problems.push(`ballot 表出现了请求元数据列「${col}」—— 业务不需要，禁止落库`);
    }
  }

  // 4) view / trigger 能绕过上面的列集合检查，一律禁止
  const extra = db
    .prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger')`)
    .all();
  for (const row of extra) {
    problems.push(`库里存在 ${row.type}「${row.name}」—— 视图/触发器会绕过结构检查，必须删除`);
  }

  if (problems.length) {
    throw new Error(
      '数据库结构与预期不符，已拒绝启动：\n  - ' + problems.join('\n  - ') +
      '\n如需继续，请删除 data/pfxt.db 重建（会丢失已有数据）。'
    );
  }
}

assertSchemaIntegrity();

/* ------------------------------- 读写 helper ------------------------------- */

const getSetting = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

const setSetting = (key, value) => {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
};

const readConfig = () => ({
  activityName: getSetting('activity_name', '内部项目评比'),
  phase: getSetting('phase', 'open'),
  deadline: getSetting('deadline', ''),
  judgeCount: Number(getSetting('judge_count', '11')) || 11,
  contestants: db
    .prepare('SELECT id, seq, name, project, intro FROM contestant ORDER BY seq, id')
    .all(),
  dimensions: db
    .prepare('SELECT id, seq, name, weight, detail FROM dimension ORDER BY seq, id')
    .all(),
});

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  SCHEMA_VERSION,
  initResult,
  getSetting,
  setSetting,
  readConfig,
  assertSchemaIntegrity,
};
