/*
 * matcher.js — 音声認識テキストからポケモン名を拾い出すマッチャ
 *
 * 日本語の音声認識は「フシギダネ」を「不思議だね」、「ゼニガメ」を「銭亀」のように
 * 漢字・ひらがなで返したり、長音や濁点を落としたりする。さらに一度の発話に
 * 複数の名前が入る（「ピカチュウ ライチュウ」）。そこで 3 段構えで拾う。
 *
 *   1. strict : 表記ゆれを最小限だけ吸収したキーで完全一致
 *   2. loose  : 濁点・小書き・促音・長音まで潰したキーで完全一致（一意なときだけ採用）
 *   3. fuzzy  : loose キーに対して編集距離 1 まで許容（5 文字以上・候補が一意のときだけ）
 *
 * さらに「海老原」「沢村」のように漢字で返ってきたものは、kanji-readings.js の
 * 漢字→読み表で読みに戻してから 1〜3 に流す（kanjiCandidates）。別名を手で足さなくても
 * 大半の漢字変換を拾えるが、誤爆を避けるため発話まるごとが一致したときだけ採用する。
 *
 * 「カラカラ / ガラガラ」のように loose では潰れてしまう組は 2・3 を自動的に見送り、
 * strict の一致だけを採用する。
 */
(function (global) {
  'use strict';

  var VOICED = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴヷヺ';
  var PLAIN  = 'カキクケコサシスセソタチツテトハヒフヘホハヒフヘホウワヲ';
  var SMALL  = 'ァィゥェォャュョヮヵヶ';
  var BIG    = 'アイウエオヤユヨワカケ';

  var VOICED_MAP = {};
  for (var vi = 0; vi < VOICED.length; vi++) VOICED_MAP[VOICED[vi]] = PLAIN[vi];
  var SMALL_MAP = {};
  for (var si = 0; si < SMALL.length; si++) SMALL_MAP[SMALL[si]] = BIG[si];

  // 長音・中黒・空白・句読点などは strict の時点で落とす
  var STRIP_RE = /[\s　ー‐‑–—―－ｰ・･、。，．,.!?！？…「」『』（）()\[\]【】〜~"'`:;：；\/／\-_＝=＋+*]/g;
  var SPLIT_RE = /[\s　、。,.!?！？・]+/;
  var HAS_ASCII_RE = /[A-Z0-9]/;
  var HAS_KANJI_RE = /[\u3005\u4e00-\u9fff\uf900-\ufaff]/;   // 々 と漢字

  // 長音の書き分け対策。「ごうりき → ゴウリキ」を「ゴーリキー」側（strict では
  // 長音記号を落とすので「ゴリキ」）に寄せるため、お段＋ウ・え段＋イ を詰めた
  // 候補も一緒に試す。どちらが正解かは決められないので両方投げる。
  var O_DAN = 'オコソトノホモヨロヲゴゾドボポョュ';
  var E_DAN = 'エケセテネヘメレヱゲゼデベペェ';
  var KANJI_LIMIT = 400;      // 読みの組み合わせ爆発を止める上限
  var MIN_KANJI_READING = 4;  // 漢字から戻した読みは4モーラ以上のときだけ採用する

  var MIN_FUZZY_LEN = 5;   // これ未満の短い名前はあいまい一致させない（リザード / リザードン 対策）
  var MIN_SCAN_LEN = 3;    // 連続発話の途中から切り出すのは 3 文字以上のキーだけ。
                           // 2 文字以下（ゴース→「ゴス」、ケーシー→「ケシ」）まで混ぜると
                           // 「消して」→ ケシテ のような誤爆が出るので、短いキーは
                           // 「発話まるごとがそのキー」のときだけ拾う。

  function toKatakana(s) {
    return s.replace(/[ぁ-ゖ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
  }

  function normStrict(input) {
    if (input == null) return '';
    var s = String(input);
    try { s = s.normalize('NFKC'); } catch (e) { /* 古い環境では素通し */ }
    s = s.replace(/♀/g, 'メス').replace(/♂/g, 'オス');
    s = toKatakana(s);
    s = s.replace(STRIP_RE, '');
    return s.toUpperCase();
  }

  function toLoose(strict) {
    var out = '';
    for (var k = 0; k < strict.length; k++) {
      var c = strict[k];
      if (c === 'ッ') continue;                 // 促音は落とす
      if (VOICED_MAP[c]) c = VOICED_MAP[c];     // 濁点・半濁点を落とす
      if (SMALL_MAP[c]) c = SMALL_MAP[c];       // 小書きを大書きに
      out += c;
    }
    return out;
  }

  // 編集距離が max を超えたら即打ち切る Levenshtein
  function within(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = cur[0];
      for (var k = 1; k <= b.length; k++) {
        var cost = a[i - 1] === b[k - 1] ? 0 : 1;
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
        if (cur[k] < best) best = cur[k];
      }
      if (best > max) return false;
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length] <= max;
  }

  /* ---------- 漢字 → 読み ---------- */

  // kanji-readings.js は後から非同期で読み込まれることがあるので、
  // 元の文字列が変わっていたら作り直す（読めていなければ素通し）。
  var readingSrc = null, readingTable = null;
  function readings(ch) {
    var src = global.KANJI_READINGS;
    if (src !== readingSrc) {
      readingSrc = src;
      readingTable = Object.create(null);
      if (typeof src === 'string' && src) {
        var entries = src.split(' ');
        for (var i = 0; i < entries.length; i++) {
          var sep = entries[i].indexOf(':');
          if (sep > 0) readingTable[entries[i].slice(0, sep)] = entries[i].slice(sep + 1).split(',');
        }
      }
    }
    return readingTable[ch] || null;
  }

  function collapseLong(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i], prev = out.charAt(out.length - 1);
      if (c === 'ウ' && prev && O_DAN.indexOf(prev) !== -1) continue;
      if (c === 'イ' && prev && E_DAN.indexOf(prev) !== -1) continue;
      out += c;
    }
    return out;
  }

  /** 漢字まじりの文字列を、読みの候補に展開する。表が無ければ空。 */
  function kanjiCandidates(text) {
    var cands = [''], prev = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i), rs;
      if (ch === '々') rs = prev;                       // 々 は直前の字の読みを繰り返す
      else if (HAS_KANJI_RE.test(ch)) rs = readings(ch);
      else rs = [ch];
      if (!rs) return [];                               // 表に無い字が混じったら諦める
      prev = (ch !== '々' && HAS_KANJI_RE.test(ch)) ? rs : null;
      var next = [];
      for (var a = 0; a < cands.length && next.length < KANJI_LIMIT; a++)
        for (var b = 0; b < rs.length && next.length < KANJI_LIMIT; b++) next.push(cands[a] + rs[b]);
      cands = next;
    }
    var out = [];
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k], t = collapseLong(c);
      if (c && out.indexOf(c) === -1) out.push(c);
      if (t && t !== c && out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  function Matcher(list) {
    this.list = list;
    this.strict = Object.create(null);      // strictKey -> [id, ...]
    this.loose = Object.create(null);       // looseKey  -> [id, ...]
    this.looseByLen = Object.create(null);  // 長さ -> [looseKey, ...]（fuzzy 用・一意なキーのみ）
    this.maxStrictLen = 0;
    this.kanjiMemo = Object.create(null);   // 漢字の区切り -> 解決結果（null も覚える）
    this.kanjiMemoSize = 0;

    var self = this;
    list.forEach(function (p) {
      [p.name].concat(p.aliases || []).forEach(function (form) {
        var sk = normStrict(form);
        if (!sk) return;
        push(self.strict, sk, p.id);
        if (sk.length > self.maxStrictLen) self.maxStrictLen = sk.length;
        // ローマ字・英語名・数字混じりは完全一致のみ（あいまい一致の誤爆を避ける）
        if (HAS_ASCII_RE.test(sk)) return;
        push(self.loose, toLoose(sk), p.id);
      });
    });

    Object.keys(this.loose).forEach(function (key) {
      if (key.length < MIN_FUZZY_LEN) return;
      if (self.loose[key].length !== 1) return;   // loose で衝突するキーはあいまい一致の対象外
      (self.looseByLen[key.length] || (self.looseByLen[key.length] = [])).push(key);
    });
  }

  function push(map, key, id) {
    var arr = map[key] || (map[key] = []);
    if (arr.indexOf(id) === -1) arr.push(id);
  }

  /** 連続発話を左から貪欲に切り出す。gaps は拾えなかった区間 */
  Matcher.prototype.scan = function (text) {
    var s = normStrict(text);
    var hits = [], gaps = [];
    var i = 0, gapStart = 0;
    while (i < s.length) {
      var found = null;
      var max = Math.min(this.maxStrictLen, s.length - i);
      for (var len = max; len >= MIN_SCAN_LEN; len--) {
        var ids = this.strict[s.slice(i, i + len)];
        if (ids) { found = { ids: ids, text: s.slice(i, i + len), len: len }; break; }
      }
      if (found) {
        if (i > gapStart) gaps.push(s.slice(gapStart, i));
        hits.push(found);
        i += found.len;
        gapStart = i;
      } else {
        i++;
      }
    }
    if (s.length > gapStart) gaps.push(s.slice(gapStart));
    return { hits: hits, gaps: gaps };
  };

  Matcher.prototype.fuzzy = function (looseKey) {
    if (looseKey.length < MIN_FUZZY_LEN - 1) return null;
    var found = null;
    for (var len = looseKey.length - 1; len <= looseKey.length + 1; len++) {
      var keys = this.looseByLen[len];
      if (!keys) continue;
      for (var i = 0; i < keys.length; i++) {
        if (!within(looseKey, keys[i], 1)) continue;
        var ids = this.loose[keys[i]];
        if (found && found.ids[0] !== ids[0]) return null;   // 候補が割れたら採用しない
        if (!found) found = { ids: ids, key: keys[i] };
      }
    }
    return found;
  };

  /**
   * 漢字で返ってきた一区切りを、読みに戻して引く。
   * strict で決まればそれを採り、駄目なら loose まで。ある段で候補が割れたら
   * 下の段に流さずそこで見送る（曖昧なら拾わない）。
   *
   * 名乗り読みまで含めると漢字の読みは非常に緩く、普通の熟語がポケモン名に
   * 化けやすい。手書きの漢字別名70件を正解データ、普通の熟語104語を誤爆の
   * 検体にして測ったところ:
   *
   *   strict のみ          効き目 77%  誤爆 0%
   *   strict + loose       効き目 87%  誤爆 2%   ← これを採る
   *   + fuzzy              効き目 99%  誤爆 13%  （「風鈴→プリン」「土竜→ドリュウズ」）
   *
   * fuzzy は割に合わないので使わない。短い読みほど当たりやすいので
   * MIN_KANJI_READING モーラ未満も見送る。取りこぼす分（兜・三度など）は
   * data.js に別名を手で足せばよい。
   */
  Matcher.prototype.resolveKanji = function (seg) {
    // 「海」のように読みが11通りある字が並ぶと候補が数百になる。認識の途中経過
    // （interim）で同じ区切りが何度も来るので、一度出した答えは覚えておく。
    if (seg in this.kanjiMemo) return this.kanjiMemo[seg];
    var got = this.resolveKanjiUncached(seg);
    if (this.kanjiMemoSize > 500) { this.kanjiMemo = Object.create(null); this.kanjiMemoSize = 0; }
    this.kanjiMemo[seg] = got;
    this.kanjiMemoSize++;
    return got;
  };

  Matcher.prototype.resolveKanjiUncached = function (seg) {
    var cands = kanjiCandidates(seg);
    if (!cands.length) return null;
    var tiers = [Object.create(null), Object.create(null)];
    for (var i = 0; i < cands.length; i++) {
      var sk = normStrict(cands[i]);
      if (!sk || sk.length < MIN_KANJI_READING) continue;
      if (this.strict[sk]) { tiers[0][this.strict[sk].join()] = this.strict[sk]; continue; }
      var lk = toLoose(sk);
      if (this.loose[lk] && this.loose[lk].length === 1) tiers[1][this.loose[lk].join()] = this.loose[lk];
    }
    for (var t = 0; t < tiers.length; t++) {
      var keys = Object.keys(tiers[t]);
      if (keys.length === 1) return tiers[t][keys[0]];
      if (keys.length > 1) return null;
    }
    return null;
  };

  /**
   * 認識テキストから候補を取り出す。
   * 戻り値: [{ ids: [id, ...], heard: '…', method: 'exact' | 'loose' | 'fuzzy' }, ...]
   * ids が複数なのは同名候補（ニドラン♀ / ♂）のとき。どちらを埋めるかは呼び出し側が決める。
   */
  Matcher.prototype.match = function (text) {
    var out = [], seen = Object.create(null);
    function add(ids, heard, method) {
      var sig = ids.join(',');
      if (seen[sig]) return;
      seen[sig] = true;
      out.push({ ids: ids, heard: heard, method: method });
    }

    var scanned = this.scan(text);
    scanned.hits.forEach(function (h) { add(h.ids, h.text, 'exact'); });

    // 発話を区切った各トークン。まるごと一致なら短いキー（ゴース・兜 など）も拾う
    var segs = Object.create(null);
    scanned.gaps.forEach(function (g) { segs[g] = true; });
    var tokens = String(text == null ? '' : text).split(SPLIT_RE);
    for (var t = 0; t < tokens.length; t++) {
      var st = normStrict(tokens[t]);
      if (!st) continue;
      segs[st] = true;
      var whole = this.strict[st];
      if (whole) add(whole, st, 'exact');
    }

    var self = this;
    Object.keys(segs).forEach(function (seg) {
      if (HAS_ASCII_RE.test(seg)) return;
      // 漢字が混じっている区切りは、かなのキーとは噛み合わないので読みに戻す経路へ。
      if (HAS_KANJI_RE.test(seg)) {
        var k = self.resolveKanji(seg);
        if (k) add(k, seg, 'kanji');
        return;
      }
      if (seg.length < 2) return;
      var lk = toLoose(seg);
      var ids = self.loose[lk];
      if (ids) {
        if (ids.length === 1) add(ids, seg, 'loose');
        return;                 // loose で複数に潰れるキーは strict の一致に委ねる
      }
      var f = self.fuzzy(lk);
      if (f) add(f.ids, seg, 'fuzzy');
    });

    return out;
  };

  Matcher.kanjiCandidates = kanjiCandidates;
  Matcher.normStrict = normStrict;
  Matcher.toLoose = toLoose;
  Matcher.within = within;

  global.PokeMatcher = Matcher;
  if (typeof module !== 'undefined' && module.exports) module.exports = Matcher;
})(typeof window !== 'undefined' ? window : globalThis);
