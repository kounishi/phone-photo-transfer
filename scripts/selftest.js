'use strict';

/**
 * Electron 抜きで server.js + pipeline.js を通しで叩く検証スクリプト。
 *   node scripts/selftest.js [検証に使う HEIC のパス]
 * HEIC を渡さない場合は HEIC 関連の検証だけ飛ばす。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const assert = require('assert');

const { createServer } = require('../src/main/server');
const piexif = require('piexifjs');
const jpegjs = require('jpeg-js');

const heicArg = process.argv[2] || null;

let pass = 0;
let fail = 0;

function ok(name, extra) {
  pass++;
  console.log('  PASS  ' + name + (extra ? '   ' + extra : ''));
}
function ng(name, err) {
  fail++;
  console.log('  FAIL  ' + name + '\n        ' + (err && err.message ? err.message : err));
}
async function test(name, fn) {
  try { const extra = await fn(); ok(name, extra); }
  catch (err) { ng(name, err); }
}

/* ---------- テスト用の画像を作る ---------- */

function makeJpeg(width, height, tint) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 0] = (i * 7 + tint) % 256;
    data[i * 4 + 1] = (i * 13 + tint) % 256;
    data[i * 4 + 2] = tint % 256;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpegjs.encode({ data, width, height }, 90).data);
}

// 撮影日時つきの JPEG。日付フォルダ分けと mtime の検証に使う。
function makeJpegWithExif(dateStr, tint) {
  const base = makeJpeg(64, 48, tint);
  const zeroth = {};
  const exif = {};
  zeroth[piexif.ImageIFD.Make] = 'Apple';
  zeroth[piexif.ImageIFD.Model] = 'iPhone SelfTest';
  zeroth[piexif.ImageIFD.DateTime] = dateStr;
  exif[piexif.ExifIFD.DateTimeOriginal] = dateStr;
  const dump = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': {} });
  return Buffer.from(piexif.insert(dump, base.toString('binary')), 'binary');
}

function makePng() {
  // 1x1 の最小 PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

/* ---------- HTTP ---------- */

async function post(url, buffer, fileName, lastModified, cookie) {
  const fd = new FormData();
  fd.append('clientName', fileName);
  if (lastModified !== undefined) fd.append('lastModified', String(lastModified));
  fd.append('file', new Blob([buffer]), fileName);

  const headers = {};
  if (cookie) headers.cookie = cookie;

  const res = await fetch(url, { method: 'POST', body: fd, headers });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

/* ---------- 本体 ---------- */

(async function main() {
  const saveDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ppt-selftest-'));
  console.log('保存先(一時): ' + saveDir + '\n');

  const settings = {
    saveDir,
    port: 18123,
    jpegQuality: 0.92,
    useDateFolders: true,
    preferredAddress: ''
  };

  const events = [];
  const server = createServer({
    getSettings: () => settings,
    emit: (event, payload) => events.push({ event, payload })
  });

  const info = await server.start();
  const base = 'http://127.0.0.1:' + info.port;
  const cookie = 'ppt_token=' + info.pin;
  console.log('起動: ' + base + '  PIN=' + info.pin + '\n');

  /* --- 認証 --- */
  console.log('[認証]');

  await test('PIN 無しのアップロードは 401 で弾かれる', async () => {
    const r = await post(base + '/api/upload', makeJpeg(32, 32, 1), 'a.jpg', Date.now(), null);
    assert.strictEqual(r.status, 401);
  });

  await test('誤った PIN のアップロードも 401', async () => {
    const r = await post(base + '/api/upload', makeJpeg(32, 32, 1), 'a.jpg', Date.now(), 'ppt_token=999999');
    assert.strictEqual(r.status, 401);
  });

  await test('PIN 無しで / を開くと PIN 入力画面が出る', async () => {
    const res = await fetch(base + '/');
    const html = await res.text();
    assert.strictEqual(res.status, 401);
    assert.ok(html.includes('PIN を入力'), 'PIN 入力画面が返っていない');
  });

  await test('正しい PIN なら / でページが返り Cookie が張られる', async () => {
    const res = await fetch(base + '/?t=' + info.pin, { redirect: 'manual' });
    const html = await res.text();
    assert.strictEqual(res.status, 200);
    assert.ok(html.includes('写真をパソコンへ送る'), 'iPhone 向けページが返っていない');
    assert.ok((res.headers.get('set-cookie') || '').includes('ppt_token='), 'Cookie が無い');
  });

  await test('/assets/app.js が配信される', async () => {
    const res = await fetch(base + '/assets/app.js');
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes('api/upload'));
  });

  await test('/assets で保存先の外に出られない', async () => {
    const res = await fetch(base + '/assets/' + encodeURIComponent('../main/settings.js'));
    assert.notStrictEqual(res.status, 200);
  });

  /* --- 保存 --- */
  console.log('\n[保存]');

  let savedPath = null;

  await test('EXIF の撮影日で日付フォルダに保存され、ファイル日時も一致する', async () => {
    const buf = makeJpegWithExif('2019:03:15 08:30:45', 10);
    const r = await post(base + '/api/upload', buf, 'IMG_1769.jpg', Date.now(), cookie);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'saved');
    savedPath = r.body.savedPath;

    assert.ok(r.body.savedPath.includes('2019-03-15'),
      '日付フォルダが EXIF 由来でない: ' + r.body.savedPath);
    assert.strictEqual(path.basename(r.body.savedPath), 'IMG_1769.jpg');

    const st = await fsp.stat(r.body.savedPath);
    const want = new Date('2019-03-15T08:30:45');
    assert.ok(Math.abs(st.mtime.getTime() - want.getTime()) < 2000,
      'mtime が撮影日時と違う: ' + st.mtime.toISOString());
    return path.relative(saveDir, r.body.savedPath);
  });

  await test('同じ写真を再送すると重複として省略される', async () => {
    const buf = makeJpegWithExif('2019:03:15 08:30:45', 10);
    const r = await post(base + '/api/upload', buf, 'IMG_1769.jpg', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'duplicate');
    assert.strictEqual(r.body.savedPath, savedPath);

    const dir = path.dirname(savedPath);
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jpg'));
    assert.strictEqual(files.length, 1, 'ファイルが増えている: ' + files.join(', '));
  });

  await test('同名で中身が違う写真には連番が付く', async () => {
    const buf = makeJpegWithExif('2019:03:15 08:30:45', 200);   // tint 違い＝別ハッシュ
    const r = await post(base + '/api/upload', buf, 'IMG_1769.jpg', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'saved');
    assert.strictEqual(path.basename(r.body.savedPath), 'IMG_1769 (2).jpg');
  });

  await test('EXIF が無ければ lastModified の日付が使われる', async () => {
    const when = new Date('2021-07-04T12:00:00');
    const r = await post(base + '/api/upload', makeJpeg(40, 40, 55), 'noexif.jpg', when.getTime(), cookie);
    assert.strictEqual(r.body.status, 'saved');
    assert.ok(r.body.savedPath.includes('2021-07-04'), '保存先: ' + r.body.savedPath);
  });

  await test('iOS の汎用名 image.jpg は撮影日時ベースの名前になる', async () => {
    const when = new Date('2022-01-02T03:04:05');
    const r = await post(base + '/api/upload', makeJpeg(40, 40, 77), 'image.jpg', when.getTime(), cookie);
    assert.strictEqual(r.body.status, 'saved');
    assert.strictEqual(path.basename(r.body.savedPath), 'IMG_20220102_030405.jpg');
  });

  await test('PNG はそのまま保存される（再エンコードしない）', async () => {
    const png = makePng();
    const r = await post(base + '/api/upload', png, 'dot.png', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'saved');
    assert.strictEqual(path.extname(r.body.savedPath), '.png');
    const written = await fsp.readFile(r.body.savedPath);
    assert.ok(written.equals(png), 'PNG の中身が変わっている');
  });

  await test('パス区切りを含むファイル名でも保存先の外に出ない', async () => {
    const r = await post(base + '/api/upload', makeJpeg(30, 30, 99),
      '..\\..\\evil.jpg', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'saved');
    const rel = path.relative(saveDir, r.body.savedPath);
    assert.ok(!rel.startsWith('..'), '保存先の外に出た: ' + r.body.savedPath);
  });

  /* --- 弾くべきもの --- */
  console.log('\n[拒否]');

  await test('画像でないファイルは拒否される', async () => {
    const r = await post(base + '/api/upload', Buffer.from('just text, not an image'),
      'note.txt', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'error');
  });

  await test('動画(mp4)は拒否される', async () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(32)
    ]);
    const r = await post(base + '/api/upload', mp4, 'movie.mp4', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'error');
  });

  await test('中身が空のファイルは拒否される', async () => {
    const r = await post(base + '/api/upload', Buffer.alloc(0), 'empty.jpg', Date.now(), cookie);
    assert.strictEqual(r.body.status, 'error');
  });

  /* --- HEIC --- */
  console.log('\n[HEIC]');

  if (!heicArg) {
    console.log('  SKIP  HEIC の検証（HEIC ファイルのパスが渡されていません）');
  } else {
    await test('HEIC が JPEG に変換され、撮影日時と Make/Model が引き継がれる', async () => {
      const heic = await fsp.readFile(heicArg);
      const exifr = require('exifr');
      const src = await exifr.parse(heic, { tiff: true, ifd0: true, exif: true, gps: true });

      const t0 = Date.now();
      const r = await post(base + '/api/upload', heic, path.basename(heicArg), Date.now(), cookie);
      const ms = Date.now() - t0;

      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.status, 'saved', r.body.message || '');
      assert.strictEqual(r.body.converted, true, 'converted フラグが立っていない');
      assert.strictEqual(path.extname(r.body.savedPath), '.jpg');

      const out = await fsp.readFile(r.body.savedPath);
      assert.strictEqual(out[0], 0xff);
      assert.strictEqual(out[1], 0xd8);   // JPEG SOI

      const got = await exifr.parse(out, { tiff: true, ifd0: true, exif: true, gps: true });
      assert.ok(got, '変換後の JPEG に EXIF が無い（piexifjs の再注入が効いていない）');

      if (src && src.DateTimeOriginal) {
        assert.ok(got.DateTimeOriginal, '撮影日時が引き継がれていない');
        assert.strictEqual(
          new Date(got.DateTimeOriginal).getTime(),
          new Date(src.DateTimeOriginal).getTime(),
          '撮影日時がずれている'
        );
      }
      if (src && src.Model) {
        assert.strictEqual(got.Model, src.Model, '機種名が引き継がれていない');
      }
      if (src && typeof src.latitude === 'number') {
        assert.ok(typeof got.latitude === 'number', '位置情報が引き継がれていない');
        assert.ok(Math.abs(got.latitude - src.latitude) < 0.001, '緯度がずれている');
      }
      if (src && src.Orientation) {
        assert.strictEqual(got.Orientation, src.Orientation, '向きが引き継がれていない');
      }

      return '(' + Math.round(heic.length / 1024) + 'KB HEIC -> ' +
             Math.round(out.length / 1024) + 'KB JPEG, ' + ms + 'ms)';
    });

    await test('同じ HEIC を再送すると重複として省略される', async () => {
      const heic = await fsp.readFile(heicArg);
      const r = await post(base + '/api/upload', heic, path.basename(heicArg), Date.now(), cookie);
      assert.strictEqual(r.body.status, 'duplicate');
    });
  }

  /* --- 台帳 --- */
  console.log('\n[台帳とイベント]');

  await test('重複台帳がファイルに書き出されている', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const idx = JSON.parse(await fsp.readFile(path.join(saveDir, '.transfer-index.json'), 'utf8'));
    const n = Object.keys(idx).length;
    assert.ok(n >= 6, '台帳の件数が少なすぎる: ' + n);
    return n + ' 件';
  });

  await test('一時ファイルが残っていない', async () => {
    const left = await fsp.readdir(path.join(saveDir, '.tmp'));
    assert.strictEqual(left.length, 0, '残骸: ' + left.join(', '));
  });

  await test('GUI へ file-done イベントが飛んでいる', async () => {
    const done = events.filter((e) => e.event === 'file-done');
    assert.ok(done.length >= 6, 'イベント数: ' + done.length);
    return done.length + ' 件';
  });

  await server.stop();

  console.log('\n========================================');
  console.log('  成功 ' + pass + ' / 失敗 ' + fail);
  console.log('  保存先: ' + saveDir);
  console.log('========================================');

  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n検証スクリプトが異常終了しました:\n', err);
  process.exit(1);
});
