/*
 * マッチャの回帰テスト。`node test-matcher.js` で実行する。
 * ブラウザを立ち上げなくても、認識テキスト → ポケモン の対応が壊れていないか確認できる。
 */
'use strict';
global.window = global;
require('./data.js');
var Matcher = require('./matcher.js');

var LIST = window.POKEMON_GEN1;
var byId = {};
LIST.forEach(function (p) { byId[p.id] = p; });
var m = new Matcher(LIST);

var pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log('  NG ' + label + (detail ? '  … ' + detail : ''));
}
function idsOf(text) {
  var r = [];
  m.match(text).forEach(function (hit) {
    hit.ids.forEach(function (id) { if (r.indexOf(id) === -1) r.push(id); });
  });
  return r;
}
function section(name) { console.log('\n# ' + name); }

/* ---- 1. データの健全性 ---- */
section('データ');
check(LIST.length === 151, '151匹ある', '実際は ' + LIST.length);
var names = {};
LIST.forEach(function (p) { names[p.name] = (names[p.name] || 0) + 1; });
check(Object.keys(names).length === 151, '名前に重複がない');
check(LIST.every(function (p, i) { return p.id === i + 1; }), '図鑑番号が1..151で連番');

/* ---- 2. 正式名称とすべての別名が自分自身に解決する ---- */
section('正式名称・別名の解決');
LIST.forEach(function (p) {
  [p.name].concat(p.aliases).forEach(function (form) {
    var ids = idsOf(form);
    check(ids.indexOf(p.id) !== -1, '「' + form + '」→ ' + p.name, '得られたid: ' + ids.join(','));
  });
});

/* ---- 3. 想定されるキー衝突だけになっているか ---- */
section('キー衝突');
var strictDup = Object.keys(m.strict).filter(function (k) { return m.strict[k].length > 1; });
check(strictDup.length === 1 && strictDup[0] === 'ニドラン',
      'strictの衝突はニドランのみ', strictDup.join(' / '));
var looseDup = Object.keys(m.loose).filter(function (k) { return m.loose[k].length > 1; })
  .filter(function (k) { return k !== 'ニトラン'; });
check(looseDup.length === 1 && looseDup[0] === 'カラカラ',
      'looseの衝突はカラカラ/ガラガラのみ', looseDup.join(' / '));
// 潰れる組は strict でちゃんと区別できること
check(idsOf('カラカラ').join() === '104', 'カラカラ は104だけ', idsOf('カラカラ').join());
check(idsOf('ガラガラ').join() === '105', 'ガラガラ は105だけ', idsOf('ガラガラ').join());
check(idsOf('ニドラン').sort().join() === '29,32', 'ニドラン は♀♂両方が候補');

/* ---- 4. 音声認識が返しそうなゆれ ---- */
section('表記ゆれ・誤認識');
[
  ['ピカチュー', 25], ['ぴかちゅう', 25], ['ライチュー', 26],
  ['不思議だね', 1], ['ふしぎそう', 2], ['不思議花', 3],
  ['人影', 4], ['銭亀', 7], ['球根', 38], ['怪力', 68],
  ['毒クラゲ', 73], ['石つぶて', 74], ['鴨ネギ', 83], ['謎の草', 43],
  ['臭い花', 44], ['まだつぼみ', 69], ['怒り猿', 57], ['鯉キング', 129],
  ['白竜', 148], ['海竜', 149], ['土佐金', 118], ['東王', 119],
  ['ウィンディ', 59], ['ケーシー', 63], ['バリアード', 122], ['ファイアー', 146],
  ['ミューツー', 150], ['ミュー', 151], ['ゴース', 92], ['ゴースト', 93],
  ['ドードー', 84], ['ドードリオ', 85], ['兜', 140], ['フシギソー', 2],
  ['リザード', 5], ['リザードン', 6], ['プリン', 39], ['プクリン', 40],
  ['サンド', 27], ['サンダー', 145], ['サンダース', 135],
  ['ニドリーナ', 30], ['ニドリーノ', 33], ['ニドクイーン', 31],
  // 音声認識が姓や熟語に変換してしまうもの
  ['沢村', 106], ['澤村', 106], ['さわむら', 106],
  ['海老原', 107], ['蛯原', 107], ['えびわら', 107],
  ['ビリリ玉', 100], ['丸マイン', 101],
  // アルファベットで返ってくるもの（イーブイ→EV）
  ['EV', 133], ['ev', 133], ['ＥＶ', 133], ['イーヴイ', 133],
  ['Pikachu', 25], ['Mewtwo', 150], ['bulbasaur', 1],
].forEach(function (t) {
  var ids = idsOf(t[0]);
  check(ids.length === 1 && ids[0] === t[1],
        '「' + t[0] + '」→ ' + byId[t[1]].name, '得られたid: ' + ids.join(','));
});

/* ---- 5. 一度の発話に複数（区切りあり / なしの連続発話） ---- */
section('複数まとめて認識');
[
  ['ピカチュウ ライチュウ', [25, 26]],
  ['ピカチュウライチュウ', [25, 26]],
  ['フシギダネフシギソウフシギバナ', [1, 2, 3]],
  ['えーと、ゼニガメとカメールとカメックス', [7, 8, 9]],
  ['コイル レアコイル', [81, 82]],
  ['レアコイルコイル', [81, 82]],
  ['次はミュウツーとミュウかな', [150, 151]],
  ['イーブイ シャワーズ サンダース ブースター', [133, 134, 135, 136]],
].forEach(function (t) {
  var ids = idsOf(t[0]).sort(function (a, b) { return a - b; });
  var want = t[1].slice().sort(function (a, b) { return a - b; });
  check(ids.join() === want.join(), '「' + t[0] + '」', '得られたid: ' + ids.join());
});

/* ---- 6. 誤爆しないこと（普通の日本語を1匹も拾わない） ---- */
section('誤爆しない');
[
  'えーと', 'うーん', 'ちょっと待って', '消して', 'それを消してください',
  'わからない', '次は何だっけ', 'あと何匹残ってる', 'もう一回言うね',
  'ありがとうございます', '今日はいい天気ですね', 'この前の会議の件ですが',
  'すごい', 'やばい', 'はい', 'そうそう', 'ミュージックを流して',
  // 2文字の漢字別名（沢村）や英字（EV）は、発話まるごと一致のときだけ拾う。
  // ※3文字以上の別名（海老原・謎の草・臭い花）は既存仕様どおり文中からも切り出される。
  'EV車に乗り換えた', '沢村さんと話しました',
].forEach(function (t) {
  var ids = idsOf(t);
  check(ids.length === 0, '「' + t + '」は無反応', '拾ってしまったid: ' + ids.join(','));
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
