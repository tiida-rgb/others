/*
 * test-browser.mjs — 画面まわりの回帰テスト（任意）
 *
 * 偽の SpeechRecognition を仕込んで「マイクを開きっぱなしにして聞き取り続ける」経路を
 * 丸ごと動かす。実際にしゃべらなくても、認識結果が図鑑に反映されるかを確認できる。
 *
 *   npm i playwright && npx playwright install chromium
 *   python3 -m http.server 8000 &
 *   node test-browser.mjs
 *
 * 別のポートで動かしているときは QUIZ_URL で指定する。
 */
import { chromium } from 'playwright';

const URL = process.env.QUIZ_URL || 'http://127.0.0.1:8000/index.html';
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  NG   ' + label + (detail !== undefined ? '  … ' + detail : '')); }
};

// ページ読み込み前に偽の SpeechRecognition を仕込む。
// これで「マイクを開きっぱなしにして結果を受け取り続ける」経路を丸ごと検証できる。
const FAKE_SR = `
window.__sr = { instances: [], startCalls: 0, stopCalls: 0, abortCalls: 0 };
class FakeSpeechRecognition {
  constructor() {
    this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
    this.running = false;
    window.__sr.instances.push(this);
    window.__sr.current = this;
  }
  start() {
    window.__sr.startCalls++;
    if (this.running) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
    this.running = true;
    setTimeout(() => this.onstart && this.onstart(), 0);
  }
  stop() { window.__sr.stopCalls++; this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
  abort() { window.__sr.abortCalls++; this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
}
window.SpeechRecognition = FakeSpeechRecognition;
window.webkitSpeechRecognition = FakeSpeechRecognition;

// テストから発話をねじ込むヘルパー。alts は候補リスト（第1候補が transcript）
window.__speak = function (alts, isFinal) {
  const r = window.__sr.current;
  if (!r || !r.onresult) return 'no recognition';
  const result = alts.map(t => ({ transcript: t, confidence: 0.9 }));
  result.isFinal = !!isFinal;
  result.length = alts.length;
  const results = [result];
  results.length = 1;
  r.onresult({ resultIndex: 0, results });
  return 'spoken';
};
`;

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ locale: 'ja-JP' });
await ctx.addInitScript(FAKE_SR);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// スプライトは透明PNGで代替して待ち時間をなくす。
// アプリは sprites/ → CDN の順に試すので、両方を止めないと
// fetch-sprites.sh を流していない環境で sprites/ が404になり
// 「コンソールエラーなし」が必ず落ちる。
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const stubPng = route => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
await page.route('**raw.githubusercontent.com/**', stubPng);
await page.route('**/sprites/*.png', stubPng);

await page.goto(URL, { waitUntil: 'networkidle' });

console.log('\n# 初期表示');
ok(await page.locator('.cell').count() === 151, '最初は第1世代の151マスだけ出る');
ok(await page.locator('.tab').count() === 9, 'タブが9つ');
ok((await page.locator('.tab[aria-selected="true"]').textContent()).includes('カントー'), '最初はカントーが選択されている');
ok((await page.locator('#total').textContent()) === '0', 'ぜんたいカウンタが0');
ok((await page.locator('#count').textContent()) === '0', 'カウンタが0');
ok(await page.locator('.cell.got').count() === 0, '最初は誰も埋まっていない');
ok((await page.locator('#micStatusText').textContent()).includes('止まって'), 'マイクは停止表示');

console.log('\n# マイク開始');
await page.click('#micBtn');
await page.waitForTimeout(120);
ok(await page.evaluate(() => document.body.classList.contains('listening')), 'listening クラスが付く');
ok(await page.evaluate(() => window.__sr.current.continuous === true), 'continuous = true');
ok(await page.evaluate(() => window.__sr.current.interimResults === true), 'interimResults = true');
ok(await page.evaluate(() => window.__sr.current.lang === 'ja-JP'), 'lang = ja-JP');
ok(await page.evaluate(() => window.__sr.current.maxAlternatives >= 5), 'maxAlternatives >= 5');
ok((await page.locator('#micBtnLabel').textContent()) === 'ストップ', 'ボタンがストップ表示');

console.log('\n# 発話が図鑑に反映される');
await page.evaluate(() => window.__speak(['ピカチュウ ライチュウ'], true));
await page.waitForTimeout(80);
ok((await page.locator('#count').textContent()) === '2', '1発話で2匹埋まる', await page.locator('#count').textContent());
ok(await page.locator('.cell[data-id="25"].got').count() === 1, 'ピカチュウが埋まる');
ok(await page.locator('.cell[data-id="26"].got').count() === 1, 'ライチュウが埋まる');

console.log('\n# 漢字で認識されても拾う');
await page.evaluate(() => window.__speak(['銭亀'], true));
await page.evaluate(() => window.__speak(['不思議だね'], true));
await page.evaluate(() => window.__speak(['毒クラゲ'], true));
await page.waitForTimeout(80);
ok(await page.locator('.cell[data-id="7"].got').count() === 1, '銭亀 → ゼニガメ');
ok(await page.locator('.cell[data-id="1"].got').count() === 1, '不思議だね → フシギダネ');
ok(await page.locator('.cell[data-id="73"].got').count() === 1, '毒クラゲ → ドククラゲ');

console.log('\n# 第2候補にだけ正解が入っている場合');
await page.evaluate(() => window.__speak(['そう言えばね', 'フシギソウ'], true));
await page.waitForTimeout(60);
ok(await page.locator('.cell[data-id="2"].got').count() === 1, '候補2番目のフシギソウを拾う');

console.log('\n# 途中経過（interim）でも埋まる');
const before = await page.locator('#count').textContent();
await page.evaluate(() => window.__speak(['カメックス'], false));
await page.waitForTimeout(60);
ok(await page.locator('.cell[data-id="9"].got').count() === 1, 'interim でもカメックスが埋まる');
ok((await page.locator('#interim').textContent()) === 'カメックス', 'interim 表示に出る');
ok(Number(await page.locator('#count').textContent()) === Number(before) + 1, 'カウントが1だけ増える');

console.log('\n# 同じ名前を言い直しても二重にカウントしない');
const dup = await page.locator('#count').textContent();
await page.evaluate(() => window.__speak(['ピカチュウ'], true));
await page.waitForTimeout(60);
ok((await page.locator('#count').textContent()) === dup, '重複はカウントされない');

console.log('\n# ニドラン♀♂');
await page.evaluate(() => window.__speak(['ニドラン'], true));
await page.waitForTimeout(50);
ok(await page.locator('.cell[data-id="29"].got').count() === 1, '1回目のニドランで♀が埋まる');
ok(await page.locator('.cell[data-id="32"].got').count() === 0, 'この時点で♂はまだ');
await page.evaluate(() => window.__speak(['ニドラン'], true));
await page.waitForTimeout(50);
ok(await page.locator('.cell[data-id="32"].got').count() === 1, '2回目のニドランで♂が埋まる');

console.log('\n# 普通の会話では反応しない');
const quiet = await page.locator('#count').textContent();
for (const t of ['えーと', 'ちょっと待って', '消して', '今日はいい天気ですね']) {
  await page.evaluate(x => window.__speak([x], true), t);
}
await page.waitForTimeout(60);
ok((await page.locator('#count').textContent()) === quiet, '雑談では1匹も増えない');

console.log('\n# 聞き取りログ');
await page.evaluate(() => { document.getElementById('logDetails').open = true; });
await page.waitForTimeout(60);
ok(await page.locator('#logList li').count() > 0, 'ログに行がある');
const logText = await page.locator('#logList').innerText();
ok(logText.includes('ピカチュウ'), 'ログに認識テキストが残る');
ok(logText.includes('該当なし'), '外した発話も残る（誤認識の確認用）');

console.log('\n# エンジンが勝手に終了しても再開する');
const startsBefore = await page.evaluate(() => window.__sr.startCalls);
await page.evaluate(() => { const r = window.__sr.current; r.running = false; r.onend(); });
await page.waitForTimeout(900);
ok(await page.evaluate(() => window.__sr.startCalls) > startsBefore, '自動で start し直す',
   `before=${startsBefore} after=${await page.evaluate(() => window.__sr.startCalls)}`);
ok(await page.evaluate(() => document.body.classList.contains('listening')), '再開後も listening のまま');
await page.evaluate(() => window.__speak(['ゼニガメ カメール'], true));
await page.waitForTimeout(60);
ok(await page.locator('.cell[data-id="8"].got').count() === 1, '再開後も聞き取れる');

// 動作中に start() を呼びに行っても、InvalidStateError で再試行ループにならないこと
const idleStarts = await page.evaluate(() => window.__sr.startCalls);
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForTimeout(2000);
const afterIdle = await page.evaluate(() => window.__sr.startCalls);
ok(afterIdle - idleStarts <= 1, '稼働中は start() を呼び直し続けない',
   `start呼び出しが ${afterIdle - idleStarts} 回増えた`);

// 終了イベントが連続しても、暴走せず一定間隔で開き直すこと
const burstStarts = await page.evaluate(() => window.__sr.startCalls);
await page.evaluate(() => { for (let i = 0; i < 5; i++) { window.__sr.current.running = false; window.__sr.current.onend(); } });
await page.waitForTimeout(1500);
const afterBurst = await page.evaluate(() => window.__sr.startCalls);
ok(afterBurst > burstStarts && afterBurst - burstStarts <= 4, '連続終了でも再起動が暴走しない',
   `start呼び出しが ${afterBurst - burstStarts} 回`);
ok(await page.evaluate(() => document.body.classList.contains('listening')), '暴走テスト後も listening のまま');

console.log('\n# 誤認識の取り消し');
const beforeUndo = Number(await page.locator('#count').textContent());
await page.click('.cell[data-id="25"]');
await page.waitForTimeout(60);
ok(await page.locator('.cell[data-id="25"].got').count() === 0, 'タップでマスが戻る');
ok(Number(await page.locator('#count').textContent()) === beforeUndo - 1, 'カウントが1減る');

console.log('\n# 手入力');
await page.fill('#manualInput', 'ゲンガー');
await page.press('#manualInput', 'Enter');
await page.waitForTimeout(60);
ok(await page.locator('.cell[data-id="94"].got').count() === 1, '手入力でも埋まる');
ok((await page.locator('#manualInput').inputValue()) === '', '成功したら入力欄が空になる');

console.log('\n# 進捗の保存と復元');
const savedCount = await page.locator('#count').textContent();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(150);
ok((await page.locator('#count').textContent()) === savedCount, 'リロードしても進捗が残る', savedCount);
ok(await page.locator('.cell[data-id="94"].got').count() === 1, '埋めたマスも復元される');

console.log('\n# タイマー');
await page.click('#micBtn');
await page.waitForTimeout(1300);
const t = await page.locator('#timer').textContent();
ok(/^\d{2}:\d{2}$/.test(t) && t !== '00:00', 'マイク稼働中にタイマーが進む', t);
await page.click('#micBtn');
await page.waitForTimeout(80);
ok(!(await page.evaluate(() => document.body.classList.contains('listening'))), 'ストップで listening が外れる');
const stopped = await page.locator('#timer').textContent();
await page.waitForTimeout(1200);
ok((await page.locator('#timer').textContent()) === stopped, 'ストップ中はタイマーが止まる');

console.log('\n# 答えを表示');
page.on('dialog', d => d.accept());
await page.click('#revealBtn');
await page.waitForTimeout(120);
ok(await page.evaluate(() => document.body.classList.contains('revealed')), 'revealed クラスが付く');
ok(await page.locator('.cell[data-id="150"] .name').isVisible(), '未回答の名前が見える');
await page.click('#revealBtn');
await page.waitForTimeout(80);
ok(!(await page.locator('.cell[data-id="150"] .name').isVisible()), 'もう一度押すと隠れる');

console.log('\n# 漢字で返ってきても拾う');
// data.js に漢字別名を持たない第2世代。kanji-readings.js の読み表だけが頼り。
await page.waitForFunction(() => typeof window.KANJI_READINGS === 'string', null, { timeout: 5000 })
  .then(() => ok(true, '漢字→読みの表が読み込まれる'))
  .catch(() => ok(false, '漢字→読みの表が読み込まれる'));
await page.evaluate(() => window.__speak(['闇カラス'], true));
await page.waitForTimeout(150);
ok(await page.locator('.tab[data-gen="2"] .tab-count').textContent() === '1/100',
   '「闇カラス」がヤミカラスとして埋まる', await page.locator('.tab[data-gen="2"] .tab-count').textContent());
await page.evaluate(() => window.__speak(['会議の資料を送ります'], true));
await page.waitForTimeout(150);
ok(await page.locator('.tab[data-gen="2"] .tab-count').textContent() === '1/100',
   '漢字まじりの普通の会話では増えない');

console.log('\n# 世代タブ');
// ここまでのテストで何匹埋まっているかは決め打ちできないので、増減で見る
const num = async (sel) => Number(await page.locator(sel).textContent());
const kantoBefore = await num('#count');
const totalBefore = await num('#total');
const gotBefore = await page.locator('.cell.got').count();

// 表示していない世代の名前を言っても、その世代に埋まる
await page.evaluate(() => window.__speak(['ゲッコウガ'], true));
await page.waitForTimeout(120);
ok((await num('#count')) === kantoBefore, 'カントーのカウンタは増えない', await page.locator('#count').textContent());
ok((await num('#total')) === totalBefore + 1, 'ぜんたいのカウンタは増える', await page.locator('#total').textContent());
ok((await page.locator('.tab[data-gen="6"] .tab-count').textContent()) === '1/72', 'カロスのタブに1匹入る');
ok((await page.locator('#toast').textContent()).includes('カロス'), 'トーストが入った世代を知らせる');

await page.click('.tab[data-gen="6"]');
await page.waitForTimeout(150);
ok(await page.locator('.cell').count() === 72, 'カロスに切り替えると72マス');
ok(await page.locator('.cell[data-id="658"].got').count() === 1, 'ゲッコウガが埋まっている');
ok((await num('#count')) === 1, 'カウンタがカロスのぶんになる', await page.locator('#count').textContent());
ok((await page.locator('#countLabel').textContent()) === 'カロス', 'ラベルがカロスになる');

await page.click('.tab[data-gen="1"]');
await page.waitForTimeout(150);
ok(await page.locator('.cell').count() === 151, 'カントーに戻ると151マス');
ok(await page.locator('.cell.got').count() === gotBefore, '戻っても埋めたぶんは残っている',
   `${await page.locator('.cell.got').count()} / 期待 ${gotBefore}`);
ok((await num('#count')) === kantoBefore, 'カントーのカウンタも元どおり');

console.log('\n# 全部そろったとき');
await page.evaluate(() => {
  const input = document.getElementById('manualInput');
  const form = document.getElementById('manualForm');
  window.POKEMON_ALL.forEach(p => {
    input.value = p.name;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
});
await page.waitForTimeout(900);
ok((await page.locator('#count').textContent()) === '151', 'カントーが151匹そろう', await page.locator('#count').textContent());
ok((await page.locator('#total').textContent()) === '1025', '1025匹そろう', await page.locator('#total').textContent());
ok(await page.locator('.tab.complete').count() === 9, '9世代すべてのタブが完了表示になる');
ok((await page.locator('#toast').textContent()).includes('コンプリート'), '完走メッセージが出る');
const w = await page.evaluate(() => document.getElementById('progressBar').style.width);
ok(parseFloat(w) === 100, '進捗バーが100%', w);

console.log('\n# レイアウト');
for (const [name, size] of [['iPhone相当', { width: 390, height: 844 }], ['デスクトップ', { width: 1280, height: 900 }]]) {
  await page.setViewportSize(size);
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `${name}で横スクロールが出ない`, 'overflow=' + overflow);
  const clipped = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('.cell.got').forEach(c => {
      const n = c.querySelector('.name');
      if (n.scrollWidth > n.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1) bad.push(c.dataset.id);
    });
    return bad;
  });
  ok(clipped.length === 0, `${name}で名前が欠けない`, '欠けたマス: ' + clipped.join(','));
}
console.log('\n# JSエラー');
ok(errors.length === 0, 'コンソールエラーなし', errors.join(' | '));

await browser.close();
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + `  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
