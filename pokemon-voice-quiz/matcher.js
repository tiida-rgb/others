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

  function Matcher(list) {
    this.list = list;
    this.strict = Object.create(null);      // strictKey -> [id, ...]
    this.loose = Object.create(null);       // looseKey  -> [id, ...]
    this.looseByLen = Object.create(null);  // 長さ -> [looseKey, ...]（fuzzy 用・一意なキーのみ）
    this.maxStrictLen = 0;

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
      if (seg.length < 2 || HAS_ASCII_RE.test(seg)) return;
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

  Matcher.normStrict = normStrict;
  Matcher.toLoose = toLoose;
  Matcher.within = within;

  global.PokeMatcher = Matcher;
  if (typeof module !== 'undefined' && module.exports) module.exports = Matcher;
})(typeof window !== 'undefined' ? window : globalThis);
