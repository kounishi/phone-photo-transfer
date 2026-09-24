'use strict';

/**
 * 大量の写真を送ってもメモリが膨らまないこと（ストリーム処理になっていること）を確かめる。
 *   node scripts/loadtest.js [枚数]
 */

const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const { createServer } = require('../src/main/server');
const jpegjs = require('jpeg-js');

const COUNT = Number(process.argv[2] || 60);
const PARALLEL = 2;                 // iPhone 側と同じ同時送信数

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(0) + ' MB'; }

// 1枚 2MB 前後の JPEG を作る（ノイズなので圧縮が効かない＝実写に近いサイズ）
function makeBigJpeg(seed) {
  const width = 1600, height = 1200;
  const data = Buffer.alloc(width * height * 4);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < width * height; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    data[i * 4] = x & 255;
    data[i * 4 + 1] = (x >> 8) & 255;
    data[i * 4 + 2] = (x >> 16) & 255;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpegjs.encode({ data, width, height }, 92).data);
}

(async () => {
  const saveDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ppt-load-'));
  const settings = { saveDir, port: 18200, jpegQuality: 0.92, useDateFolders: true, preferredAddress: '' };

  const server = createServer({ getSettings: () => settings, emit: () => {} });
  const info = await server.start();
  const url = 'http://127.0.0.1:' + info.port + '/api/upload';
  const cookie = 'ppt_token=' + info.pin;

  console.log('枚数: ' + COUNT + '  同時送信: ' + PARALLEL);
  process.stdout.write('テスト画像を生成中… ');
  const photos = [];
  for (let i = 0; i < COUNT; i++) photos.push(makeBigJpeg(i + 1));
  const totalBytes = photos.reduce((a, b) => a + b.length, 0);
  console.log('合計 ' + mb(totalBytes) + '（1枚あたり約 ' + mb(totalBytes / COUNT) + '）\n');

  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 100);

  let saved = 0, dup = 0, failed = 0, done = 0;
  const queue = photos.map((buf, i) => ({ buf, i }));
  const t0 = Date.now();

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const fd = new FormData();
      fd.append('clientName', 'LOAD_' + String(item.i).padStart(4, '0') + '.jpg');
      fd.append('lastModified', String(Date.now()));
      fd.append('file', new Blob([item.buf]), 'photo.jpg');

      try {
        const res = await fetch(url, { method: 'POST', body: fd, headers: { cookie } });
        const body = await res.json();
        if (body.status === 'saved') saved++;
        else if (body.status === 'duplicate') dup++;
        else failed++;
      } catch {
        failed++;
      }
      done++;
      if (done % 10 === 0) {
        process.stdout.write('  ' + done + '/' + COUNT +
          '  RSS ' + mb(process.memoryUsage().rss) + '\n');
      }
    }
  }

  await Promise.all(Array.from({ length: PARALLEL }, worker));
  clearInterval(sampler);

  const secs = (Date.now() - t0) / 1000;
  const files = [];
  for (const d of await fsp.readdir(saveDir, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== '.tmp') {
      files.push(...(await fsp.readdir(path.join(saveDir, d.name))));
    }
  }
  const leftover = await fsp.readdir(path.join(saveDir, '.tmp'));

  await server.stop();

  console.log('\n--- 結果 ---');
  console.log('保存 ' + saved + ' / 重複 ' + dup + ' / 失敗 ' + failed);
  console.log('実際のファイル数     : ' + files.length);
  console.log('一時ファイルの残骸   : ' + leftover.length);
  console.log('所要時間             : ' + secs.toFixed(1) + ' 秒 (' +
              (totalBytes / 1024 / 1024 / secs).toFixed(1) + ' MB/秒)');
  console.log('\n--- メモリ ---');
  console.log('開始時の RSS         : ' + mb(baseline));
  console.log('ピーク RSS           : ' + mb(peak));
  console.log('増加分               : ' + mb(peak - baseline));

  // 送信データ総量に比例して増えていたらストリーム処理になっていない
  const growth = peak - baseline;
  const okMemory = growth < totalBytes / 4;
  console.log('\n========================================');
  console.log(okMemory
    ? '  メモリは送信量に比例せず、ストリーム処理が効いています'
    : '  メモリが送信量に比例して増えています（バッファに溜めている疑い）');
  console.log('  判定基準: 増加分 ' + mb(growth) + ' < 送信量の1/4 ' + mb(totalBytes / 4));
  console.log('========================================');

  await fsp.rm(saveDir, { recursive: true, force: true });

  const problems = (saved !== COUNT) || leftover.length > 0 || !okMemory;
  process.exit(problems ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
