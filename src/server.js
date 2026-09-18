'use strict';

const path = require('node:path');
const express = require('express');

const { ensureSeed, printSeedReport } = require('./seed');
const { DB_PATH } = require('./db');
const { entryUrls } = require('./net');
const voteRoutes = require('./routes/vote');
const adminRoutes = require('./routes/admin');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', false);
app.disable('x-powered-by');

app.use(express.json({ limit: '512kb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.use(voteRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'not_found', message: '接口不存在。' });
  }
  res.status(404).send('404 Not Found');
});

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
  console.log('   管理后台（本机）：http://localhost:' + PORT + '/admin');
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
        ? 'set PORT=3001 && npm start'
        : 'PORT=3001 npm start';
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
    console.error('    PORT=3000 npm start');
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
