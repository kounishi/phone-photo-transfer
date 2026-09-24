'use strict';

const fs = require('fs');
const path = require('path');

let filePath = null;
let cache = null;

function defaults(app) {
  return {
    saveDir: path.join(app.getPath('pictures'), 'PhoneTransfer'),
    port: 8123,
    // 空文字なら network.js の推奨値を毎回使う
    preferredAddress: '',
    jpegQuality: 0.92,
    // 日付フォルダ(YYYY-MM-DD)に分けて保存するか
    useDateFolders: true
  };
}

function init(app) {
  filePath = path.join(app.getPath('userData'), 'settings.json');
  const base = defaults(app);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = { ...base, ...raw };
  } catch {
    cache = base; // 初回起動、または壊れていたら既定値に戻す
  }
  return cache;
}

function get() {
  if (!cache) throw new Error('settings.init() が先に必要です');
  return cache;
}

function set(patch) {
  cache = { ...get(), ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] 保存に失敗:', err.message);
  }
  return cache;
}

module.exports = { init, get, set };
