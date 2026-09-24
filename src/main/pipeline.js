'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sanitize = require('sanitize-filename');

const INDEX_NAME = '.transfer-index.json';
const TMP_DIR = '.tmp';

let saveDir = null;
let index = {};          // sha256 -> 保存先の相対パス
let indexDirty = false;
let indexWriting = false;

/* ------------------------------------------------------------------ */
/* 重複台帳                                                            */
/* ------------------------------------------------------------------ */

async function setSaveDir(dir) {
  saveDir = dir;
  index = {};
  await fsp.mkdir(path.join(saveDir, TMP_DIR), { recursive: true });
  try {
    const raw = await fsp.readFile(path.join(saveDir, INDEX_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') index = parsed;
  } catch {
    // 台帳が無い＝この保存先は初回。空で始める
  }
  await cleanTmp();
}

function getSaveDir() {
  return saveDir;
}

// 前回の異常終了で残った一時ファイルを掃除する
async function cleanTmp() {
  try {
    const dir = path.join(saveDir, TMP_DIR);
    for (const name of await fsp.readdir(dir)) {
      await fsp.unlink(path.join(dir, name)).catch(() => {});
    }
  } catch {}
}

// 保存のたびに書くが、書き込み中は一度だけ追い書きする（連続受信で潰し合わないように）
async function flushIndex() {
  if (!saveDir) return;
  if (indexWriting) { indexDirty = true; return; }
  indexWriting = true;
  try {
    const p = path.join(saveDir, INDEX_NAME);
    await fsp.writeFile(p, JSON.stringify(index, null, 1), 'utf8');
  } catch (err) {
    console.error('[pipeline] 台帳の保存に失敗:', err.message);
  } finally {
    indexWriting = false;
    if (indexDirty) { indexDirty = false; await flushIndex(); }
  }
}

/* ------------------------------------------------------------------ */
/* 形式判定（拡張子は信用せず先頭バイトで見る）                         */
/* ------------------------------------------------------------------ */

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'
]);

function sniff(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'jpeg', ext: '.jpg' };
  }
  if (head.length >= 8 && head.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    return { kind: 'png', ext: '.png' };
  }
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12);
    if (HEIF_BRANDS.has(brand)) return { kind: 'heic', ext: '.heic' };
    return { kind: 'other', ext: '' };   // mp4 など。写真ではないので弾く
  }
  if (head.length >= 6 && head.toString('latin1', 0, 4) === 'GIF8') {
    return { kind: 'gif', ext: '.gif' };
  }
  if (head.length >= 12 &&
      head.toString('latin1', 0, 4) === 'RIFF' &&
      head.toString('latin1', 8, 12) === 'WEBP') {
    return { kind: 'webp', ext: '.webp' };
  }
  return { kind: 'other', ext: '' };
}

/* ------------------------------------------------------------------ */
/* HEIC -> JPEG                                                        */
/* ------------------------------------------------------------------ */

// libheif は画像まるごとをメモリに載せる。同時実行すると一気に膨らむので1枚ずつ。
let convertChain = Promise.resolve();
function serializeConvert(fn) {
  const run = convertChain.then(fn, fn);
  convertChain = run.then(() => {}, () => {});
  return run;
}

function exifDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + ':' + p(d.getMonth() + 1) + ':' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function degToDmsRational(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = Math.round((minFloat - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

/**
 * heic-convert は生ピクセルへ decode -> 再 encode するため EXIF を落とす。
 * 変換前に読んでおいた EXIF を piexifjs で入れ直す。これを省くと撮影日が全部消える。
 */
function reinjectExif(jpegBuffer, meta) {
  if (!meta) return jpegBuffer;
  const piexif = require('piexifjs');
  try {
    const zeroth = {};
    const exif = {};
    const gps = {};

    // libheif が適用するのは irot/imir だけで、EXIF の Orientation は触らない。
    // Apple の HEIC は回転を EXIF に持つので、そのまま引き継ぐのが正しい。
    // 型が崩れた値で dump() ごと失敗させないよう、数値として妥当な範囲だけ通す
    const orientation = Number(meta.Orientation);
    if (Number.isInteger(orientation) && orientation >= 1 && orientation <= 8) {
      zeroth[piexif.ImageIFD.Orientation] = orientation;
    }
    if (meta.Make) zeroth[piexif.ImageIFD.Make] = String(meta.Make);
    if (meta.Model) zeroth[piexif.ImageIFD.Model] = String(meta.Model);

    if (meta.date) {
      const s = exifDateString(meta.date);
      zeroth[piexif.ImageIFD.DateTime] = s;
      exif[piexif.ExifIFD.DateTimeOriginal] = s;
      exif[piexif.ExifIFD.DateTimeDigitized] = s;
    }
    if (meta.LensModel) exif[piexif.ExifIFD.LensModel] = String(meta.LensModel);
    if (typeof meta.FNumber === 'number' && meta.FNumber > 0) {
      exif[piexif.ExifIFD.FNumber] = [Math.round(meta.FNumber * 100), 100];
    }
    if (typeof meta.ISO === 'number' && meta.ISO > 0) {
      exif[piexif.ExifIFD.ISOSpeedRatings] = Math.round(meta.ISO);
    }
    if (typeof meta.ExposureTime === 'number' && meta.ExposureTime > 0) {
      exif[piexif.ExifIFD.ExposureTime] = [1, Math.max(1, Math.round(1 / meta.ExposureTime))];
    }

    if (typeof meta.latitude === 'number' && typeof meta.longitude === 'number') {
      gps[piexif.GPSIFD.GPSLatitudeRef] = meta.latitude >= 0 ? 'N' : 'S';
      gps[piexif.GPSIFD.GPSLatitude] = degToDmsRational(meta.latitude);
      gps[piexif.GPSIFD.GPSLongitudeRef] = meta.longitude >= 0 ? 'E' : 'W';
      gps[piexif.GPSIFD.GPSLongitude] = degToDmsRational(meta.longitude);
    }

    const dump = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps });
    const out = piexif.insert(dump, jpegBuffer.toString('binary'));
    return Buffer.from(out, 'binary');
  } catch (err) {
    // EXIF が入らなくても画像そのものは救う
    console.error('[pipeline] EXIF 再注入に失敗（画像はそのまま保存）:', err.message);
    return jpegBuffer;
  }
}

async function readExif(buffer) {
  try {
    const exifr = require('exifr');
    // translateValues:false は必須。既定の true だと Orientation が
    // "Rotate 270 CW" のような文字列になり、数値を期待する piexifjs が落ちる。
    return await exifr.parse(buffer, {
      tiff: true, ifd0: true, exif: true, gps: true, translateValues: false
    });
  } catch {
    return null;
  }
}

function pickExifDate(exif) {
  if (!exif) return null;
  const keys = ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'ModifyDate'];
  for (const key of keys) {
    const v = exif[key];
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (typeof v === 'string') {
      const d = new Date(v.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

async function heicToJpeg(buffer, quality) {
  const convert = require('heic-convert');
  const exif = await readExif(buffer);
  const jpeg = await serializeConvert(() => convert({ buffer, format: 'JPEG', quality }));
  const jpegBuffer = Buffer.from(jpeg);
  const date = pickExifDate(exif);
  return {
    buffer: reinjectExif(jpegBuffer, exif ? Object.assign({}, exif, { date }) : null),
    date
  };
}

/* ------------------------------------------------------------------ */
/* 保存先の決定                                                        */
/* ------------------------------------------------------------------ */

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function dateFolder(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// iOS Safari は写真ピッカーの全ファイルを "image.jpg" で寄越すことがある。
// その場合は撮影日時から名前を作らないと全部ぶつかる。
const GENERIC_NAME = /^(image|photo|asset|untitled)\.(jpe?g|png|heic|heif)$/i;

function baseNameFor(clientName, date) {
  const cleaned = sanitize(String(clientName || '').trim()).trim();
  if (!cleaned || GENERIC_NAME.test(cleaned)) {
    return 'IMG_' + stamp(date);
  }
  const withoutExt = cleaned.replace(/\.[^.]+$/, '');
  return withoutExt || ('IMG_' + stamp(date));
}

// 同名でハッシュ違いなら連番。空きが見つかるまで探す。
async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let n = 2;
  for (;;) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, base + ' (' + n + ')' + ext);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 受信本体                                                            */
/* ------------------------------------------------------------------ */

// multipart のファイルストリームをそのまま一時ファイルへ流す。
// バッファに溜めないので、何十枚送られてもメモリは一定。
function writeTemp(fileStream, tmpPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let head = Buffer.alloc(0);
    let truncated = false;

    const out = fs.createWriteStream(tmpPath);

    fileStream.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
    });
    fileStream.on('limit', () => { truncated = true; });
    fileStream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => {
      resolve({ sha256: hash.digest('hex'), bytes, head, truncated });
    });

    fileStream.pipe(out);
  });
}

async function ingest(fileStream, meta, options) {
  if (!saveDir) throw new Error('保存先が未設定です');

  const opts = options || {};
  const quality = opts.jpegQuality || 0.92;
  const useDateFolders = opts.useDateFolders !== false;
  const tmpPath = path.join(saveDir, TMP_DIR, crypto.randomUUID());

  let info;
  try {
    info = await writeTemp(fileStream, tmpPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  const done = async (result) => {
    await fsp.unlink(tmpPath).catch(() => {});
    return result;
  };

  if (info.truncated) return done({ status: 'error', message: 'ファイルが大きすぎます' });
  if (info.bytes === 0) return done({ status: 'error', message: '中身が空でした' });

  // 同じ写真を二度送っても増やさない
  const known = index[info.sha256];
  if (known) {
    const abs = path.join(saveDir, known);
    if (fs.existsSync(abs)) {
      return done({
        status: 'duplicate',
        savedPath: abs,
        fileName: path.basename(abs),
        bytes: info.bytes,
        sha256: info.sha256
      });
    }
    delete index[info.sha256];   // 保存先から消されていたら台帳を直して受け直す
  }

  const type = sniff(info.head);
  if (type.kind === 'other') {
    return done({ status: 'error', message: '画像として読めない形式です' });
  }

  // --- 変換と EXIF -------------------------------------------------
  let outBuffer = null;          // null なら一時ファイルを rename して済ませる
  let ext = type.ext;
  let exifDate = null;
  let converted = false;

  try {
    if (type.kind === 'heic') {
      const buf = await fsp.readFile(tmpPath);
      const r = await heicToJpeg(buf, quality);
      outBuffer = r.buffer;
      exifDate = r.date;
      ext = '.jpg';
      converted = true;
    } else if (type.kind === 'jpeg' || type.kind === 'png') {
      // JPEG/PNG はそのまま通す。再エンコードしないので劣化しない。
      exifDate = pickExifDate(await readExif(await fsp.readFile(tmpPath)));
    }
  } catch (err) {
    return done({ status: 'error', message: '変換に失敗しました: ' + err.message });
  }

  // 撮影日時: EXIF -> 端末が送ってきた lastModified -> 受信時刻
  let date = exifDate;
  if (!date && meta && meta.lastModified) {
    const d = new Date(Number(meta.lastModified));
    if (!isNaN(d.getTime()) && d.getFullYear() > 1990) date = d;
  }
  if (!date) date = new Date();

  const targetDir = useDateFolders ? path.join(saveDir, dateFolder(date)) : saveDir;
  await fsp.mkdir(targetDir, { recursive: true });

  const base = baseNameFor(meta && meta.clientName, date);
  const destPath = await uniquePath(targetDir, base, ext);

  try {
    if (outBuffer) {
      await fsp.writeFile(destPath, outBuffer);
      await fsp.unlink(tmpPath).catch(() => {});
    } else {
      await fsp.rename(tmpPath, destPath);   // 同一ボリュームなのでコピーは発生しない
    }
    // エクスプローラで撮影順に並ぶようにファイル日時も合わせる
    await fsp.utimes(destPath, date, date).catch(() => {});
  } catch (err) {
    return done({ status: 'error', message: '保存に失敗しました: ' + err.message });
  }

  index[info.sha256] = path.relative(saveDir, destPath);
  flushIndex();

  const stat = await fsp.stat(destPath).catch(() => null);

  return {
    status: 'saved',
    savedPath: destPath,
    fileName: path.basename(destPath),
    bytes: stat ? stat.size : info.bytes,
    receivedBytes: info.bytes,
    sha256: info.sha256,
    converted,
    takenAt: date.toISOString()
  };
}

module.exports = { setSaveDir, getSaveDir, ingest, sniff, flushIndex, pickExifDate };
