(function () {
  'use strict';

  var MAX_ROWS = 200;      // 画面に残す履歴の件数。サムネイル分のメモリを抑える
  var log = [];
  var busy = false;

  var el = {
    statusBadge: document.getElementById('statusBadge'),
    toggleBtn: document.getElementById('toggleBtn'),
    alert: document.getElementById('alert'),

    connOn: document.getElementById('connOn'),
    connOff: document.getElementById('connOff'),
    qr: document.getElementById('qr'),
    url: document.getElementById('url'),
    pin: document.getElementById('pin'),
    addrSelect: document.getElementById('addrSelect'),

    saveDir: document.getElementById('saveDir'),
    pickDirBtn: document.getElementById('pickDirBtn'),
    openDirBtn: document.getElementById('openDirBtn'),
    dateFolders: document.getElementById('dateFolders'),
    quality: document.getElementById('quality'),

    log: document.getElementById('log'),
    logEmpty: document.getElementById('logEmpty'),
    counts: document.getElementById('counts'),
    clearLogBtn: document.getElementById('clearLogBtn')
  };

  /* ---------------- 小物 ---------------- */

  function formatBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  // Windows のパスを <img src> で使える file URL にする
  function fileUrl(p) {
    return 'file:///' + encodeURI(p.replace(/\\/g, '/'))
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
  }

  function showAlert(msg) {
    if (!msg) { el.alert.hidden = true; return; }
    el.alert.textContent = msg;
    el.alert.hidden = false;
  }

  /* ---------------- 状態の反映 ---------------- */

  function applyState(state) {
    if (!state) return;

    if (state.error) showAlert(state.error); else showAlert(null);

    var on = !!state.running;
    el.statusBadge.textContent = on ? '待受中' : '停止中';
    el.statusBadge.className = on ? 'badge on' : 'badge';
    el.toggleBtn.textContent = on ? '待受を停止' : '待受を開始';
    el.toggleBtn.className = on ? 'btn btn-primary stop' : 'btn btn-primary';
    el.toggleBtn.disabled = busy;

    el.connOn.hidden = !on;
    el.connOff.hidden = on;

    if (on) {
      el.url.textContent = state.url || '—';
      el.pin.textContent = state.pin || '—';
      if (state.qr) el.qr.src = state.qr;
    }

    // ネットワーク候補
    var wanted = state.address;
    el.addrSelect.textContent = '';
    (state.addresses || []).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.address;
      o.textContent = c.label;
      if (c.address === wanted) o.selected = true;
      el.addrSelect.appendChild(o);
    });
    if (!(state.addresses || []).length) {
      var o = document.createElement('option');
      o.textContent = 'ネットワークが見つかりません';
      el.addrSelect.appendChild(o);
      el.addrSelect.disabled = true;
    } else {
      el.addrSelect.disabled = false;
    }

    el.saveDir.textContent = state.settings.saveDir;
    el.dateFolders.checked = !!state.settings.useDateFolders;

    // 保存済みの値が選択肢に無い場合もあるので、一致したときだけ反映する
    var q = String(state.settings.jpegQuality);
    if (Array.prototype.some.call(el.quality.options, function (o) { return o.value === q; })) {
      el.quality.value = q;
    }
  }

  /* ---------------- 受信ログ ---------------- */

  function renderLog() {
    el.log.textContent = '';
    el.logEmpty.hidden = log.length > 0;

    log.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'row' + (r.status === 'duplicate' ? ' dup' : r.status === 'error' ? ' err' : '');

      var img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      img.loading = 'lazy';
      if (r.savedPath && r.status !== 'error') img.src = fileUrl(r.savedPath);
      li.appendChild(img);

      var meta = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = r.fileName || '(名前なし)';
      meta.appendChild(name);

      var sub = document.createElement('div');
      if (r.status === 'saved') {
        sub.className = 'sub ok';
        sub.textContent = r.converted ? 'JPEG に変換して保存' : '保存しました';
      } else if (r.status === 'duplicate') {
        sub.className = 'sub dup';
        sub.textContent = '取り込み済みのため省略';
      } else {
        sub.className = 'sub err';
        sub.textContent = r.message || '失敗しました';
      }
      meta.appendChild(sub);
      li.appendChild(meta);

      var size = document.createElement('span');
      size.className = 'size';
      size.textContent = r.bytes ? formatBytes(r.bytes) : '';
      li.appendChild(size);

      var btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.type = 'button';
      btn.textContent = '表示';
      btn.disabled = !r.savedPath || r.status === 'error';
      btn.addEventListener('click', function () { window.ppt.showItem(r.savedPath); });
      li.appendChild(btn);

      el.log.appendChild(li);
    });

    var saved = log.filter(function (r) { return r.status === 'saved'; }).length;
    var dup = log.filter(function (r) { return r.status === 'duplicate'; }).length;
    var err = log.filter(function (r) { return r.status === 'error'; }).length;

    if (!log.length) {
      el.counts.textContent = 'まだありません';
    } else {
      var parts = ['保存 ' + saved + ' 件'];
      if (dup) parts.push('省略 ' + dup + ' 件');
      if (err) parts.push('失敗 ' + err + ' 件');
      el.counts.textContent = parts.join(' / ');
    }
  }

  function pushLog(result) {
    log.unshift(result);
    if (log.length > MAX_ROWS) log.length = MAX_ROWS;
    renderLog();
  }

  /* ---------------- 操作 ---------------- */

  async function withBusy(fn) {
    busy = true;
    el.toggleBtn.disabled = true;
    try {
      applyState(await fn());
    } catch (err) {
      showAlert(err && err.message ? err.message : String(err));
    } finally {
      busy = false;
      el.toggleBtn.disabled = false;
    }
  }

  el.toggleBtn.addEventListener('click', function () {
    var running = el.statusBadge.classList.contains('on');
    withBusy(function () { return running ? window.ppt.stop() : window.ppt.start(); });
  });

  el.addrSelect.addEventListener('change', function () {
    withBusy(function () {
      return window.ppt.setSettings({ preferredAddress: el.addrSelect.value });
    });
  });

  el.dateFolders.addEventListener('change', function () {
    withBusy(function () {
      return window.ppt.setSettings({ useDateFolders: el.dateFolders.checked });
    });
  });

  el.quality.addEventListener('change', function () {
    withBusy(function () {
      return window.ppt.setSettings({ jpegQuality: parseFloat(el.quality.value) });
    });
  });

  el.pickDirBtn.addEventListener('click', function () {
    withBusy(function () { return window.ppt.pickDir(); });
  });

  el.openDirBtn.addEventListener('click', function () {
    window.ppt.openDir().then(function (err) {
      if (err) showAlert('フォルダを開けませんでした: ' + err);
    });
  });

  el.clearLogBtn.addEventListener('click', function () {
    log = [];
    renderLog();
  });

  /* ---------------- 配線 ---------------- */

  window.ppt.onState(applyState);

  window.ppt.onTransfer(function (msg) {
    if (msg.event === 'file-done') pushLog(msg.payload);
  });

  window.ppt.getState().then(applyState);
  renderLog();

  // アダプタは抜き差しで変わるので、開いている間はときどき拾い直す
  setInterval(function () {
    if (busy) return;
    window.ppt.refreshAddrs().then(function (s) {
      // 選択中のセレクトを勝手に閉じないよう、候補数が変わったときだけ描き直す
      if (s && s.addresses && s.addresses.length !== el.addrSelect.options.length) applyState(s);
    });
  }, 5000);
})();
