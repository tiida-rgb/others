/*
 * app.js — カントー151 音声クイズ
 *
 * マイクを開きっぱなしにして（continuous + 自動再起動）、聞こえた言葉を
 * matcher.js に渡し、当たったマスを埋めていく。
 */
(function () {
  'use strict';

  var LIST = window.POKEMON_GEN1;
  var BY_ID = {};
  LIST.forEach(function (p) { BY_ID[p.id] = p; });

  var matcher = new window.PokeMatcher(LIST);
  // 画像は同梱していないので、まず同じフォルダの sprites/ を見に行き、
  // 無ければ PokeAPI の CDN、それも駄目なら画像なしで表示する（名前だけでも遊べる）。
  var SPRITE_LOCAL = 'sprites/';
  var SPRITE_CDN = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
  var STORE_KEY = 'kanto151-voice-quiz.v1';
  var LOG_MAX = 60;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    grid: $('grid'), count: $('count'), timer: $('timer'),
    progress: $('progress'), progressBar: $('progressBar'),
    micBtn: $('micBtn'), micBtnLabel: $('micBtnLabel'),
    micStatusText: $('micStatusText'), interim: $('interim'),
    manualForm: $('manualForm'), manualInput: $('manualInput'),
    revealBtn: $('revealBtn'), resetBtn: $('resetBtn'), soundToggle: $('soundToggle'),
    logList: $('logList'),
    toast: $('toast'), notice: $('notice')
  };

  /* ===================== 状態 ===================== */

  var answered = Object.create(null);   // id -> true
  var answeredCount = 0;
  var elapsedMs = 0;
  var runningSince = null;              // 計測中なら開始時刻
  var revealed = false;
  var soundOn = true;
  var cells = {};

  /* ===================== 保存・復元 ===================== */

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        answered: Object.keys(answered).map(Number),
        elapsedMs: totalElapsed(),
        soundOn: soundOn,
        savedAt: Date.now()
      }));
    } catch (e) { /* プライベートモードなどでは保存できない。無視する */ }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      (data.answered || []).forEach(function (id) {
        if (BY_ID[id] && !answered[id]) { answered[id] = true; answeredCount++; }
      });
      elapsedMs = data.elapsedMs || 0;
      if (typeof data.soundOn === 'boolean') soundOn = data.soundOn;
    } catch (e) { /* 壊れていたら捨てる */ }
  }

  /* ===================== グリッド ===================== */

  function buildGrid() {
    var frag = document.createDocumentFragment();
    LIST.forEach(function (p) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.id = String(p.id);
      cell.title = 'No.' + pad(p.id);

      var no = document.createElement('span');
      no.className = 'no';
      no.textContent = pad(p.id);

      var img = document.createElement('img');
      img.className = 'sprite';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () { onSpriteError(img); });

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;

      cell.append(no, img, name);
      cells[p.id] = { root: cell, img: img };
      frag.appendChild(cell);
    });
    el.grid.appendChild(frag);
    el.grid.addEventListener('click', onCellClick);
  }

  function pad(n) { return ('00' + n).slice(-3); }

  /** sprites/ → CDN → 非表示 の順に試す */
  function setSprite(img, id) {
    if (img.dataset.for === String(id)) return;
    img.dataset.for = String(id);
    img.dataset.stage = 'local';
    img.style.display = '';
    img.src = SPRITE_LOCAL + id + '.png';
  }

  function onSpriteError(img) {
    if (img.dataset.stage === 'local') {
      img.dataset.stage = 'cdn';
      img.src = SPRITE_CDN + img.dataset.for + '.png';
    } else {
      img.style.display = 'none';
    }
  }

  function loadSprite(id) {
    var c = cells[id];
    if (c) setSprite(c.img, id);
  }

  function paintCell(id, animate) {
    var c = cells[id];
    if (!c) return;
    c.root.classList.toggle('got', !!answered[id]);
    if (answered[id]) {
      c.root.title = 'No.' + pad(id) + ' ' + BY_ID[id].name + '（タップで取り消し）';
      loadSprite(id);
      if (animate) {
        c.root.classList.remove('just-got');
        void c.root.offsetWidth;            // アニメーションを再生し直す
        c.root.classList.add('just-got');
      }
    } else {
      c.root.title = 'No.' + pad(id);
      c.root.classList.remove('just-got');
    }
  }

  function onCellClick(ev) {
    var cell = ev.target.closest('.cell');
    if (!cell || !cell.classList.contains('got')) return;
    var id = Number(cell.dataset.id);
    delete answered[id];
    answeredCount--;
    paintCell(id, false);
    renderStats();
    save();
    showToast(BY_ID[id].name + ' を取り消しました', null, 'warn');
  }

  /* ===================== 回答を埋める ===================== */

  function fill(ids, heard) {
    var id = null;
    for (var i = 0; i < ids.length; i++) {
      if (!answered[ids[i]]) { id = ids[i]; break; }
    }
    if (id === null) return null;        // 全部すでに埋まっている（言い直し）
    answered[id] = true;
    answeredCount++;
    paintCell(id, true);
    return id;
  }

  /**
   * 認識テキストを判定して埋める。埋まったポケモンの配列を返す。
   */
  function consume(text) {
    if (!text) return [];
    var got = [];
    matcher.match(text).forEach(function (hit) {
      var id = fill(hit.ids, hit.heard);
      if (id !== null) got.push(id);
    });
    if (got.length) {
      renderStats();
      save();
      announce(got);
      beep(answeredCount >= LIST.length ? 'done' : 'hit');
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
      if (answeredCount >= LIST.length) finish();
    }
    return got;
  }

  function announce(ids) {
    var first = BY_ID[ids[0]];
    var label = first.name + (ids.length > 1 ? ' ほか' + (ids.length - 1) + '匹' : '');
    showToast(label, first.id, 'hit');
  }

  function finish() {
    stopTimer();
    setTimeout(function () {
      showToast('コンプリート！ ' + formatTime(totalElapsed()), null, 'done', 6000);
    }, 500);
  }

  /* ===================== 表示更新 ===================== */

  function renderStats() {
    el.count.textContent = String(answeredCount);
    var pct = (answeredCount / LIST.length) * 100;
    el.progressBar.style.width = pct.toFixed(2) + '%';
    el.progress.setAttribute('aria-valuenow', String(answeredCount));
  }

  function formatTime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = ('0' + m).slice(-2), ss = ('0' + sec).slice(-2);
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function totalElapsed() {
    return elapsedMs + (runningSince ? Date.now() - runningSince : 0);
  }

  function renderTimer() { el.timer.textContent = formatTime(totalElapsed()); }

  function startTimer() {
    if (runningSince || answeredCount >= LIST.length) return;
    runningSince = Date.now();
  }

  function stopTimer() {
    if (!runningSince) return;
    elapsedMs += Date.now() - runningSince;
    runningSince = null;
    save();
  }

  setInterval(function () { if (runningSince) renderTimer(); }, 500);

  var toastTimer = null;
  function showToast(text, spriteId, kind, ms) {
    el.toast.className = 'toast show' + (kind === 'warn' ? ' warn' : kind === 'done' ? ' done' : '');
    el.toast.textContent = '';
    if (spriteId) {
      var img = document.createElement('img');
      img.alt = '';
      img.addEventListener('error', function () { onSpriteError(img); });
      setSprite(img, spriteId);
      el.toast.appendChild(img);
      var no = document.createElement('span');
      no.className = 'no';
      no.textContent = 'No.' + pad(spriteId);
      el.toast.appendChild(no);
    }
    el.toast.appendChild(document.createTextNode(text));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, ms || 2200);
  }

  function addLog(text, gotIds, source) {
    var li = document.createElement('li');
    var src = document.createElement('span');
    src.className = 'src';
    src.textContent = (source === 'manual' ? '⌨ ' : '🎤 ');
    li.appendChild(src);

    var heard = document.createElement('span');
    heard.className = 'heard';
    heard.textContent = '「' + text + '」';
    li.appendChild(heard);

    var res = document.createElement('span');
    if (gotIds.length) {
      res.className = 'hit';
      res.textContent = ' → ' + gotIds.map(function (id) { return BY_ID[id].name; }).join('、');
    } else {
      res.className = 'miss';
      res.textContent = ' → 該当なし';
    }
    li.appendChild(res);

    el.logList.insertBefore(li, el.logList.firstChild);
    while (el.logList.children.length > LOG_MAX) el.logList.removeChild(el.logList.lastChild);
  }

  /* ===================== 効果音 ===================== */

  var audioCtx = null;
  function beep(kind) {
    if (!soundOn) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var notes = kind === 'done' ? [523, 659, 784, 1047] : [880, 1320];
      notes.forEach(function (freq, i) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        var t0 = audioCtx.currentTime + i * (kind === 'done' ? 0.13 : 0.06);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      });
    } catch (e) { /* 音が出せなくても進行には影響しない */ }
  }

  /* ===================== 音声認識 ===================== */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recog = null;
  var wantListening = false;      // ユーザーが「聞かせたい」状態か
  var engineRunning = false;      // エンジンが実際に動いているか
  var restartTimer = null;
  var restartStreak = 0;
  var lastActivity = 0;

  function setMicUI(state, text) {
    document.body.classList.toggle('listening', state === 'listening');
    el.micBtn.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
    el.micBtnLabel.textContent = state === 'listening' ? 'ストップ' : 'スタート';
    el.micStatusText.textContent = text;
  }

  function createRecognition() {
    var r = new SR();
    r.lang = 'ja-JP';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 5;

    r.onstart = function () {
      engineRunning = true;
      lastActivity = Date.now();
      setMicUI('listening', '聞き取り中… そのまま名前を言ってください');
    };
    r.onaudiostart = r.onsoundstart = r.onspeechstart = function () {
      lastActivity = Date.now();
      restartStreak = 0;
    };
    r.onresult = handleResult;
    r.onerror = handleError;
    r.onend = handleEnd;
    return r;
  }

  function handleResult(ev) {
    lastActivity = Date.now();
    restartStreak = 0;
    var interimText = '';

    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var result = ev.results[i];
      var top = result[0] ? result[0].transcript : '';

      // 候補は全部試す。カタカナで返ってくるのは第2候補以降ということがよくある。
      var got = [];
      for (var j = 0; j < result.length && j < 5; j++) {
        var alt = result[j] && result[j].transcript;
        if (!alt) continue;
        consume(alt).forEach(function (id) { if (got.indexOf(id) === -1) got.push(id); });
      }

      if (result.isFinal) {
        if (top.trim()) addLog(top.trim(), got, 'voice');
      } else {
        interimText = top;
      }
    }
    el.interim.textContent = interimText;
  }

  function handleError(ev) {
    var code = ev && ev.error;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      wantListening = false;
      stopTimer();
      setMicUI('idle', 'マイクが許可されていません（アドレスバーの🔒から許可してください）');
      showNotice('<strong>マイクがブロックされています。</strong> ブラウザのアドレスバー左の鍵アイコンから「マイク」を許可して、もう一度スタートを押してください。');
      return;
    }
    if (code === 'audio-capture') {
      wantListening = false;
      stopTimer();
      setMicUI('idle', 'マイクが見つかりません');
      return;
    }
    // no-speech / aborted / network などは再起動で復帰する
    if (code === 'network') setMicUI('listening', '通信が不安定です。再接続しています…');
  }

  function handleEnd() {
    engineRunning = false;
    if (!wantListening) {
      setMicUI('idle', 'マイクは止まっています');
      return;
    }
    // Chrome は無音がしばらく続くと勝手に終了するので、そのたびに開き直す。
    // 何度も即終了する（＝何かおかしい）ときだけ、じわじわ間隔を空ける。
    restartStreak++;
    var delay = Math.min(200 + restartStreak * 150, 1500);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startRecognition, delay);
  }

  function startRecognition() {
    if (!wantListening || !recog || engineRunning) return;
    try {
      recog.start();
      engineRunning = true;
    } catch (e) {
      // InvalidStateError＝実はまだ動いている。呼び直しても同じなので onend を待つ
      engineRunning = true;
    }
  }

  // イベントが完全に止まってしまったときの保険
  setInterval(function () {
    if (!wantListening || !recog) return;
    if (!engineRunning) { startRecognition(); return; }
    if (Date.now() - lastActivity < 25000) return;
    lastActivity = Date.now();
    try { recog.abort(); } catch (e) { engineRunning = false; }
  }, 5000);

  function startListening() {
    if (!SR) return;
    if (!recog) recog = createRecognition();
    wantListening = true;
    restartStreak = 0;
    lastActivity = Date.now();
    setMicUI('listening', 'マイクを準備しています…');
    startTimer();
    requestWakeLock();
    startRecognition();
  }

  function stopListening() {
    wantListening = false;
    clearTimeout(restartTimer);
    stopTimer();
    releaseWakeLock();
    setMicUI('idle', 'マイクは止まっています');
    el.interim.textContent = '';
    if (recog) { try { recog.stop(); } catch (e) {} }
  }

  /* ===================== 画面を消させない ===================== */

  var wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* 取れなくても支障はない */ });
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !wantListening) return;
    requestWakeLock();
    lastActivity = Date.now();
    startRecognition();
  });

  /* ===================== お知らせ ===================== */

  function showNotice(html) {
    el.notice.innerHTML = html;
    el.notice.hidden = false;
  }

  function checkEnvironment() {
    if (!SR) {
      showNotice('<strong>このブラウザは音声認識に対応していません。</strong> Chrome か Edge（PC / Android）で開くと声で遊べます。'
        + 'このままでも下の入力欄から手入力で遊べます。');
      el.micBtn.disabled = true;
      setMicUI('idle', '音声認識に非対応のブラウザです');
      return;
    }
    if (location.protocol === 'file:') {
      showNotice('<strong>ファイルを直接開いているため、マイクが使えないことがあります。</strong> '
        + 'このフォルダで <code>python3 -m http.server 8000</code> を実行し、'
        + '<code>http://localhost:8000/</code> を開いてください。');
    }
  }

  /* ===================== 操作 ===================== */

  el.micBtn.addEventListener('click', function () {
    if (wantListening) stopListening(); else startListening();
  });

  el.manualForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = el.manualInput.value.trim();
    if (!text) return;
    startTimer();
    var got = consume(text);
    addLog(text, got, 'manual');
    if (got.length) {
      el.manualInput.value = '';
    } else {
      el.manualForm.classList.remove('shake');
      void el.manualForm.offsetWidth;
      el.manualForm.classList.add('shake');
      showToast('「' + text + '」は見つかりませんでした', null, 'warn');
    }
  });

  el.revealBtn.addEventListener('click', function () {
    if (!revealed && !confirm('まだ言えていないポケモンの名前を表示します。よろしいですか？')) return;
    revealed = !revealed;
    document.body.classList.toggle('revealed', revealed);
    el.revealBtn.textContent = revealed ? '答えを隠す' : '答えを表示';
    if (revealed) {
      stopTimer();
      LIST.forEach(function (p) { if (!answered[p.id]) loadSprite(p.id); });
    } else if (wantListening) {
      startTimer();
    }
  });

  el.resetBtn.addEventListener('click', function () {
    if (!confirm('最初からやり直します。埋めた ' + answeredCount + ' 匹とタイムは消えます。よろしいですか？')) return;
    Object.keys(answered).forEach(function (id) { delete answered[id]; });
    answeredCount = 0;
    elapsedMs = 0;
    runningSince = wantListening ? Date.now() : null;
    revealed = false;
    document.body.classList.remove('revealed');
    el.revealBtn.textContent = '答えを表示';
    el.logList.textContent = '';
    LIST.forEach(function (p) { paintCell(p.id, false); });
    renderStats();
    renderTimer();
    save();
  });

  el.soundToggle.addEventListener('change', function () {
    soundOn = el.soundToggle.checked;
    save();
  });

  window.addEventListener('pagehide', function () { stopTimer(); save(); });

  /* ===================== 起動 ===================== */

  load();
  buildGrid();
  LIST.forEach(function (p) { if (answered[p.id]) paintCell(p.id, false); });
  el.soundToggle.checked = soundOn;
  renderStats();
  renderTimer();
  checkEnvironment();
})();
