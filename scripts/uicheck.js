'use strict';

/**
 * 起動中の Electron に DevTools プロトコルでつなぎ、GUI が実際に描画されたかを確認する。
 *   npx electron . --remote-debugging-port=9222
 *   node scripts/uicheck.js
 * file:// + CSP の組み合わせで renderer が止まっていないかを実測するのが目的。
 */

const PORT = 9222;

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json');
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('renderer のページが見つかりませんでした');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WebSocket 接続に失敗: ' + (e.message || '')));
  });
}

(async () => {
  const page = await findPage();
  const ws = await connect(page.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('例外: ' + JSON.stringify(msg.params.exceptionDetails.text || '') +
        ' ' + (msg.params.exceptionDetails.exception || {}).description);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push('[' + msg.params.entry.source + '] ' + msg.params.entry.text);
    }
  };

  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await new Promise((r) => setTimeout(r, 1500));   // 起動直後の描画を待つ

  const probe = `(function () {
    var qr = document.getElementById('qr');
    return JSON.stringify({
      preloadBridge: typeof window.ppt === 'object' && typeof window.ppt.getState === 'function',
      badge: (document.getElementById('statusBadge') || {}).textContent,
      url: (document.getElementById('url') || {}).textContent,
      pin: (document.getElementById('pin') || {}).textContent,
      saveDir: (document.getElementById('saveDir') || {}).textContent,
      qrIsDataUrl: !!(qr && qr.src && qr.src.indexOf('data:image') === 0),
      qrRendered: !!(qr && qr.naturalWidth > 0),
      qrNaturalWidth: qr ? qr.naturalWidth : 0,
      addrOptions: Array.prototype.map.call(
        (document.getElementById('addrSelect') || {options: []}).options,
        function (o) { return o.textContent; }),
      qualityValue: (document.getElementById('quality') || {}).value,
      dateFolders: (document.getElementById('dateFolders') || {}).checked,
      cardCount: document.querySelectorAll('.card').length
    });
  })()`;

  const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.error('評価時に例外:', JSON.stringify(r.result.exceptionDetails));
    process.exit(1);
  }

  const state = JSON.parse(r.result.result.value);

  console.log('--- GUI の実測 ---');
  console.log('preload の橋渡し(window.ppt) :', state.preloadBridge);
  console.log('状態バッジ                  :', state.badge);
  console.log('接続 URL                    :', state.url);
  console.log('PIN                         :', state.pin);
  console.log('保存先                      :', state.saveDir);
  console.log('QR が data URL              :', state.qrIsDataUrl);
  console.log('QR が実際に描画された       :', state.qrRendered, '(naturalWidth=' + state.qrNaturalWidth + ')');
  console.log('ネットワーク候補            :', state.addrOptions.join(' | '));
  console.log('画質セレクタの値            :', state.qualityValue);
  console.log('日付フォルダ                :', state.dateFolders);
  console.log('カード数                    :', state.cardCount);

  console.log('\n--- コンソールのエラー ---');
  if (consoleErrors.length === 0) console.log('(なし)');
  else consoleErrors.forEach((e) => console.log('  ' + e));

  const problems = [];
  if (!state.preloadBridge) problems.push('preload の contextBridge が効いていない');
  if (!state.qrRendered) problems.push('QR コードが描画されていない（CSP で img がブロックされた可能性）');
  if (state.badge !== '待受中') problems.push('サーバーが待受になっていない: ' + state.badge);
  if (!state.url || state.url === '—') problems.push('接続 URL が出ていない');
  if (!/^\d{6}$/.test(state.pin || '')) problems.push('PIN が6桁で出ていない: ' + state.pin);
  if (!state.addrOptions.length) problems.push('ネットワーク候補が空');
  if (consoleErrors.length) problems.push('コンソールにエラーがある');

  console.log('\n========================================');
  if (problems.length) {
    console.log('  問題あり:');
    problems.forEach((p) => console.log('   - ' + p));
  } else {
    console.log('  GUI は正常に描画されています');
  }
  console.log('========================================');

  ws.close();
  process.exit(problems.length ? 1 : 0);
})().catch((err) => {
  console.error('確認に失敗:', err.message);
  process.exit(1);
});
