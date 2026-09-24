'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const busboy = require('busboy');

const pipeline = require('./pipeline');

const WEB_DIR = path.join(__dirname, '..', 'web');
const COOKIE_NAME = 'ppt_token';
const MAX_FILE_BYTES = 512 * 1024 * 1024;   // 写真1枚としては十分すぎる上限
const PORT_RETRY = 10;

// asar の中でも確実に読めるよう、express.static ではなく都度 readFile で返す
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sixDigitPin() {
  // 000000 を含む一様な6桁
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// タイミング差で PIN を推測されないよう固定時間で比較する
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function pinPage(message) {
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>PIN の入力</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;
      background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;
      align-items:center;justify-content:center;margin:0;padding:24px}
 .box{width:100%;max-width:340px;text-align:center}
 h1{font-size:20px;margin:0 0 8px}
 p{color:#9aa0a6;font-size:14px;margin:0 0 24px;line-height:1.7}
 input{width:100%;box-sizing:border-box;font-size:28px;text-align:center;
       letter-spacing:.4em;padding:14px;border-radius:12px;border:1px solid #3c4043;
       background:#1c1f26;color:#e8eaed;margin-bottom:16px}
 button{width:100%;padding:16px;font-size:17px;font-weight:600;border:0;
        border-radius:12px;background:#4c8dff;color:#fff}
 .err{color:#ff8a80;font-size:14px;margin-bottom:16px}
</style></head>
<body><div class="box">
 <h1>PIN を入力してください</h1>
 <p>パソコンの画面に表示されている<br>6桁の数字を入力します。</p>
 ${message ? `<div class="err">${message}</div>` : ''}
 <form method="GET" action="/">
  <input name="t" inputmode="numeric" pattern="[0-9]*" maxlength="6"
         autocomplete="off" autofocus placeholder="------">
  <button type="submit">接続する</button>
 </form>
</div></body></html>`;
}

/**
 * 受信サーバー。start() のたびに新しい PIN を振る。
 * @param {object} deps
 * @param {() => object} deps.getSettings  現在の設定を返す
 * @param {(event: string, payload: any) => void} deps.emit  renderer への通知
 */
function createServer(deps) {
  let server = null;
  let token = null;
  let boundPort = null;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const requireAuth = (req, res, next) => {
    if (sameToken(readCookie(req, COOKIE_NAME), token)) return next();
    if (sameToken(String(req.query.t || ''), token)) return next();
    res.status(401).json({ status: 'error', message: 'PIN が違います。パソコンの画面を確認してください。' });
  };

  // --- iPhone 向けページ -------------------------------------------
  app.get('/', (req, res) => {
    const supplied = req.query.t;
    const viaCookie = sameToken(readCookie(req, COOKIE_NAME), token);

    if (!viaCookie) {
      if (supplied === undefined) {
        return res.status(401).type('html').send(pinPage(null));
      }
      if (!sameToken(String(supplied), token)) {
        return res.status(401).type('html').send(pinPage('PIN が違います'));
      }
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    }

    fsp.readFile(path.join(WEB_DIR, 'index.html'))
      .then((buf) => {
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(buf);
      })
      .catch(() => res.status(500).send('ページを読み込めませんでした'));
  });

  // 静的アセット（index.html 以外）。トークン無しでも配れる内容だが、
  // 余計な公開を避けるため拡張子は限定する。
  app.get('/assets/:name', (req, res) => {
    const name = path.basename(req.params.name);
    const ext = path.extname(name).toLowerCase();
    if (!MIME[ext]) return res.status(404).end();
    fsp.readFile(path.join(WEB_DIR, name))
      .then((buf) => {
        res.setHeader('Cache-Control', 'no-store');
        res.type(MIME[ext]).send(buf);
      })
      .catch(() => res.status(404).end());
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, authed: sameToken(readCookie(req, COOKIE_NAME), token) });
  });

  // --- アップロード -------------------------------------------------
  app.post('/api/upload', requireAuth, (req, res) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_FILE_BYTES } });
    } catch {
      return res.status(400).json({ status: 'error', message: '不正なリクエストです' });
    }

    const fields = {};
    let replied = false;
    let sawFile = false;

    const reply = (code, body) => {
      if (replied) return;
      replied = true;
      res.status(code).json(body);
    };

    // FormData はフィールドを先に append しているので、file が来る時点で揃っている
    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (_name, stream, info) => {
      sawFile = true;
      const settings = deps.getSettings();
      const meta = {
        clientName: fields.clientName || info.filename,
        lastModified: fields.lastModified
      };

      deps.emit('receiving', { fileName: meta.clientName });

      pipeline
        .ingest(stream, meta, {
          jpegQuality: settings.jpegQuality,
          useDateFolders: settings.useDateFolders
        })
        .then((result) => {
          deps.emit('file-done', result);
          reply(200, result);
        })
        .catch((err) => {
          stream.resume();   // 詰まらせない
          const result = { status: 'error', message: err.message, fileName: meta.clientName };
          deps.emit('file-done', result);
          reply(500, result);
        });
    });

    bb.on('error', (err) => {
      reply(400, { status: 'error', message: '受信に失敗しました: ' + err.message });
    });

    bb.on('close', () => {
      if (!sawFile) reply(400, { status: 'error', message: 'ファイルが含まれていません' });
    });

    req.pipe(bb);
  });

  /* ---------------------------------------------------------------- */

  function listen(port) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(app);
      s.on('error', reject);
      s.listen(port, '0.0.0.0', () => resolve(s));
    });
  }

  async function start() {
    if (server) return info();

    const settings = deps.getSettings();
    await fsp.mkdir(settings.saveDir, { recursive: true });
    await pipeline.setSaveDir(settings.saveDir);

    let lastErr = null;
    for (let i = 0; i < PORT_RETRY; i++) {
      const port = settings.port + i;
      try {
        server = await listen(port);
        boundPort = port;
        lastErr = null;
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
        lastErr = err;   // 使われていたら次のポートへ
      }
    }
    if (!server) {
      throw new Error(`ポート ${settings.port}〜${settings.port + PORT_RETRY - 1} がすべて使用中です`);
    }

    // 接続していた端末は再起動のたびに PIN を入れ直す
    token = sixDigitPin();
    return info();
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    token = null;
    boundPort = null;
    await pipeline.flushIndex();
  }

  function info() {
    return { running: !!server, port: boundPort, pin: token };
  }

  return { start, stop, info, isRunning: () => !!server };
}

module.exports = { createServer };
