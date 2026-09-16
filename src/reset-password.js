'use strict';

/**
 * 重置管理员口令：npm run reset-password
 *
 * 只替换 setting 表里的 admin_password_hash 一行 ——
 * 参赛者、维度、权重、已生成的链接、已提交的选票统统不动。
 *
 * 用命令行参数可以直接指定口令（不推荐，会留在 shell history 里）：
 *   node src/reset-password.js 我的新口令
 */

const { db, DB_PATH, getSetting, setSetting } = require('./db');
const { hashPassword, randomPassword } = require('./seed');

const given = process.argv[2];
const plain = given && given.trim() ? given.trim() : randomPassword();

if (given && plain.length < 6) {
  console.error('口令太短，至少 6 位。');
  process.exit(1);
}

const hadOne = Boolean(getSetting('admin_password_hash'));

setSetting('admin_password_hash', hashPassword(plain));

const counts = {
  contestants: db.prepare('SELECT COUNT(*) AS n FROM contestant').get().n,
  dimensions: db.prepare('SELECT COUNT(*) AS n FROM dimension').get().n,
  invites: db.prepare('SELECT COUNT(*) AS n FROM invite').get().n,
  ballots: db.prepare('SELECT COUNT(*) AS n FROM ballot').get().n,
};

console.log('');
console.log(hadOne ? '  管理员口令已重置。' : '  管理员口令已生成。');
console.log('');
console.log('      新口令：' + plain);
console.log('');
console.log('  数据库：' + DB_PATH);
console.log(
  `  未被改动：参赛者 ${counts.contestants} 位、维度 ${counts.dimensions} 个、` +
    `链接 ${counts.invites} 条、已提交选票 ${counts.ballots} 张`
);
console.log('');
console.log('  如果服务正在运行，请重启它让新口令生效（会话存在内存里）。');
console.log('');
