'use strict';

/**
 * 数据库入口：建库、建表、启动期结构断言、setting 读写helper。
 *
 * ⚠️ PLAN §5.2 匿名性约束（改动前必读）：
 *   1. ballot 表禁止出现 code 列，禁止任何指向 invite 的外键
 *   2. ballot 表禁止存任何时间戳
 *   3. ballot 与 score 必须 WITHOUT ROWID —— 否则隐式 rowid 按插入顺序增长，
 *      第 3 张票就是第 3 个提交的人，配合 invite.submitted_at 即可还原身份
 *   4. 提交接口禁止把 code / IP / User-Agent / 请求时间写入 ballot 或 score
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'pfxt.db');

const SCHEMA = `
-- 参赛者（后台可配）
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

-- 邀请码表：只回答「谁投了」，绝不回答「投了什么」
CREATE TABLE IF NOT EXISTS invite (
  code         TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  opened_at    INTEGER,
  submitted_at INTEGER
);

-- 选票表：与 invite 无任何关联。⚠️ 只允许有 ballot_id 这一列。
CREATE TABLE IF NOT EXISTS ballot (
  ballot_id TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS score (
  ballot_id     TEXT    NOT NULL,
  contestant_id INTEGER NOT NULL,
  dimension_id  INTEGER NOT NULL,
  value         INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  PRIMARY KEY (ballot_id, contestant_id, dimension_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(SCHEMA);

/**
 * 启动期断言：即使 db 文件是别人手工建的 / 被改过，也要保证匿名前提成立。
 * 这是 PLAN §9.1 与 §10「匿名性」验收项的最后一道防线。
 */
function assertAnonymousSchema() {
  const problems = [];

  const ballotCols = db.prepare('PRAGMA table_info(ballot)').all().map((c) => c.name);
  const scoreCols = db.prepare('PRAGMA table_info(score)').all().map((c) => c.name);

  if (ballotCols.length !== 1 || ballotCols[0] !== 'ballot_id') {
    problems.push(`ballot 表列异常：[${ballotCols.join(', ')}]，只允许存在 ballot_id 一列（不得有 code / 时间戳）`);
  }
  if (scoreCols.includes('code') || scoreCols.includes('created_at')) {
    problems.push('score 表出现了 code / created_at 等可关联列');
  }

  for (const table of ['ballot', 'score']) {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
    if (!row || !/WITHOUT\s+ROWID/i.test(row.sql)) {
      problems.push(`${table} 表缺少 WITHOUT ROWID —— 隐式 rowid 会泄露选票插入顺序`);
    }
  }

  if (problems.length) {
    throw new Error(
      '数据库结构违反了匿名性约束，已拒绝启动：\n  - ' + problems.join('\n  - ') +
      '\n如需继续，请删除 data/pfxt.db 重建（会丢失已有数据）。'
    );
  }
}

assertAnonymousSchema();

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
  contestants: db
    .prepare('SELECT id, seq, name, project, intro FROM contestant ORDER BY seq, id')
    .all(),
  dimensions: db
    .prepare('SELECT id, seq, name, weight, detail FROM dimension ORDER BY seq, id')
    .all(),
});

module.exports = { db, DB_PATH, DATA_DIR, getSetting, setSetting, readConfig, assertAnonymousSchema };
