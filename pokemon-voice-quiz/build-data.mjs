/*
 * build-data.mjs — data.js を PokeAPI の CSV から作り直す
 *
 *   node build-data.mjs
 *
 * 1025匹を手で書くのは無理なので、名前・世代は PokeAPI のマスタから引く。
 * ただし data.js に手で足した別名（「銭亀」「海老原」など、音声認識が
 * 返してくる漢字表記）は資産なので、既存の data.js から読み直して残す。
 * つまり何度流しても手書きの別名は消えない。
 *
 * 取得元: https://github.com/PokeAPI/pokeapi の data/v2/csv
 *   pokemon_species.csv       … id と世代
 *   pokemon_species_names.csv … 各言語の名前
 *   generations.csv / regions.csv / region_names.csv … 世代と地方名
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const BASE = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';

const LANG_KANA = 1;   // ja-hrkt（公式カタカナ表記）
const LANG_ROMA = 2;   // ja-roma
const LANG_EN = 9;

/** CSV は一度落としたら .cache に置いて使い回す */
async function csv(name) {
  if (!existsSync(CACHE)) mkdirSync(CACHE);
  const path = join(CACHE, name);
  if (!existsSync(path)) {
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`${name} の取得に失敗しました: ${res.status}`);
    writeFileSync(path, await res.text());
  }
  return parse(readFileSync(path, 'utf8'));
}

/** このマスタに引用符入りの値は出てこないので、素朴に split で足りる */
function parse(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

/** 既存 data.js から id -> 別名の配列 を拾う（手書きの漢字表記を捨てないため） */
function curatedAliases() {
  const path = join(HERE, 'data.js');
  if (!existsSync(path)) return new Map();
  const src = readFileSync(path, 'utf8');
  const out = new Map();
  const re = /\{id:(\d+),[^}]*?aliases:\[([^\]]*)\]\}/g;
  let m;
  while ((m = re.exec(src))) {
    const list = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`));
    out.set(Number(m[1]), list);
  }
  return out;
}

const species = await csv('pokemon_species.csv');
const names = await csv('pokemon_species_names.csv');
const generations = await csv('generations.csv');
const regionNames = await csv('region_names.csv');

const regionJa = new Map(
  regionNames.filter((r) => Number(r.local_language_id) === LANG_KANA)
    .map((r) => [Number(r.region_id), r.name]));

const nameByIdLang = new Map();
for (const r of names) {
  const id = Number(r.pokemon_species_id);
  if (!nameByIdLang.has(id)) nameByIdLang.set(id, new Map());
  nameByIdLang.get(id).set(Number(r.local_language_id), r.name);
}

const genById = new Map(species.map((r) => [Number(r.id), Number(r.generation_id)]));
const curated = curatedAliases();

const rows = [...genById.keys()].sort((a, b) => a - b).map((id) => {
  const byLang = nameByIdLang.get(id);
  if (!byLang || !byLang.get(LANG_KANA)) throw new Error(`No.${id} のカナ名がありません`);
  const name = byLang.get(LANG_KANA);
  const en = byLang.get(LANG_EN) || '';
  // 手書きの別名を先に、そのあとローマ字・英語名。重複と名前そのものは落とす。
  const aliases = [];
  for (const a of [...(curated.get(id) || []), byLang.get(LANG_ROMA) || '', en]) {
    if (a && a !== name && !aliases.includes(a)) aliases.push(a);
  }
  return { id, gen: genById.get(id), name, en, aliases };
});

const gens = generations.map((g) => {
  const gen = Number(g.id);
  const mine = rows.filter((r) => r.gen === gen);
  return { gen, region: regionJa.get(Number(g.main_region_id)) || '', from: mine[0].id, to: mine[mine.length - 1].id };
});

const j = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const body = [
  '// 第1〜第' + gens.length + '世代 ポケモン' + rows.length + '匹のデータ',
  '// build-data.mjs による自動生成 / 出典: PokeAPI (data/v2/csv)',
  '// name    : 公式カタカナ表記（ja-Hrkt）',
  '// en      : 英語名',
  '// aliases : 日本語音声認識が返しがちな漢字・ひらがな表記、別表記、ローマ字、英語名',
  '//           漢字表記は手で足したもので、build-data.mjs を流し直しても消えない。',
  'window.POKEMON_GENERATIONS = [',
  ...gens.map((g) => `  {gen:${g.gen}, region:${j(g.region)}, from:${g.from}, to:${g.to}},`),
  '];',
  'window.POKEMON_ALL = [',
  ...rows.map((r, i) =>
    `  {id:${r.id}, gen:${r.gen}, name:${j(r.name)}, en:${j(r.en)}, aliases:${j(r.aliases)}}` +
    (i === rows.length - 1 ? '' : ',')),
  '];',
  '',
].join('\n');

writeFileSync(join(HERE, 'data.js'), body);
console.log(`data.js を生成しました: ${rows.length}匹 / ${gens.length}世代`);
for (const g of gens) {
  console.log(`  第${g.gen}世代 ${g.region}  No.${g.from}-${g.to} (${g.to - g.from + 1}匹)`);
}
const kept = rows.filter((r) => curated.has(r.id)).length;
console.log(`既存 data.js から別名を引き継いだのは ${kept}匹`);
