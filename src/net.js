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

/** 评委二维码的可选地址。二维码必须用局域网 IP，不能用 location.origin ——
 *  管理员多半是在 localhost 上打开后台的。 */
function entryUrls(port) {
  return listLanInterfaces().map((i) => ({
    ip: i.ip,
    name: i.name,
    virtual: i.virtual,
    url: `http://${i.ip}:${port}${ENTRY_PATH}`,
  }));
}

module.exports = { lanAddresses, listLanInterfaces, entryUrls, ENTRY_PATH };
