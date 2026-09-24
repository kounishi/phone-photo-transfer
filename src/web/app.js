(function () {
  'use strict';

  var PARALLEL = 2;          // 同時送信数。速度とメモリ・進捗の見やすさの折り合い
  var THUMB_LIMIT = 60;      // これを超えるぶんはサムネイルを作らない（メモリ対策）

  var items = [];
  var seq = 0;
  var sending = false;
  var wakeLock = null;

  var el = {
    conn: document.getElementById('conn'),
    empty: document.getElementById('empty'),
    listWrap: document.getElementById('listWrap'),
    list: document.getElementById('list'),
    summaryText: document.getElementById('summaryText'),
    clearBtn: document.getElementById('clearBtn'),
    resultWrap: document.getElementById('resultWrap'),
    resultText: document.getElementById('resultText'),
    picker: document.getElementById('picker'),
    pickBtn: document.getElementById('pickBtn'),
    sendBtn: document.getElementById('sendBtn'),
    retryBtn: document.getElementById('retryBtn'),
    hint: document.getElementById('hint')
  };

  /* ---------------- 小物 ---------------- */

  function formatBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    i = Math.min(i, u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function totalBytes(list) {
    return list.reduce(function (a, it) { return a + it.file.size; }, 0);
  }

  function countBy(status) {
    return items.filter(function (it) { return it.status === status; }).length;
  }

  /* ---------------- 描画 ---------------- */

  function statusLine(it) {
    switch (it.status) {
      case 'waiting': return { cls: '', text: formatBytes(it.file.size) };
      case 'sending': return { cls: '', text: '送信中 ' + Math.round(it.progress * 100) + '%' };
      case 'done':    return { cls: 'ok', text: it.converted ? '完了（JPEG に変換）' : '完了' };
      case 'dup':     return { cls: 'dup', text: 'すでに取り込み済み' };
      case 'failed':  return { cls: 'err', text: it.message || '失敗' };
      default:        return { cls: '', text: '' };
    }
  }

  function itemClass(it) {
    if (it.status === 'done') return 'item done';
    if (it.status === 'dup') return 'item dup';
    if (it.status === 'failed') return 'item failed';
    return 'item';
  }

  function renderItem(it) {
    var li = document.getElementById('it-' + it.id);
    if (!li) return;
    li.className = itemClass(it);

    var s = statusLine(it);
    var sub = li.querySelector('.sub');
    sub.className = 'sub ' + s.cls;
    sub.textContent = s.text;

    var fill = li.querySelector('.fill');
    fill.style.width = (it.status === 'sending' ? it.progress * 100 : (it.status === 'waiting' ? 0 : 100)) + '%';

    li.querySelector('.remove').disabled = sending;
  }

  function renderAll() {
    el.list.textContent = '';

    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = itemClass(it);
      li.id = 'it-' + it.id;

      if (it.thumbUrl) {
        var img = document.createElement('img');
        img.className = 'thumb';
        img.src = it.thumbUrl;
        img.alt = '';
        li.appendChild(img);
      } else {
        var ph = document.createElement('div');
        ph.className = 'thumb';
        li.appendChild(ph);
      }

      var meta = document.createElement('div');
      meta.className = 'meta';

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.file.name || '写真';
      meta.appendChild(name);

      var s = statusLine(it);
      var sub = document.createElement('div');
      sub.className = 'sub ' + s.cls;
      sub.textContent = s.text;
      meta.appendChild(sub);

      var track = document.createElement('div');
      track.className = 'track';
      var fill = document.createElement('div');
      fill.className = 'fill';
      track.appendChild(fill);
      meta.appendChild(track);

      li.appendChild(meta);

      var rm = document.createElement('button');
      rm.className = 'remove';
      rm.type = 'button';
      rm.textContent = '×';
      rm.setAttribute('aria-label', '取り消す');
      rm.disabled = sending;
      rm.addEventListener('click', function () { removeItem(it.id); });
      li.appendChild(rm);

      el.list.appendChild(li);
      renderItem(it);
    });

    syncChrome();
  }

  function syncChrome() {
    var has = items.length > 0;
    el.empty.hidden = has;
    el.listWrap.hidden = !has;

    var pending = countBy('waiting');
    var failed = countBy('failed');

    el.summaryText.textContent = items.length + ' 件 / ' + formatBytes(totalBytes(items));
    el.clearBtn.disabled = sending;

    el.pickBtn.disabled = sending;
    el.pickBtn.textContent = has ? '写真を追加する' : '写真を選ぶ';

    el.sendBtn.hidden = pending === 0;
    el.sendBtn.disabled = sending;
    el.sendBtn.textContent = sending
      ? '送信中…'
      : 'パソコンに送る（' + pending + ' 件）';

    el.retryBtn.hidden = sending || failed === 0;
    el.retryBtn.textContent = '失敗した ' + failed + ' 件を再送';

    el.hint.hidden = !sending;
  }

  function showResult() {
    var done = countBy('done');
    var dup = countBy('dup');
    var failed = countBy('failed');
    if (done + dup + failed === 0) { el.resultWrap.hidden = true; return; }

    var lines = [];
    if (done) lines.push('保存しました: ' + done + ' 件');
    if (dup) lines.push('取り込み済みのため省略: ' + dup + ' 件');
    if (failed) lines.push('失敗: ' + failed + ' 件');

    el.resultText.textContent = lines.join(' / ');
    el.resultWrap.hidden = false;
  }

  /* ---------------- 一覧の操作 ---------------- */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var thumbsUsed = items.filter(function (it) { return it.thumbUrl; }).length;

    files.forEach(function (f) {
      var it = {
        id: ++seq,
        file: f,
        status: 'waiting',
        progress: 0,
        message: '',
        converted: false,
        thumbUrl: null
      };
      // 大量選択時に全部の objectURL を抱えるとメモリを圧迫するので上限を設ける
      if (thumbsUsed < THUMB_LIMIT) {
        try {
          it.thumbUrl = URL.createObjectURL(f);
          thumbsUsed++;
        } catch (e) { /* 作れなくても送信には影響しない */ }
      }
      items.push(it);
    });

    el.resultWrap.hidden = true;
    renderAll();
  }

  function releaseThumb(it) {
    if (it.thumbUrl) {
      try { URL.revokeObjectURL(it.thumbUrl); } catch (e) {}
      it.thumbUrl = null;
    }
  }

  function removeItem(id) {
    if (sending) return;
    var i = items.findIndex(function (it) { return it.id === id; });
    if (i < 0) return;
    releaseThumb(items[i]);
    items.splice(i, 1);
    renderAll();
  }

  function clearAll() {
    if (sending) return;
    items.forEach(releaseThumb);
    items = [];
    el.resultWrap.hidden = true;
    renderAll();
  }

  /* ---------------- 送信 ---------------- */

  function upload(it) {
    return new Promise(function (resolve) {
      var fd = new FormData();
      // フィールドはファイルより先に積む（サーバー側が file 到達時に参照するため）
      fd.append('clientName', it.file.name || '');
      fd.append('lastModified', String(it.file.lastModified || ''));
      fd.append('file', it.file, it.file.name || 'image.jpg');

      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);
      xhr.timeout = 10 * 60 * 1000;

      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        it.progress = e.loaded / e.total;
        renderItem(it);
      };

      function fail(msg) {
        it.status = 'failed';
        it.message = msg;
        renderItem(it);
        syncChrome();
        resolve();
      }

      xhr.onload = function () {
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) {}

        if (xhr.status === 401) return fail('PIN の期限切れ。画面を再読み込みしてください');
        if (!body) return fail('応答を解釈できませんでした (' + xhr.status + ')');

        if (body.status === 'saved') {
          it.status = 'done';
          it.converted = !!body.converted;
          it.progress = 1;
          releaseThumb(it);          // 完了したぶんのメモリは解放してよい
        } else if (body.status === 'duplicate') {
          it.status = 'dup';
          it.progress = 1;
          releaseThumb(it);
        } else {
          return fail(body.message || '保存できませんでした');
        }
        renderItem(it);
        syncChrome();
        resolve();
      };

      xhr.onerror = function () { fail('通信が切れました'); };
      xhr.ontimeout = function () { fail('時間切れになりました'); };

      it.status = 'sending';
      it.progress = 0;
      it.message = '';
      renderItem(it);

      xhr.send(fd);
    });
  }

  async function requestWakeLock() {
    // http では secure context ではないので基本失敗する。取れたら儲けもの。
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { wakeLock = null; }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) {}
      wakeLock = null;
    }
  }

  async function sendQueue(targets) {
    if (sending || !targets.length) return;
    sending = true;
    el.resultWrap.hidden = true;
    syncChrome();
    await requestWakeLock();

    var queue = targets.slice();
    var workers = [];
    for (var i = 0; i < Math.min(PARALLEL, queue.length); i++) {
      workers.push((async function worker() {
        while (queue.length) {
          await upload(queue.shift());
        }
      })());
    }
    await Promise.all(workers);

    releaseWakeLock();
    sending = false;
    renderAll();
    showResult();
  }

  /* ---------------- 接続確認 ---------------- */

  function checkConnection() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) {
          el.conn.textContent = 'パソコンに接続中';
          el.conn.className = 'conn ok';
        } else {
          el.conn.textContent = '接続できません';
          el.conn.className = 'conn ng';
        }
      })
      .catch(function () {
        el.conn.textContent = '接続できません';
        el.conn.className = 'conn ng';
      });
  }

  /* ---------------- 配線 ---------------- */

  el.pickBtn.addEventListener('click', function () { el.picker.click(); });

  el.picker.addEventListener('change', function () {
    addFiles(el.picker.files);
    el.picker.value = '';   // 同じ写真をもう一度選べるようにする
  });

  el.sendBtn.addEventListener('click', function () {
    sendQueue(items.filter(function (it) { return it.status === 'waiting'; }));
  });

  el.retryBtn.addEventListener('click', function () {
    var failed = items.filter(function (it) { return it.status === 'failed'; });
    failed.forEach(function (it) { it.status = 'waiting'; it.progress = 0; });
    renderAll();
    sendQueue(failed);
  });

  el.clearBtn.addEventListener('click', clearAll);

  window.addEventListener('beforeunload', function (e) {
    if (sending) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkConnection();
  });

  renderAll();
  checkConnection();
})();
