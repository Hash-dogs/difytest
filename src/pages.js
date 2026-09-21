'use strict';

/**
 * 页面下发（server.js 与 routes/vote.js 共用）。
 *
 * 页面里写着 `{{BASE}}` 占位符，下发时替换成实际的口令前缀（见 src/net.js）。
 *
 * ⚠️ 为什么不能让页面用相对路径绕开这一步：
 *    `/v/:code` 这种深层路径下，相对路径 `vote.css` 会被浏览器算成
 *    `/v/vote.css` —— 资源全 404，且只在评委页出现、后台看不出来。
 *    所以统一走占位符 + 绝对路径，改前缀时只改一处。
 */

const fs = require('node:fs');
const path = require('node:path');
const { BASE_PATH } = require('./net');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** 读页面文件并把 `{{BASE}}` 换成实际前缀 */
function renderPage(filename) {
  return fs
    .readFileSync(path.join(PUBLIC_DIR, filename), 'utf8')
    .split('{{BASE}}')
    .join(BASE_PATH);
}

function sendPage(res, filename) {
  // no-store：页面里带着口令前缀，被中间层缓存下来会在前缀轮换后继续吐旧地址
  res.type('html').set('Cache-Control', 'no-store').send(renderPage(filename));
}

module.exports = { renderPage, sendPage, PUBLIC_DIR };
