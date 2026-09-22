/*
 * app.js — ぜんこく1025 音声クイズ
 *
 * マイクを開きっぱなしにして（continuous + 自動再起動）、聞こえた言葉を
 * matcher.js に渡し、当たったマスを埋めていく。
 *
 * 世代ごとにタブを分けるが、聞き取りの対象は常に全1025匹。どの世代の名前を
 * 言ってもその世代のタブに埋まる（表示していないタブでも埋まる）ので、
 * タブを切り替えながら喋る必要はない。
 */
(function () {
  'use strict';

  var LIST = window.POKEMON_ALL;
  var GENS = window.POKEMON_GENERATIONS;
  var BY_ID = {};
  var BY_GEN = {};                      // 世代 -> その世代のポケモン配列
  var GEN_META = {};                    // 世代 -> { region, size }
  LIST.forEach(function (p) {
    BY_ID[p.id] = p;
    (BY_GEN[p.gen] || (BY_GEN[p.gen] = [])).push(p);
  });
  GENS.forEach(function (g) {
    GEN_META[g.gen] = { gen: g.gen, region: g.region, size: g.to - g.from + 1 };
  });

  // 聞き取りは全世代まとめて。1025匹入れても普通の日本語は拾わないことを
  // test-matcher.js の「誤爆しない」で確かめている。
  var matcher = new window.PokeMatcher(LIST);
  // 画像は同梱していないので、まず同じフォルダの sprites/ を見に行き、
  // 無ければ PokeAPI の CDN、それも駄目なら画像なしで表示する（名前だけでも遊べる）。
  var SPRITE_LOCAL = 'sprites/';
  var SPRITE_CDN = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
  var STORE_KEY = 'pokemon-voice-quiz.v2';
  var STORE_KEY_V1 = 'kanto151-voice-quiz.v1';   // カントー151だけだった頃の保存
  var LOG_MAX = 60;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    grid: $('grid'), count: $('count'), countMax: $('countMax'),
    countLabel: $('countLabel'), total: $('total'), timer: $('timer'),
    tabs: $('tabs'),
    progress: $('progress'), progressBar: $('progressBar'),
    micBtn: $('micBtn'), micBtnLabel: $('micBtnLabel'),
    micStatusText: $('micStatusText'), interim: $('interim'),
    manualForm: $('manualForm'), manualInput: $('manualInput'),
    revealBtn: $('revealBtn'), resetBtn: $('resetBtn'), soundToggle: $('soundToggle'),
    logList: $('logList'),
    toast: $('toast'), notice: $('notice')
  };

  /* ===================== 状態 ===================== */

  var answered = Object.create(null);   // id -> true（全世代ぶん）
  var answeredCount = 0;                // 全世代の合計
  var countByGen = Object.create(null); // 世代 -> 埋まった数
  var currentGen = GENS[0].gen;         // 表示中のタブ
  var tabEls = {};
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
        gen: currentGen,
        savedAt: Date.now()
      }));
    } catch (e) { /* プライベートモードなどでは保存できない。無視する */ }
  }

  function load() {
    var raw;
    // v1（カントーだけ）の保存も読む。id は変わっていないのでそのまま第1世代に入る。
    try { raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(STORE_KEY_V1); } catch (e) { return; }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      (data.answered || []).forEach(function (id) {
        if (!BY_ID[id] || answered[id]) return;
        answered[id] = true;
        answeredCount++;
        countByGen[BY_ID[id].gen] = (countByGen[BY_ID[id].gen] || 0) + 1;
      });
      elapsedMs = data.elapsedMs || 0;
      if (typeof data.soundOn === 'boolean') soundOn = data.soundOn;
      if (GEN_META[data.gen]) currentGen = data.gen;
    } catch (e) { /* 壊れていたら捨てる */ }
  }

  /* ===================== 世代タブ ===================== */

  function buildTabs() {
    GENS.forEach(function (g) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.dataset.gen = String(g.gen);
      tab.setAttribute('role', 'tab');
      tab.title = '第' + g.gen + '世代  No.' + pad(g.from) + '-' + pad(g.to);

      var region = document.createElement('span');
      region.textContent = g.region;
      var count = document.createElement('span');
      count.className = 'tab-count';

      tab.append(region, count);
      tabEls[g.gen] = { root: tab, count: count };
      el.tabs.appendChild(tab);
    });
    el.tabs.addEventListener('click', function (ev) {
      var tab = ev.target.closest('.tab');
      if (tab) selectGen(Number(tab.dataset.gen));
    });
  }

  function renderTabs() {
    GENS.forEach(function (g) {
      var t = tabEls[g.gen];
      var done = countByGen[g.gen] || 0;
      t.count.textContent = done + '/' + GEN_META[g.gen].size;
      t.root.setAttribute('aria-selected', g.gen === currentGen ? 'true' : 'false');
      t.root.classList.toggle('complete', done >= GEN_META[g.gen].size);
    });
  }

  function selectGen(gen) {
    if (gen === currentGen || !GEN_META[gen]) return;
    currentGen = gen;
    buildGrid();
    renderStats();
    save();
    if (tabEls[gen]) tabEls[gen].root.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  /* ===================== グリッド ===================== */

  /** 表示中の世代ぶんだけ作る。1025匹を一度に並べると重いので、タブごとに作り直す。 */
  function buildGrid() {
    var frag = document.createDocumentFragment();
    cells = {};
    el.grid.textContent = '';
    BY_GEN[currentGen].forEach(function (p) {
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
    BY_GEN[currentGen].forEach(function (p) {
      if (answered[p.id]) paintCell(p.id, false);
      else if (revealed) loadSprite(p.id);
    });
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
    countByGen[BY_ID[id].gen]--;
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
    countByGen[BY_ID[id].gen] = (countByGen[BY_ID[id].gen] || 0) + 1;
    paintCell(id, true);                 // 表示していない世代ならマスが無いので何もしない
    return id;
  }

  /**
   * 認識テキストを判定して埋める。埋まったポケモンの配列を返す。
   */
  function consume(text) {
    if (!text) return [];
    var before = Object.create(null);
    GENS.forEach(function (g) { before[g.gen] = countByGen[g.gen] || 0; });

    var got = [];
    matcher.match(text).forEach(function (hit) {
      var id = fill(hit.ids, hit.heard);
      if (id !== null) got.push(id);
    });
    if (got.length) {
      renderStats();
      save();
      announce(got);
      var allDone = answeredCount >= LIST.length;
      beep(allDone ? 'done' : 'hit');
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
      if (allDone) finishAll(); else celebrateGens(before);
    }
    return got;
  }

  function announce(ids) {
    var first = BY_ID[ids[0]];
    var label = first.name;
    // 表示していない世代が埋まったときは、どこに入ったのか分かるようにする
    if (first.gen !== currentGen) label += '（' + GEN_META[first.gen].region + '）';
    if (ids.length > 1) label += ' ほか' + (ids.length - 1) + '匹';
    showToast(label, first.id, 'hit');
  }

  /** この発話でちょうど言い切った世代があれば祝う */
  function celebrateGens(before) {
    GENS.forEach(function (g) {
      var size = GEN_META[g.gen].size;
      if ((countByGen[g.gen] || 0) < size || before[g.gen] >= size) return;
      beep('done');
      setTimeout(function () {
        showToast(g.region + 'をコンプリート！', null, 'done', 4000);
      }, 400);
    });
  }

  function finishAll() {
    stopTimer();
    setTimeout(function () {
      showToast('1025匹ぜんぶコンプリート！ ' + formatTime(totalElapsed()), null, 'done', 8000);
    }, 500);
  }

  /* ===================== 表示更新 ===================== */

  function renderStats() {
    var meta = GEN_META[currentGen];
    var done = countByGen[currentGen] || 0;
    el.count.textContent = String(done);
    el.countMax.textContent = '/' + meta.size;
    el.countLabel.textContent = meta.region;
    el.total.textContent = String(answeredCount);
    var pct = (done / meta.size) * 100;
    el.progressBar.style.width = pct.toFixed(2) + '%';
    el.progress.setAttribute('aria-valuemax', String(meta.size));
    el.progress.setAttribute('aria-valuenow', String(done));
    renderTabs();
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
      BY_GEN[currentGen].forEach(function (p) { if (!answered[p.id]) loadSprite(p.id); });
    } else if (wantListening) {
      startTimer();
    }
  });

  // リセットは表示中の世代だけ。9世代ぶんを確認1回で消せると事故になる。
  el.resetBtn.addEventListener('click', function () {
    var meta = GEN_META[currentGen];
    var done = countByGen[currentGen] || 0;
    if (!done) { showToast(meta.region + 'はまだ1匹も埋まっていません', null, 'warn'); return; }
    var rest = answeredCount - done;
    if (!confirm(meta.region + '（第' + currentGen + '世代）で埋めた ' + done + ' 匹を消します。'
      + (rest ? 'ほかの世代の ' + rest + ' 匹とタイムはそのままです。' : 'ぜんぶ空になるのでタイムも0に戻ります。')
      + '\nよろしいですか？')) return;

    BY_GEN[currentGen].forEach(function (p) {
      if (answered[p.id]) { delete answered[p.id]; answeredCount--; }
      paintCell(p.id, false);
    });
    countByGen[currentGen] = 0;
    if (answeredCount === 0) {
      elapsedMs = 0;
      runningSince = wantListening ? Date.now() : null;
    }
    revealed = false;
    document.body.classList.remove('revealed');
    el.revealBtn.textContent = '答えを表示';
    el.logList.textContent = '';
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
  buildTabs();
  el.grid.addEventListener('click', onCellClick);
  buildGrid();
  if (tabEls[currentGen]) tabEls[currentGen].root.scrollIntoView({ block: 'nearest', inline: 'center' });
  el.soundToggle.checked = soundOn;
  renderStats();
  renderTimer();
  checkEnvironment();
})();
