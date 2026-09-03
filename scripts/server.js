// 简易静态服务 + 用户数据 API，用于本地访问刷题应用
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');

// 数据目录：支持 DATA_DIR 环境变量（云平台持久磁盘通常挂载在 /var/data 之类的路径）
// 本地开发默认使用 app/data；若未显式设置但用户数据目录不存在，会自动创建
const ENV_DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const DATA_DIR = ENV_DATA_DIR || path.join(APP_DIR, 'data');

// 题库目录（题目数据是只读文件，在源代码里）
const QUESTIONS_DIR = path.join(APP_DIR, 'data');
const QUESTIONS_FILE = path.join(QUESTIONS_DIR, 'questions.json');

// 用户数据文件：放在 DATA_DIR（可以是外部持久磁盘或默认 app/data）
const USERDATA_FILE = path.join(DATA_DIR, 'userdata.json');

const PORT = Number(process.env.PORT || 8080);

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(QUESTIONS_DIR)) fs.mkdirSync(QUESTIONS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  return ips;
}

/* ----------------- 服务端用户数据（跨设备共享） ----------------- */
function loadUserData() {
  try {
    if (fs.existsSync(USERDATA_FILE)) {
      const raw = fs.readFileSync(USERDATA_FILE, 'utf-8');
      const obj = JSON.parse(raw);
      // 兼容旧版
      if (!obj.progress || typeof obj.progress !== 'object') obj.progress = {};
      if (!obj.wrong) obj.wrong = [];
      if (!obj.favorites) obj.favorites = [];
      if (obj.last == null) obj.last = null;
      if (!obj.version) obj.version = Date.now();
      return obj;
    }
  } catch (e) {
    console.error('[userdata] 读取失败，已重置：', e.message);
  }
  return { progress: {}, wrong: [], favorites: [], last: null, version: Date.now() };
}

function saveUserData(data) {
  data.version = Date.now();
  const tmp = USERDATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0), 'utf-8');
  fs.renameSync(tmp, USERDATA_FILE);
}

let userData = loadUserData();
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveUserData(userData); }
    catch (e) { console.error('[userdata] 保存失败：', e.message); }
  }, 120);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 10 * 1024 * 1024; // 10MB 上限
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(buf.toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

// 空 favicon：返回一个 SVG 图标（避免 404 污染控制台）
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8bc0ff"/><stop offset="100%" stop-color="#5b98f7"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#g)"/><text x="32" y="42" text-anchor="middle" font-size="28" font-family="Arial, sans-serif" fill="#ffffff" font-weight="700">Q</text></svg>';

// 合并客户端上传的 progress：对每题取 answeredAt 较新的版本
function mergeProgress(serverProgress, clientProgress) {
  if (!clientProgress) return serverProgress;
  const merged = { ...serverProgress };
  for (const [qid, rec] of Object.entries(clientProgress)) {
    if (!rec || typeof rec !== 'object') continue;
    const prev = merged[qid];
    if (!prev) { merged[qid] = rec; continue; }
    const tsPrev = prev.answeredAt || 0;
    const tsCur = rec.answeredAt || 0;
    if (tsCur >= tsPrev) merged[qid] = rec;
  }
  return merged;
}

// 重建错题列表：从 progress 扫一遍（权威数据源）
function rebuildWrongFromProgress(progress) {
  const list = [];
  for (const [qid, rec] of Object.entries(progress || {})) {
    if (rec && rec.my && rec.correct === false) {
      list.push({ id: qid, answeredAt: rec.answeredAt || Date.now() });
    }
  }
  list.sort((a, b) => b.answeredAt - a.answeredAt);
  const seen = new Set();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function handleAPI(req, res, urlPath) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/sync') {
    sendJSON(res, {
      progress: userData.progress,
      wrong: userData.wrong,
      favorites: userData.favorites,
      last: userData.last,
      version: userData.version,
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/sync') {
    // 客户端把自己的数据推上来；服务端合并并返回最新数据
    readJsonBody(req)
      .then((payload) => {
        // 1) 合并 progress（按 answeredAt 取较新）
        userData.progress = mergeProgress(userData.progress, payload.progress);

        // 2) 错题：从合并后的 progress 重建（权威数据源）
        userData.wrong = rebuildWrongFromProgress(userData.progress);

        // 3) 收藏：合并并去重，显式删除的要尊重（客户端以带 removed=true 标记表示移除单项）
        const favSet = new Set(userData.favorites || []);
        if (Array.isArray(payload.favorites)) {
          for (const it of payload.favorites) {
            if (it && it.id) {
              if (it.removed) favSet.delete(it.id);
              else favSet.add(it.id);
            } else if (typeof it === 'string') {
              favSet.add(it);
            }
          }
        }
        userData.favorites = [...favSet];

        // 4) last：以较新者为准
        const lastTs = userData.last?.updatedAt || 0;
        const cliTs = payload.last?.updatedAt || 0;
        if (cliTs >= lastTs && payload.last) {
          userData.last = payload.last;
        }

        scheduleSave();

        sendJSON(res, {
          ok: true,
          progress: userData.progress,
          wrong: userData.wrong,
          favorites: userData.favorites,
          last: userData.last,
          version: userData.version,
        });
      })
      .catch((e) => {
        console.error('[sync] payload 解析失败:', e.message);
        sendJSON(res, { ok: false, error: 'bad payload' }, 400);
      });
    return;
  }

  // 兼容：独立更新进度（细粒度）
  if (req.method === 'POST' && urlPath === '/api/progress') {
    readJsonBody(req).then((payload) => {
      if (payload && payload.records && typeof payload.records === 'object') {
        userData.progress = mergeProgress(userData.progress, payload.records);
        userData.wrong = rebuildWrongFromProgress(userData.progress);
        scheduleSave();
      }
      sendJSON(res, { ok: true, version: userData.version });
    }).catch(() => sendJSON(res, { ok: false }, 400));
    return;
  }

  // 清除某节 / 全部进度
  if (req.method === 'POST' && urlPath === '/api/reset') {
    readJsonBody(req).then((payload) => {
      if (payload && payload.ids && Array.isArray(payload.ids)) {
        // 按 id 列表清除（进度 + 错题 + 收藏）
        const idSet = new Set(payload.ids);
        for (const id of idSet) delete userData.progress[id];
        userData.favorites = (userData.favorites || []).filter(id => !idSet.has(id));
      } else {
        // 全部清空
        userData.progress = {};
        userData.wrong = [];
        userData.favorites = [];
        userData.last = null;
      }
      userData.wrong = rebuildWrongFromProgress(userData.progress);
      scheduleSave();
      sendJSON(res, { ok: true, version: userData.version });
    }).catch(() => sendJSON(res, { ok: false }, 400));
    return;
  }

  sendJSON(res, { error: 'not found' }, 404);
}

function serveStatic(req, res, urlPath) {
  // 只允许访问 APP_DIR
  const safePath = path.normalize(path.join(APP_DIR, urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(APP_DIR, path.relative(APP_DIR, safePath));
  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // 忽略：让浏览器控制台的 404 尽量少；同时保留页面级 404 友好提示
      if (urlPath && !/\.(html|css|js|json|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(urlPath)) {
        // 非静态资源类路径 404 也返回友好提示
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3 style="text-align:center;margin-top:40px;color:#4d8cf0">404 · Not Found</h3>');
        return;
      }
      res.writeHead(404); res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0] || '/');

    // Render / 云平台 Health Check
    if (urlPath === '/health' || urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), version: 1 }));
      return;
    }

    // 特殊路径：favicon / robots
    if (urlPath === '/favicon.ico') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=604800',
        'Content-Length': Buffer.byteLength(FAVICON_SVG),
      });
      res.end(FAVICON_SVG);
      return;
    }
    if (urlPath === '/robots.txt') {
      const body = 'User-agent: *\nAllow: /\n';
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // API 路由
    if (urlPath.startsWith('/api/')) {
      handleAPI(req, res, urlPath);
      return;
    }

    // 静态资源
    const servePath = urlPath === '/' ? '/index.html' : urlPath;
    serveStatic(req, res, servePath);
  } catch (e) {
    console.error('[server] 未捕获错误：', e);
    res.writeHead(500); res.end('Server Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const qCount = (() => {
    try {
      if (fs.existsSync(QUESTIONS_FILE)) {
        const raw = fs.readFileSync(QUESTIONS_FILE, 'utf-8');
        const obj = JSON.parse(raw);
        let n = 0;
        for (const ch of obj.chapters || [])
          for (const s of ch.sections || []) n += (s.questions || []).length;
        const chapterN = (obj.chapters || []).length;
        return { n, chapterN };
      }
    } catch {}
    return { n: 0, chapterN: 0 };
  })();

  console.log('============================================');
  console.log('  系规刷题应用 已启动 ✅');
  console.log('============================================');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  for (const ip of getLanIPs()) {
    console.log(`  局域网访问: http://${ip}:${PORT}   （手机同WiFi可用）`);
  }
  console.log('--------------------------------------------');
  console.log(`  数据: ${qCount.n} 道题 · ${qCount.chapterN} 章`);
  console.log('  进度/错题 已改为 服务端保存，手机/电脑 数据共享');
  if (ENV_DATA_DIR) {
    console.log(`  持久数据目录(外部 DATA_DIR): ${DATA_DIR}`);
  } else {
    console.log(`  本地数据文件: ${USERDATA_FILE}`);
  }
  console.log('  按 Ctrl + C 停止服务');
  console.log('============================================');
});
