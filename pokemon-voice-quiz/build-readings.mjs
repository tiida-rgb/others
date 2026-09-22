/*
 * build-readings.mjs — kanji-readings.js を KANJIDIC2 から作り直す
 *
 *   node build-readings.mjs
 *
 * 日本語の音声認識は「エビワラー」を「海老原」、「サワムラー」を「沢村」のように
 * 漢字に変換して返してくる。data.js に別名を手で足していけば個別には潰せるが、
 * 1025匹ぶんの変換候補を human が書き切るのは無理なので、漢字→読み の表を持って
 * 実行時に読みへ戻す（matcher.js の kanjiCandidates）。
 *
 * 表は KANJIDIC2 の音読み・訓読み・名乗り読みから作る。名乗り読みが要るのは、
 * 「原→わら」「東→あずま」のような苗字の読みがそこにしか無いため。
 *
 * サイズを抑えるため、ポケモン名のどこにも現れない読みは捨てる（1025匹の名前に
 * 出てこない読みは、どう転んでも一致しないので持つ意味がない）。data.js を作り
 * 直したらこちらも流し直すこと。
 *
 * データ出典:
 *   KANJIDIC2 — Electronic Dictionary Research and Development Group (EDRDG)
 *   https://www.edrdg.org/wiki/index.php/KANJIDIC_Project
 *   Creative Commons Attribution-ShareAlike 4.0 International
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');

// edrdg.org から直接引けない環境があるので、GitHub 上のミラーを既定にしている。
// 手元に kanjidic2.xml があるなら .cache/ に置けば、それが使われる。
const SOURCE = process.env.KANJIDIC2_URL
  || 'https://raw.githubusercontent.com/ffunatsu/kanjidic2_to_sql/master/kanjidic2.xml';

function toKatakana(s) {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

async function kanjidic2() {
  if (!existsSync(CACHE)) mkdirSync(CACHE);
  const path = join(CACHE, 'kanjidic2.xml');
  if (!existsSync(path)) {
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`KANJIDIC2 の取得に失敗しました: ${res.status}`);
    writeFileSync(path, await res.text());
  }
  return readFileSync(path, 'utf8');
}

/**
 * 1文字ぶんの <character> から読みを取り出す。
 * 訓読みの送り仮名（怒.る）と接辞のハイフン（お-）は落として語幹だけ使う。
 */
function readingsOf(block) {
  const out = [];
  const add = (v) => {
    const r = toKatakana(v.split('.')[0].replace(/-/g, '').trim());
    if (r && !out.includes(r)) out.push(r);
  };
  for (const m of block.matchAll(/<reading r_type="ja_(?:on|kun)">([^<]+)<\/reading>/g)) add(m[1]);
  for (const m of block.matchAll(/<nanori>([^<]+)<\/nanori>/g)) add(m[1]);
  return out;
}

const xml = await kanjidic2();

// data.js の名前に一度も出てこない読みは捨てるための素材
const dataJs = readFileSync(join(HERE, 'data.js'), 'utf8');
const names = [...dataJs.matchAll(/name:"([^"]+)"/g)].map((m) => toKatakana(m[1]));
if (!names.length) throw new Error('data.js から名前を読めませんでした');
const haystack = names.join('|');

const rows = [];
let kept = 0, dropped = 0;
for (const m of xml.matchAll(/<character>([\s\S]*?)<\/character>/g)) {
  const block = m[1];
  const literal = /<literal>([^<]+)<\/literal>/.exec(block)?.[1];
  if (!literal) continue;
  const all = readingsOf(block);
  const useful = all.filter((r) => haystack.includes(r));
  dropped += all.length - useful.length;
  if (!useful.length) continue;
  kept += useful.length;
  rows.push(`${literal}:${useful.join(',')}`);
}

// 「漢字:読み,読み」を空白区切りで1本の文字列に。JSON より 3 割ほど小さい。
const body = `// 漢字→読み の表（build-readings.mjs による自動生成）
//
// 音声認識が「海老原」のように漢字で返してきたとき、読みに戻して照合するために使う。
// matcher.js が window.KANJI_READINGS を見る。読み込めていなくても、漢字での照合が
// 効かなくなるだけでクイズ自体は動く。
//
// 形式: 「漢字:読み,読み,…」を半角スペース区切り
// ポケモン1025匹の名前に現れない読みは落としてある（data.js を作り直したら要再生成）。
//
// 出典: KANJIDIC2 / Electronic Dictionary Research and Development Group (EDRDG)
//       https://www.edrdg.org/wiki/index.php/KANJIDIC_Project
//       Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
window.KANJI_READINGS = ${JSON.stringify(rows.join(' '))};
`;

writeFileSync(join(HERE, 'kanji-readings.js'), body);
console.log(`kanji-readings.js を生成しました: ${rows.length}字 / 読み ${kept}件`);
console.log(`  ポケモン名に出てこないので捨てた読み: ${dropped}件`);
console.log(`  サイズ: ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
