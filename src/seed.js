'use strict';

/**
 * 首次运行初始化：默认参赛者名单、《评选细则》里的 5 个维度、管理员口令、阶段。
 * 幂等 —— 已有的数据不会被覆盖。
 *
 * 管理员口令同时存两份（PLAN §13 决策）：
 *   admin_password_hash  —— scrypt 哈希，登录时校验用
 *   admin_password_plain —— 明文，纯粹为了每次启动都能打印到终端
 * 哈希不可逆，没有明文就没法「启动即见口令」，所以这是刻意的取舍。
 */

const crypto = require('node:crypto');
const { db, getSetting, setSetting, DB_PATH } = require('./db');

// 来自活动方《Dify 工作流参赛名单》，后台可改
const DEFAULT_CONTESTANTS = [
  {
    name: '单福诚',
    project: '多部门即时业务训练+智能总结V1.3',
    intro: '解决新工程师快速熟悉业务，老员工强化技术记忆。知识问答“部件安装/磁体冷却/励磁/束流调试/功能验证”',
  },
  {
    name: '戈中元',
    project: '法规智能辅助评估系统',
    intro: '法规智能辅助评估系统：对照法规评审文件的合规',
  },
  {
    name: '姜添浩',
    project: '检测实验ISO17025合规审查系统v1.0',
    intro: '对照CNAS法规进行合格审查',
  },
];

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

const ADMIN_HASH_KEY = 'admin_password_hash';
const ADMIN_PLAIN_KEY = 'admin_password_plain';

/**
 * @returns {{
 *   seededContestants: boolean,
 *   seededDimensions: boolean,
 *   adminPassword: string|null,
 *   passwordState: 'created'|'regenerated'|'existing'
 * }}
 */
function ensureSeed() {
  const result = {
    seededContestants: false,
    seededDimensions: false,
    adminPassword: null,
    passwordState: 'existing',
  };

  const contestantCount = db.prepare('SELECT COUNT(*) AS n FROM contestant').get().n;
  if (contestantCount === 0) {
    const insert = db.prepare('INSERT INTO contestant (seq, name, project, intro) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      DEFAULT_CONTESTANTS.forEach((c, i) => insert.run(i + 1, c.name, c.project, c.intro));
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

  const storedHash = getSetting(ADMIN_HASH_KEY);
  const storedPlain = getSetting(ADMIN_PLAIN_KEY);

  if (storedHash && storedPlain) {
    // 正常路径：口令已存在，明文也在，直接拿去打印
    result.adminPassword = storedPlain;
    result.passwordState = 'existing';
  } else {
    // a) 全新库 —— 生成一个
    // b) 老库（本次改动之前建的）只存了哈希，不可逆、还原不出来，
    //    只能重新生成一个，并在启动横幅里明确告知旧口令已失效
    const plain = randomPassword();
    setSetting(ADMIN_HASH_KEY, hashPassword(plain));
    setSetting(ADMIN_PLAIN_KEY, plain);
    result.adminPassword = plain;
    result.passwordState = storedHash ? 'regenerated' : 'created';
  }

  if (getSetting('phase') === null) setSetting('phase', 'open');
  if (getSetting('activity_name') === null) setSetting('activity_name', '内部项目评比');
  if (getSetting('deadline') === null) setSetting('deadline', '');

  return result;
}

// 终端里中日韩字符占两列，标题长度又随状态变化，所以边框宽度得自己算。
// 用码点区间而不是正则字面量：纯 ASCII，不会被编码问题搞坏。
const isWide = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
  (cp >= 0x2e80 && cp <= 0x303e) || // 中日韩部首与标点（、。「」等）
  (cp >= 0x3041 && cp <= 0x33ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) || // 汉字主体
  (cp >= 0xa000 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) || // 全角逗号、括号等
  (cp >= 0xffe0 && cp <= 0xffe6);

const textWidth = (s) => [...s].reduce((n, ch) => n + (isWide(ch.codePointAt(0)) ? 2 : 1), 0);

const BOX_WIDTH = 46;

function boxLine(text, width) {
  const pad = Math.max(0, width - textWidth(text));
  const left = Math.floor(pad / 2);
  return '  │' + ' '.repeat(left) + text + ' '.repeat(pad - left) + '│';
}

function printSeedReport(result) {
  const lines = [];
  if (result.seededDimensions) lines.push('已写入 5 个默认维度（权重 30/25/20/15/10）');
  if (result.seededContestants) {
    lines.push(`已写入 ${DEFAULT_CONTESTANTS.length} 名默认参赛者：${DEFAULT_CONTESTANTS.map((c) => c.name).join('、')}`);
  }
  if (lines.length) console.log('[seed] ' + lines.join('\n[seed] '));

  if (!result.adminPassword) return;

  const title =
    {
      created: '首次运行，已生成管理员口令',
      regenerated: '旧库只有口令哈希，已重新生成',
      existing: '管理员口令（每次启动都会打印）',
    }[result.passwordState] || '管理员口令';

  console.log('');
  console.log('  ┌' + '─'.repeat(BOX_WIDTH) + '┐');
  console.log(boxLine(title, BOX_WIDTH));
  console.log('  └' + '─'.repeat(BOX_WIDTH) + '┘');
  console.log('');
  console.log('      管理员口令：' + result.adminPassword);
  console.log('');

  if (result.passwordState === 'regenerated') {
    console.log('  ⚠️ 这个数据库原本只存了口令哈希，哈希不可逆、还原不出旧口令，');
    console.log('     所以上面这个是刚刚新生成的 —— 旧口令从此刻起失效。');
    console.log('');
  }

  console.log('  口令每次启动都会打印在这里，忘了就往上翻。换成自己指定的：');
  console.log('');
  console.log('      npm run reset-password 你的新口令');
  console.log('');
}

if (require.main === module) {
  const result = ensureSeed();
  if (!result.seededContestants && !result.seededDimensions && result.passwordState === 'existing') {
    console.log('[seed] 数据库已初始化过，未改动任何业务数据：' + DB_PATH);
  }
  printSeedReport(result);
}

module.exports = {
  ensureSeed,
  printSeedReport,
  hashPassword,
  verifyPassword,
  randomPassword,
  DEFAULT_DIMENSIONS,
  ADMIN_HASH_KEY,
  ADMIN_PLAIN_KEY,
};
