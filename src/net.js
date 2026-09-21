'use strict';

/**
 * 局域网地址探测 —— server.js（启动横幅）与 admin.js（二维码）共用
 *
 * ⚠️ Linux 上 os.networkInterfaces() 会返回一堆虚拟网卡（docker0 / br-xxx / veth /
 *    virbr0 / tailscale0 …）。如果直接取第一个，二维码很可能指向 172.17.0.1
 *    这类容器网桥，评委手机根本连不上。所以这里要排序，真实网卡优先。
 *    Windows 上通常只有一两张网卡，排序不影响结果。
 */

const os = require('node:os');

const ENTRY_PATH = '/v'; // 固定入口，二维码指向这里

/**
 * 口令前缀（URL 里的那一长串随机字符）—— **全站唯一真源**。
 *
 * 为什么要有它：部署形态是「公网 IP 直连、不用域名、不备案」（PLAN §4）。
 * 这意味着 80/443 之外的那一个端口一旦放行，`/admin` 就等于挂在公网上裸奔 ——
 * 登录口令是唯一的门，而门是可以被暴力尝试的。加一段只有自己人知道的前缀后，
 * 扫描器连「这里有个后台」都发现不了，等于把门口藏起来。
 *
 * ⚠️ 它**不是**权限控制，只是「不被发现」。真正的鉴权仍然是管理员口令 +
 *    内存会话（见 src/routes/admin.js），前缀泄露的后果是退回原状、不是失守。
 *
 * 所有路径都要经 `withBase()` 拼；**不要**在别处硬编码这段前缀，也不要
 * 在代码里写 `'/api/...'` 这类绝对路径 —— 改前缀时那一定会漏掉几处。
 *
 * 用 PFXT_BASE_PATH 覆盖。显式设为空串（`PFXT_BASE_PATH=`）表示不加前缀、
 * 服务退回根路径（本机开发、或前端的反向代理已经把前缀摘掉时用）。
 */
const DEFAULT_BASE_PATH = '/M7xHqlq9giMXCJ6ohGzbIgw7tkwrfXSkjiraUXJw9tDZJF6SKobSkmggtMXpooDW';

/**
 * 规范化成 `/xxx` 的样子（前导斜杠有、结尾斜杠无、空串表示不加前缀）。
 * 顺带过滤掉非法字符 —— 这个值会被插进 HTML 与 `Set-Cookie` 的 Path，
 * 放任引号/分号进去会直接变成一个注入点。
 */
function normalizeBasePath(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .trim()
    .replace(/[^A-Za-z0-9/._~-]/g, '');
  if (!cleaned || cleaned === '/') return '';
  const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return withLead.replace(/\/+$/, '');
}

const BASE_PATH = normalizeBasePath(process.env.PFXT_BASE_PATH ?? DEFAULT_BASE_PATH);

/** 给任意站内路径加上前缀。`''` 前缀时原样返回，调用方不必分支。 */
const withBase = (p) => BASE_PATH + p;

// 虚拟/隧道网卡 —— 这些地址别的设备访问不到，必须排到最后
const VIRTUAL_PATTERNS = [
  // Linux
  /^docker/i,
  /^br-/i,
  /^veth/i,
  /^virbr/i,
  /^vmnet/i,
  /^vboxnet/i,
  /^tun/i,
  /^tap/i,
  /^tailscale/i,
  /^zt/i,
  /^wg/i,
  /^dummy/i,
  /loopback/i,
  // Windows（Hyper-V / WSL / 虚拟机网卡）
  /^vethernet/i,
  /hyper-?v/i,
  /virtualbox/i,
  /vmware/i,
  /^bluetooth/i,
  /^npcap/i,
];

// 蜂窝/移动宽带网卡 —— 是真网卡，但其他手机连不上，排在真实局域网之后
const MOBILE_PATTERNS = [/手机网络/, /mobile/i, /wwan/i, /cellular/i, /^rmnet/i, /^wwp/i, /^cdc/i];

const isVirtualName = (name) => VIRTUAL_PATTERNS.some((re) => re.test(name));
const isMobileName = (name) => MOBILE_PATTERNS.some((re) => re.test(name));

/** 网段越常见越靠前：192.168 > 10 > 172.16–31；169.254 是没拿到 DHCP 的兜底地址，最靠后 */
function rangeScore(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 169 && b === 254) return 9;
  return 5;
}

/**
 * 排序权重：越小越可能是评委手机能访问到的那个。
 * 虚拟网卡 → 1000+；蜂窝网卡 → 500+；其余按网段常见程度 0–9。
 */
function priorityOf(name, ip) {
  if (isVirtualName(name)) return 1000 + rangeScore(ip);
  if (isMobileName(name)) return 500 + rangeScore(ip);
  return rangeScore(ip);
}

/** 按「真实网卡优先 → 常见网段优先 → 名字」排序后的所有候选地址 */
function listLanInterfaces() {
  const found = [];

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      found.push({
        name,
        ip: net.address,
        virtual: isVirtualName(name),
        score: priorityOf(name, net.address),
      });
    }
  }

  found.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  return found;
}

/** 供启动横幅使用：按优先级排好的 IP 列表 */
function lanAddresses() {
  return listLanInterfaces().map((i) => i.ip);
}

/** 从 URL 里取出主机名（去掉协议与端口）；解析不了就原样返回，别让配置问题炸掉启动 */
function hostOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * 评委入口的可选地址。**不能用 location.origin** —— 管理员多半是在
 * localhost 或内网地址上打开后台的。
 *
 * ⚠️ 部署到云服务器后，`os.networkInterfaces()` 只会返回内网 IP（10.x），
 * 拼出来的 `http://10.x.x.x:3001/v` 评委根本连不上。所以允许用环境变量
 * **PFXT_PUBLIC_URL** 显式指定公网地址，它优先返回，局域网地址排在后面
 * 供本机调试时核对（PLAN §4）。
 */
function entryUrls(port) {
  const out = [];

  const configured = String(process.env.PFXT_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) {
    const base = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
    // 两种写法都接受：写全（已含口令前缀）就原样用，只写主机就替它补上前缀。
    // 少了这一步，把前缀写进 PFXT_PUBLIC_URL 会拼出 `…/口令/口令/v` 这种地址 ——
    // 二维码扫出来是 404，而现场没时间查为什么。
    const full = base.endsWith(BASE_PATH) || !BASE_PATH ? base : base + BASE_PATH;
    out.push({
      ip: hostOf(base),
      name: '公网地址（PFXT_PUBLIC_URL）',
      virtual: false,
      configured: true,
      url: full + ENTRY_PATH,
    });
  }

  for (const i of listLanInterfaces()) {
    out.push({
      ip: i.ip,
      name: i.name,
      virtual: i.virtual,
      configured: false,
      url: `http://${i.ip}:${port}${withBase(ENTRY_PATH)}`,
    });
  }

  return out;
}

module.exports = {
  lanAddresses,
  listLanInterfaces,
  entryUrls,
  hostOf,
  withBase,
  ENTRY_PATH,
  BASE_PATH,
  DEFAULT_BASE_PATH,
};
