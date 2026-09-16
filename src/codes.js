'use strict';

/** 邀请码生成 —— 评委端（自助领取）与管理端（批量生成）共用 */

const crypto = require('node:crypto');

// 去掉 I / O / 0 / 1 等易混淆字符
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const randomCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

module.exports = { randomCode, CODE_ALPHABET, CODE_LENGTH };
