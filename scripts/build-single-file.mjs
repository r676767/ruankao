/* ================================================================
 * 把刷题应用打包成「单文件 HTML」，可：
 *   1) 直接下载到手机 / 电脑本地用浏览器打开（file:// 也能跑）
 *   2) 拖到任意静态托管（Netlify Drop、Vercel、Gitee Pages 等）得到公开 https 链接
 * 用法：node scripts/build-single-file.mjs [output=dist/quiz.html]
 * ================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');

const args = process.argv.slice(2);
const OUT_FILE = args[0] ? path.resolve(ROOT, args[0]) : path.join(ROOT, 'dist', '系规刷题_完整版.html');

function p(f) { return path.join(APP_DIR, f); }
function read(name) { return fs.readFileSync(p(name), 'utf-8'); }

console.log('📦 开始打包单文件…');

const html = read('index.html');
const css  = read('styles.css');
let   js   = read('app.js');
const qjsonBuf = fs.readFileSync(p('data/questions.json'));
console.log(`   · index.html : ${html.length.toLocaleString()} B`);
console.log(`   · styles.css : ${css.length.toLocaleString()} B`);
console.log(`   · app.js     : ${js.length.toLocaleString()} B`);
console.log(`   · questions.json : ${(qjsonBuf.length/1024/1024).toFixed(2)} MB`);

// ---------------- 1) 改造 JS：切到「单文件模式」 ----------------

const JS_PATCHES = [
  // 移除 DATA_URL / API_SYNC / API_RESET，加上单文件 flag
  [
    "const DATA_URL = './data/questions.json';\nconst API_SYNC = './api/sync';\nconst API_RESET = './api/reset';",
    "const __SINGLE_FILE__ = true;\n"
  ],

  // loadData：从 <script type=application/json id="__QUIZ_DATA__"> 里读取
  [
    "async function loadData() {\n  const res = await fetch(DATA_URL, { cache: 'no-cache' });\n  if (!res.ok) throw new Error('加载题库失败：HTTP ' + res.status);\n  const json = await res.json();\n  State.data = json;\n  flattenData(json);\n  State.total = State.flatQuestions.length;\n}",
    "async function loadData() {\n" +
    "  const el = document.getElementById('__QUIZ_DATA__');\n" +
    "  if (!el) throw new Error('题库数据丢失：单文件缺少 __QUIZ_DATA__ 节点');\n" +
    "  const json = JSON.parse(el.textContent);\n" +
    "  State.data = json;\n" +
    "  flattenData(json);\n" +
    "  State.total = State.flatQuestions.length;\n" +
    "}"
  ],

  // pullFromServer：单文件无服务端，不调用 fetch，重建 wrong 即可
  [
    /async\s+function\s+pullFromServer\s*\(\s*\)\s*\{[\s\S]*?\n\}/,
    "async function pullFromServer() {\n" +
    "  // 单文件模式：没有服务端，进度完全靠 localStorage\n" +
    "  try { State.wrong = rebuildWrongFromProgress(State.progress); } catch(_) {}\n" +
    "}"
  ],

  // pushToServer：noop
  [
    /async\s+function\s+pushToServer\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
    "async function pushToServer() {\n" +
    "  // 单文件模式：没有服务端，数据已落到 localStorage\n" +
    "  pendingPush = false;\n" +
    "}"
  ],

  // notifyReset：noop
  [
    /async\s+function\s+notifyReset\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
    "async function notifyReset(_ids) {\n" +
    "  // 单文件模式：没有服务端，重置已在前端操作了 progress + localStorage\n" +
    "}"
  ],
];

for (let i = 0; i < JS_PATCHES.length; i++) {
  const [pattern, replacement] = JS_PATCHES[i];
  const before = js;
  if (pattern instanceof RegExp) {
    js = js.replace(pattern, replacement);
  } else {
    if (!js.includes(pattern)) {
      console.error(`❌ 找不到 JS 替换片段 #${i + 1}：`);
      console.error('   ', pattern.slice(0, 100).replace(/\n/g, '\\n'));
      process.exit(1);
    }
    js = js.replace(pattern, replacement);
  }
  if (js === before) console.warn(`⚠️  JS 替换 #${i + 1} 未变化`);
}

// ---------------- 2) 组装最终 HTML ----------------
let finalHtml = html;

// 2a. 内联 CSS
finalHtml = finalHtml.replace(
  /<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/?\s*>/i,
  `<style>\n${css}\n</style>`
);

// 2b. 注入题库 JSON（放到 <body> 末尾前的 <script type="application/json">，避免脚本截断风险）
const qjsonText = qjsonBuf.toString('utf-8');
const dataBlock = `\n<script type="application/json" id="__QUIZ_DATA__">\n${qjsonText}\n</script>\n`;
finalHtml = finalHtml.replace(/<script\s+src="\.\/app\.js">\s*<\/script>/i,
  dataBlock + `<script>\n${js}\n</script>`);

// 2c. 水印 banner
const banner = `<!-- =========================================================
     系规 · 综合分章节刷题 2026（单文件离线版）
     生成时间：${new Date().toLocaleString('zh-CN')}
     使用方式：直接双击 / 发送到手机浏览器打开，所有进度保存在
              当前浏览器 localStorage 中；
           或拖到 https://app.netlify.com/drop 获取公开 https 链接。
========================================================= -->\n`;
finalHtml = finalHtml.replace(/<!DOCTYPE\s+html/i, banner + '<!DOCTYPE html');

// 2d. 补充 <html manifest=> 没什么用，就不改了

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, finalHtml, 'utf-8');
const size = fs.statSync(OUT_FILE).size;
console.log('');
console.log(`✅ 打包完成: ${OUT_FILE}`);
console.log(`   大小: ${(size / 1024 / 1024).toFixed(2)} MB (${size.toLocaleString()} B)`);
console.log('');
console.log('📱 电脑关机也能使用：把这个 HTML 发给自己（微信/邮箱/U盘/网盘）');
console.log('   打开方式：手机用浏览器（不是微信内置）打开该文件');
console.log('');
console.log('🌐 获取公开 https 永久链接（推荐，手机点一下就能打开）：');
console.log('   1) 打开  https://app.netlify.com/drop');
console.log('   2) 直接把  dist\\系规刷题_完整版.html  拖进页面中间');
console.log('   3) 5 秒后拿到  https://xxxxxx.netlify.app  这样的链接');
console.log('   4) 手机收藏/发到微信，点一下就能进入刷题页面');
console.log('   💡 不需要注册/登录，免费，链接永不过期');
console.log('');
console.log('提示：单文件进度使用 localStorage 保存；');
console.log('      换手机/清浏览器缓存会重置进度，这是单文件版的限制。');
console.log('      若要多端（手机+电脑）实时共享进度，用 npm run dev 方案。');
