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
 *
 * 2026-09-22：除 `{{BASE}}` 外还支持业务占位符（现在只有 `{{ACTIVITY_NAME}}`，
 *    比赛当天把活动名显示在登录码页顶部，见 routes/vote.js 的 GET /v）。
 *    业务值一律转义 —— 活动名称是管理员在后台手填的，直接拼进 HTML 会被当成标签。
 */

const fs = require('node:fs');
const path = require('node:path');
const { BASE_PATH } = require('./net');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * 读页面文件，把 `{{KEY}}` 换成实际值。
 *   - `{{BASE}}`：口令前缀，原样注入（值是 src/net.js 里的常量，不含 HTML 特殊字符）
 *   - 其余：从 `vars` 取并转义；取不到就把占位符**留在页面上**，
 *     这样占位符名字写错时能一眼看见，而不是悄悄渲染成空白
 */
function renderPage(filename, vars = {}) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8');
  return html.replace(/\{\{(\w+)\}\}/g, (placeholder, key) => {
    if (key === 'BASE') return BASE_PATH;
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return placeholder;
    return escapeHtml(vars[key]);
  });
}

function sendPage(res, filename, vars) {
  // no-store：页面里带着口令前缀，被中间层缓存下来会在前缀轮换后继续吐旧地址
  res.type('html').set('Cache-Control', 'no-store').send(renderPage(filename, vars));
}

module.exports = { renderPage, sendPage, escapeHtml, PUBLIC_DIR };
