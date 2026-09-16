'use strict';

/**
 * 首次运行初始化：默认参赛者占位、图片《评选细则》里的 5 个维度、管理员口令、阶段。
 * 幂等 —— 已有的数据不会被覆盖。
 */

const crypto = require('node:crypto');
const { db, getSetting, setSetting, DB_PATH } = require('./db');

const DEFAULT_CONTESTANTS = 11;

// 来自活动方《评选细则》表格，权重合计 100
const DEFAULT_DIMENSIONS = [
  { seq: 1, name: '现有业务流程契合度', weight: 30, detail: '是否对应明确、已存在且有实际使用频率的业务流程。' },
  { seq: 2, name: '长期重复使用价值', weight: 25, detail: '一次性使用，低频使用，长期高频使用' },
  { seq: 3, name: '效率提升价值', weight: 20, detail: '是否减少人工步骤、缩短处理时间或提升工作质量，并有可核验依据。' },
  { seq: 4, name: '完整性与可用性', weight: 15, detail: '是否能稳定运行，输出是否具备必要约束、校验和人工确认机制。' },
  { seq: 5, name: '复制推广价值', weight: 10, detail: '是否可在相似岗位或其他部门推广，推广条件与成本是否清晰。' },
];

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPassword(len = 10) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = crypto.scryptSync(plain, salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * @returns {{ seededContestants: boolean, seededDimensions: boolean, newPassword: string|null }}
 */
function ensureSeed() {
  const result = { seededContestants: false, seededDimensions: false, newPassword: null };

  const contestantCount = db.prepare('SELECT COUNT(*) AS n FROM contestant').get().n;
  if (contestantCount === 0) {
    const insert = db.prepare('INSERT INTO contestant (seq, name, project, intro) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 1; i <= DEFAULT_CONTESTANTS; i += 1) {
        insert.run(i, `参赛者 ${String(i).padStart(2, '0')}`, '（待填写项目名）', '');
      }
    })();
    result.seededContestants = true;
  }

  const dimensionCount = db.prepare('SELECT COUNT(*) AS n FROM dimension').get().n;
  if (dimensionCount === 0) {
    const insert = db.prepare('INSERT INTO dimension (seq, name, weight, detail) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (const d of DEFAULT_DIMENSIONS) insert.run(d.seq, d.name, d.weight, d.detail);
    })();
    result.seededDimensions = true;
  }

  if (!getSetting('admin_password_hash')) {
    const plain = randomPassword();
    setSetting('admin_password_hash', hashPassword(plain));
    result.newPassword = plain;
  }

  if (getSetting('phase') === null) setSetting('phase', 'open');
  if (getSetting('activity_name') === null) setSetting('activity_name', '内部项目评比');
  if (getSetting('deadline') === null) setSetting('deadline', '');

  return result;
}

function printSeedReport(result) {
  const lines = [];
  if (result.seededDimensions) lines.push('已写入 5 个默认维度（权重 30/25/20/15/10）');
  if (result.seededContestants) lines.push(`已写入 ${DEFAULT_CONTESTANTS} 个参赛者占位，请到后台改成真实姓名与项目名`);
  if (lines.length) console.log('[seed] ' + lines.join('\n[seed] '));

  if (result.newPassword) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  首次运行，已生成管理员口令（只显示这一次）  │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('');
    console.log('      管理员口令：' + result.newPassword);
    console.log('');
    console.log('  请立即抄下来。忘了就只能删掉 setting 表里的');
    console.log('  admin_password_hash 重新生成（会顺带清掉活动配置）。');
    console.log('');
  }
}

if (require.main === module) {
  const result = ensureSeed();
  if (!result.seededContestants && !result.seededDimensions && !result.newPassword) {
    console.log('[seed] 数据库已初始化过，未做任何改动：' + DB_PATH);
  }
  printSeedReport(result);
}

module.exports = { ensureSeed, printSeedReport, hashPassword, verifyPassword, randomPassword, DEFAULT_DIMENSIONS };
