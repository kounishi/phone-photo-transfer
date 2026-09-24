'use strict';

const os = require('os');

// このPCは IPv4 が複数ある（Wi-Fi / VPN / APIPA など）。
// 自動判定だけに頼ると外すので、スコア順に並べて GUI で選べるようにする。
function scoreCandidate(ifaceName, address) {
  let score = 0;

  // 169.254.* は APIPA（DHCP に失敗したリンクローカル）。実質つながらないので最下位。
  if (address.startsWith('169.254.')) return -100;

  // プライベートアドレス帯の優先度
  if (address.startsWith('192.168.')) score += 50;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 30;
  else if (address.startsWith('10.')) score += 40;
  else score += 10; // グローバルらしきもの

  // インタフェース名から用途を推測（Windows は日本語名のことがある）
  const n = ifaceName.toLowerCase();
  if (n.includes('wi-fi') || n.includes('wifi') || n.includes('wireless') || n.includes('wlan')) score += 25;
  else if (n.includes('イーサネット') || n.includes('ethernet')) score += 20;

  // VPN / 仮想アダプタは母艦とスマホが同じ網にいないことが多いので下げる
  if (n.includes('vpn') || n.includes('virtual') || n.includes('vmware') ||
      n.includes('hyper-v') || n.includes('vethernet') || n.includes('loopback') ||
      n.includes('bluetooth') || n.includes('tailscale') || n.includes('zerotier')) {
    score -= 40;
  }

  return score;
}

/**
 * 接続先候補を「つながりそうな順」で返す。
 * @returns {Array<{name: string, address: string, score: number, label: string}>}
 */
function listCandidates() {
  const ifaces = os.networkInterfaces();
  const out = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      // Node 18+ は family が 'IPv4' / 4 の両方ありうる
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4 || a.internal) continue;
      out.push({
        name,
        address: a.address,
        score: scoreCandidate(name, a.address),
        label: `${a.address}  (${name})`
      });
    }
  }

  out.sort((x, y) => y.score - x.score || x.address.localeCompare(y.address));
  return out;
}

/** 一番つながりそうなアドレス。候補が無ければ localhost。 */
function bestAddress() {
  const list = listCandidates();
  return list.length ? list[0].address : '127.0.0.1';
}

module.exports = { listCandidates, bestAddress };
