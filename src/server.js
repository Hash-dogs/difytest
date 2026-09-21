'use strict';

const express = require('express');

const { ensureSeed, printSeedReport } = require('./seed');
const { DB_PATH } = require('./db');
const { entryUrls, withBase, isGuardedMethod, tokenOk, BASE_PATH, API_TOKEN, TOKEN_HEADER } = require('./net');
const { sendPage, PUBLIC_DIR } = require('./pages');
const voteRoutes = require('./routes/vote');
const adminRoutes = require('./routes/admin');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.set('trust proxy', false);
app.disable('x-powered-by');

/**
 * 全站唯一的 404 —— 「路由不存在」与「暗号不对」**必须走同一个出口**。
 *
 * ⚠️ 这一点是硬要求，不是代码整洁问题：早先守卫自己 `send('404 Not Found')`，
 *    而 `/api/*` 的兜底 404 回的是 JSON。同一个 `GET /api/nonexistent`，
 *    令牌对不对会得到**两种形状不同**的响应 —— 拿它当判据就能把令牌试出来，
 *    暗号也就白设了。所以两处共用一个函数，逐字节一致。
 */
function send404(req, res) {
  if (req.path.startsWith(withBase('/api/'))) {
    return res.status(404).json({ ok: false, error: 'not_found', message: '接口不存在。' });
  }
  res.status(404).send('404 Not Found');
}

/**
 * 口令请求头守卫（PLAN §4.1）—— 放在**最前面**，被挡下的请求连 body 都不解析。
 *
 * ⚠️ 只拦 GET / HEAD（`isGuardedMethod`，理由写在 src/net.js）。POST / PUT 放行。
 *
 * ⚠️ 挡下来时回 404，不是 401/403 —— 回 403 等于告诉扫描器「这个头我认识，
 *    只是值不对」。拒绝原因打在**控制台**上（对外不可见，对内看得见）。
 *
 * ⚠️ 残留信号（无法消除，评估过可接受）：**真实存在**的路由在令牌正确时回
 *    401/200，令牌不对时回 404，这个差异本身会透露「令牌猜对了没」。
 *    这是任何「请求头暗号」方案的固有代价。不构成实际风险：口令是 64 字符
 *    （可 base64url 解码为 48 字节）的随机串，逐次试错枚举不可行 ——
 *    与登录码依赖的是同一类假设（见 routes/vote.js 里「短码空间」那段）。
 */
app.use((req, res, next) => {
  if (!isGuardedMethod(req.method) || tokenOk(req)) return next();

  console.warn(
    `[guard] 拒绝 ${req.method} ${req.originalUrl}  ip=${req.ip}  ` +
      `token=${req.get(TOKEN_HEADER) ? '不匹配' : '缺失'}`
  );
  send404(req, res);
});

app.use(express.json({ limit: '512kb' }));

/**
 * 整站挂在口令前缀下（PLAN §4）。
 *
 * ⚠️ 前缀是**整站**的，不是只管页面：`/api/admin/*` 也必须在前缀之内。
 *    只藏页面而把接口留在根路径，等于把口令验证留给扫描器去猜 —— 前缀就没意义了。
 */
const staticFiles = express.static(PUBLIC_DIR, { index: false });
app.use(BASE_PATH || '/', (req, res, next) => {
  // 页面一律走 sendPage 下发（要替换 {{BASE}} 占位符）。
  // 放静态中间件直接吐 .html 的话，`/admin.html` 会渲染出资源全 404 的破页面，
  // 而真正的后台地址是 `/admin` —— 这种「看起来坏了」比干脆 404 更难排查。
  if (req.path.endsWith('.html')) return next();
  staticFiles(req, res, next);
});

app.get(BASE_PATH || '/', (req, res) => res.redirect(withBase('/admin')));
app.get(withBase('/admin'), (req, res) => sendPage(res, 'admin.html'));

app.use(BASE_PATH || '/', voteRoutes);
app.use(BASE_PATH || '/', adminRoutes);

// 前缀之外的任何路径也回同一个 404（与守卫共用 send404，见上面的说明）
app.use(send404);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'bad_json', message: '请求体不是合法的 JSON。' });
  }
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ ok: false, error: 'internal', message: status >= 500 ? '服务器内部错误。' : err.message });
});

const result = ensureSeed();

const server = app.listen(PORT, HOST, () => {
  const urls = entryUrls(PORT);
  const configured = urls.filter((u) => u.configured);
  const ifaces = urls.filter((u) => !u.configured);

  console.log('');
  console.log('  ════════════════════════════════════════════════');
  console.log('   演讲比赛匿名打分系统已启动');
  console.log('  ════════════════════════════════════════════════');
  console.log('');
  console.log('   管理后台（本机）：http://localhost:' + PORT + withBase('/admin'));
  // 两道暗号各自的实际状态。现场排查第一眼就看这里 —— 别人问「为什么 404」时，
  // 先确认他带的是哪一道、这一道是不是开着。
  console.log(
    BASE_PATH
      ? '   🔑 路径前缀：' + BASE_PATH
      : '   ·  路径前缀：未启用（URL 就是 ip:' + PORT + '/v）'
  );
  if (API_TOKEN) {
    console.log(`   🔑 请求头令牌：${TOKEN_HEADER}: ${API_TOKEN}`);
    console.log('      ⚠️ 只对 GET / HEAD 生效，且**浏览器地址栏发不出自定义请求头** ——');
    console.log('         必须由公网映射/网关在转发时代加，否则页面会 404。');
    console.log('         curl 自测：curl -H "' + TOKEN_HEADER + ': ' + API_TOKEN + '" http://127.0.0.1:' + PORT + withBase('/v'));
  } else {
    console.log('   ⚠️ 请求头令牌：未启用（PFXT_TOKEN 为空）');
  }
  if (!BASE_PATH && !API_TOKEN) {
    console.log('   ⚠️⚠️ 两道暗号都没开，后台直接挂在公网上 —— 只应在纯内网调试时出现');
  }
  console.log('');

  if (configured.length) {
    console.log('   ✅ 评委入口（公网地址，二维码与后台都指向它）：');
    console.log('      ' + configured[0].url);
    console.log('');
    if (ifaces.length) {
      console.log('   本机网卡地址（仅供核对，不要发给评委）：');
      ifaces.forEach((i) => console.log(`      ${i.url}   (${i.name})`));
      console.log('');
    }
  } else if (ifaces.length) {
    console.log('   ⚠️ 没有设置 PFXT_PUBLIC_URL —— 下面是本机探测到的地址：');
    ifaces.forEach((i, idx) => {
      const tag = (idx === 0 ? ' ← 默认' : '') + (i.virtual ? '  [虚拟网卡，手机多半连不上]' : '');
      console.log(`      ${i.url}   (${i.name})${tag}`);
    });
    console.log('');
    console.log('   ⚠️ 部署到云服务器时**必须**设置 PFXT_PUBLIC_URL，否则 os.networkInterfaces()');
    console.log('      只会返回内网 IP（10.x），二维码会指向评委根本连不上的地址：');
    console.log('         PFXT_PUBLIC_URL=http://<公网IP>:' + PORT);
    console.log('');
  } else {
    console.log('   ⚠️ 没有检测到任何可用地址，手机可能访问不到。');
    console.log('');
  }
  console.log('   数据库：' + DB_PATH);
  console.log('');
  console.log('   按 Ctrl+C 停止服务。');
  console.log('');

  // 放在最后：口令是每次启动都要看的东西，让它成为屏幕上最后一屏内容
  printSeedReport(result);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const hint =
      process.platform === 'win32'
        ? `set PORT=${PORT + 1} && npm start`
        : `PORT=${PORT + 1} npm start`;
    console.error('');
    console.error(`  端口 ${PORT} 已被占用。`);
    console.error(`  换个端口再启动：  ${hint}`);
    console.error('');
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error('');
    console.error(`  没有权限绑定端口 ${PORT}。`);
    console.error('  1024 以下的端口需要 root；换个高位端口即可，例如：');
    console.error('    PORT=3001 npm start');
    console.error('');
    process.exit(1);
  }
  throw err;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在停止服务……');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
