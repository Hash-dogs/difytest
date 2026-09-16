'use strict';

/** 局域网地址探测 —— server.js（启动横幅）与 admin.js（二维码）共用 */

const os = require('node:os');

const ENTRY_PATH = '/v'; // 固定入口，二维码指向这里

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** 评委二维码的可选地址列表。二维码必须用局域网 IP，
 *  不能用 location.origin —— 管理员多半是在 localhost 上打开后台的。 */
function entryUrls(port) {
  return lanAddresses().map((ip) => ({ ip, url: `http://${ip}:${port}${ENTRY_PATH}` }));
}

module.exports = { lanAddresses, entryUrls, ENTRY_PATH };
