'use strict';

/**
 * 起動中の Electron アプリに対して実際に写真を送り、
 * 保存結果と GUI の「取り込んだ写真」欄への反映までを通しで確認する。
 *   node scripts/e2e.js <PIN> <送る画像のパス>
 */

const fs = require('fs');
const path = require('path');

const PIN = process.argv[2];
const FILE = process.argv[3];
const PORT = Number(process.argv[4] || 8123);

if (!PIN || !FILE) {
  console.error('使い方: node scripts/e2e.js <PIN> <画像パス> [ポート]');
  process.exit(1);
}

async function evaluateInGui(expression) {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
  if (!page) throw new Error('GUI のページが見つかりません');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const result = await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) resolve(m.result.result.value);
    };
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }));
  });

  ws.close();
  return result;
}

(async () => {
  const buf = fs.readFileSync(FILE);
  const name = path.basename(FILE);
  console.log('送信: ' + name + '  ' + (buf.length / 1024).toFixed(0) + ' KB');

  const fd = new FormData();
  fd.append('clientName', name);
  fd.append('lastModified', String(fs.statSync(FILE).mtimeMs));
  fd.append('file', new Blob([buf]), name);

  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:' + PORT + '/api/upload', {
    method: 'POST',
    body: fd,
    headers: { cookie: 'ppt_token=' + PIN }
  });
  const body = await res.json();
  const ms = Date.now() - t0;

  console.log('\n--- サーバーの応答 (' + ms + 'ms) ---');
  console.log('HTTP        :', res.status);
  console.log('status      :', body.status);
  console.log('保存先      :', body.savedPath);
  console.log('JPEG 変換   :', body.converted);
  console.log('撮影日時    :', body.takenAt);
  console.log('サイズ      :', body.bytes ? (body.bytes / 1024).toFixed(0) + ' KB' : '-');

  if (body.status !== 'saved') {
    console.error('\n保存されませんでした: ' + (body.message || ''));
    process.exit(1);
  }
  if (!fs.existsSync(body.savedPath)) {
    console.error('\n応答のパスにファイルがありません');
    process.exit(1);
  }

  // GUI に反映されるまで少し待つ
  await new Promise((r) => setTimeout(r, 800));

  const gui = JSON.parse(await evaluateInGui(`(function () {
    var rows = document.querySelectorAll('#log .row');
    var first = rows[0];
    var img = first ? first.querySelector('img.thumb') : null;
    return JSON.stringify({
      rowCount: rows.length,
      name: first ? first.querySelector('.name').textContent : null,
      sub: first ? first.querySelector('.sub').textContent : null,
      size: first ? first.querySelector('.size').textContent : null,
      thumbLoaded: !!(img && img.naturalWidth > 0),
      thumbWidth: img ? img.naturalWidth : 0,
      counts: document.getElementById('counts').textContent,
      emptyHidden: document.getElementById('logEmpty').hidden
    });
  })()`));

  console.log('\n--- GUI への反映 ---');
  console.log('行数            :', gui.rowCount);
  console.log('ファイル名      :', gui.name);
  console.log('状態            :', gui.sub);
  console.log('サイズ表示      :', gui.size);
  console.log('サムネイル表示  :', gui.thumbLoaded, '(naturalWidth=' + gui.thumbWidth + ')');
  console.log('件数表示        :', gui.counts);

  const problems = [];
  if (gui.rowCount < 1) problems.push('GUI に行が追加されていない');
  if (!gui.thumbLoaded) problems.push('サムネイルが表示されていない（file:// の読み込み失敗）');
  if (gui.emptyHidden !== true) problems.push('「まだありません」が消えていない');

  console.log('\n========================================');
  if (problems.length) {
    problems.forEach((p) => console.log('  問題: ' + p));
  } else {
    console.log('  通しで正常に動作しました');
  }
  console.log('========================================');

  process.exit(problems.length ? 1 : 0);
})().catch((err) => {
  console.error('E2E に失敗:', err);
  process.exit(1);
});
