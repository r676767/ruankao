// 简易静态服务 + 用户数据 API，用于本地访问刷题应用
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { createStorageFromEnv } from '../lib/storage.js';
import { createQuizApi } from '../lib/quiz-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// 静态资源 & 题库目录：兼容 docs/（GitHub Pages 规范）和 app/（历史目录）
const DOCS_DIR = path.join(ROOT, 'docs');
const OLD_APP_DIR = path.join(ROOT, 'app');
const APP_DIR = fs.existsSync(DOCS_DIR) ? DOCS_DIR : OLD_APP_DIR;

// 用户进度/配置数据目录（和源代码解耦，固定在项目根 .data/，不会因 docs/ 改名而丢数据）
const ENV_DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
const DATA_DIR = ENV_DATA_DIR || path.join(ROOT, '.data');

// 题库目录（只读，在源代码 docs/ 或 app/ 里）
const QUESTIONS_DIR = path.join(APP_DIR, 'data');
const QUESTIONS_FILE = path.join(QUESTIONS_DIR, 'questions.json');

const PORT = Number(process.env.PORT || 8080);

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
  // 常见虚拟网卡关键词（Hyper-V/VMware/VirtualBox/WSL/蓝牙/环回/APIPA），避免把它们的 IP 打印给用户导致"能连上但实际上TCP卡死"
  const VIRTUAL_KEYWORDS = /Hyper-V|Virtual|VMware|VirtualBox|WSL|Bluetooth|Loopback|Teredo|6TO4|ISATAP|Bridge|桥接|Bridge Network|Miniport|Wi-Fi Direct|Direct Access|Pseudo-Interface|TAP-Windows|TAP-Win|Docker|vEthernet/i;
  for (const k of Object.keys(nets)) {
    // 先根据网卡名过滤掉绝大多数虚拟网卡
    if (VIRTUAL_KEYWORDS.test(k)) continue;
    for (const n of nets[k] || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      const ip = n.address;
      // 根据 IPv4 段再过滤一层：169.254.x.x (APIPA 未分配) / 192.168.207.x (Hyper-V默认) / 172.17/18/19.x (Docker常见)
      if (/^169\.254\./.test(ip)) continue;
      if (/^192\.168\.207\./.test(ip)) continue;
      if (/^172\.(17|18|19|20|21|22|23|24|25|26|27|28|29|30|31)\./.test(ip)) continue;
      // 过滤掉明显是"仅主机适配器/虚拟交换机"的特殊段（优先级较低的段），仅保留 C 类家用路由器典型段 + 10.0.0.0/8（大内网）+ 172.16.x.x（企业网）
      const isPrivate = /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.16\./.test(ip);
      if (!isPrivate) continue;
      ips.push(ip);
    }
  }
  // 如果过滤后 IP 为 0（说明用户没真实网卡/未联网），兜底：返回 127.0.0.1 让用户别迷茫
  if (ips.length === 0) ips.push('127.0.0.1');
  return ips;
}

/* ----------------- 选择存储适配器 & 初始化 QuizApi ----------------- */
const storage = createStorageFromEnv({ dataDir: DATA_DIR });

// 提供 flatQuestionsProvider：在需要按章节重置时才会懒加载
let _flatQsCache = null;
async function flatQuestionsProvider() {
  if (_flatQsCache) return _flatQsCache;
  const raw = await fs.promises.readFile(QUESTIONS_FILE, 'utf-8');
  const data = JSON.parse(raw);
  const list = [];
  for (const ch of data.chapters || []) {
    for (const sec of ch.sections || []) {
      for (const q of sec.questions || []) {
        list.push({
          question: { id: q.id },
          chapter: { id: ch.id },
          section: { id: sec.id },
        });
      }
    }
  }
  _flatQsCache = list;
  return list;
}

/**
 * 兼容旧前端 body.ids：精确删除指定 questionIds（进度+收藏+错题同时清理）
 *   调用路径：
 *     1) api.getSync(forceReload=true) → 从磁盘/存储重读（避免内存过期）
 *     2) 在最新 state 基础上删除 ids
 *     3) api.postSync(patch, flushImmediately=true) → patch 到内存并同步写到磁盘
 *     4) 再次 getSync(forceReload=true) → 重新从磁盘读回来，内存也同步（避免测试脚本再读取时拿到旧内存）
 */
async function applyDeleteIds(api, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return await api.getSync();
  const { json: g } = await api.getSync({ forceReload: true });
  const progress = { ...(g.progress || {}) };
  const favs = new Set(g.favorites || []);
  for (const id of ids) {
    delete progress[id];
    favs.delete(id);
  }
  // replaceSnapshot=true：把 progress / favorites 当作最终快照（即使是空集合），不会再被旧 base 合并回来
  const patched = await api.postSync(
    { progress, favorites: Array.from(favs), last: g.last },
    { flushImmediately: true, replaceSnapshot: true }
  );
  // 再次 forceReload 以确保内存 snapshot 也与磁盘完全一致
  await api.getSync({ forceReload: true });
  return patched;
}

const api = createQuizApi({ storage, flatQuestionsProvider });

/* ----------------- HTTP 工具 ----------------- */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 10 * 1024 * 1024; // 10MB
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

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8bc0ff"/><stop offset="100%" stop-color="#5b98f7"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#g)"/><text x="32" y="42" text-anchor="middle" font-size="28" font-family="Arial, sans-serif" fill="#ffffff" font-weight="700">Q</text></svg>';

/* ----------------- API 路由（使用 QuizApi 复用层） ----------------- */
async function handleAPI(req, res, urlPath) {
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

  try {
    if (req.method === 'GET' && urlPath === '/api/sync') {
      const r = await api.getSync();
      sendJSON(res, r.json, r.status);
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/sync') {
      const body = await readJsonBody(req);
      const r = await api.postSync(body, { flushImmediately: true });
      sendJSON(res, r.json, r.status);
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/reset') {
      const body = await readJsonBody(req);
      if (body && Array.isArray(body.ids) && !body.chapterId && !body.sectionId) {
        // 旧版精确删除 ids：调用 applyDeleteIds（内部 flushImmediately）
        const r = await applyDeleteIds(api, body.ids);
        sendJSON(res, { ok: true, version: r.json.version }, r.status);
        return;
      }
      const r = await api.postReset(body || {}, { flushImmediately: true });
      sendJSON(res, r.json, r.status);
      return;
    }
    sendJSON(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error('[handleAPI] uncaught:', e);
    sendJSON(res, { ok: false, error: e.message || 'server error' }, 500);
  }
}

/* ----------------- 静态资源服务 ----------------- */
function serveStatic(req, res, urlPath) {
  const safePath = path.normalize(path.join(APP_DIR, urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(APP_DIR, path.relative(APP_DIR, safePath));
  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (urlPath && !/\.(html|css|js|json|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(urlPath)) {
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

    if (urlPath === '/health' || urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now(), version: 1, storage: storage.kind }));
      return;
    }

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

    if (urlPath.startsWith('/api/')) {
      handleAPI(req, res, urlPath);
      return;
    }

    const servePath = urlPath === '/' ? '/index.html' : urlPath;
    serveStatic(req, res, servePath);
  } catch (e) {
    console.error('[server] 未捕获错误：', e);
    res.writeHead(500); res.end('Server Error');
  }
});

/* ----------------- 启动入口 ----------------- */
(async function main() {
  // 启动前先预加载一次 userdata（提前暴露存储错误）
  try {
    const r = await api.getSync();
    console.log(`[init] 存储适配器：${storage.describe()}，记录数=${Object.keys(r.json.progress).length}`);
  } catch (e) {
    console.error('[init] 存储加载失败，但仍启动服务：', e.message);
  }

  // SIGINT / exit 确保最后 flush 一次
  const onExit = async () => {
    try { await api._internal.flush(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  server.listen(PORT, '0.0.0.0', () => {
    const qCount = (() => {
      try {
        if (fs.existsSync(QUESTIONS_FILE)) {
          const obj = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
          let n = 0, chapterN = 0;
          for (const ch of obj.chapters || []) {
            chapterN++;
            for (const s of ch.sections || []) n += (s.questions || []).length;
          }
          return { n, chapterN };
        }
      } catch {}
      return { n: 0, chapterN: 0 };
    })();

    console.log('============================================');
    console.log('  系规刷题应用 已启动 ✅');
    console.log('============================================');
    console.log(`  本机访问⭐: http://localhost:${PORT}    👉 （最推荐！本机回环 100% 必达·不经过虚拟网卡）`);
    const lans = getLanIPs();
    const realLans = lans.filter(ip => ip !== '127.0.0.1');
    if (realLans.length > 0) {
      for (const ip of realLans) {
        console.log(`  手机同WiFi: http://${ip}:${PORT}   （手机/平板跨设备）`);
      }
    } else {
      console.log(`  手机同WiFi: 未检测到可用局域网 IP，请连 WiFi/网线后重启`);
    }
    console.log('--------------------------------------------');
    console.log(`  数据: ${qCount.n} 道题 · ${qCount.chapterN} 章`);
    console.log(`  存储: ${storage.describe()}`);
    if (storage.kind === 'file') {
      console.log('  进度/错题 服务端保存，手机/电脑 数据共享');
    } else if (storage.kind === 'gist') {
      console.log('  进度/错题 GitHub Gist 持久化，Vercel 部署重启也不丢（0 元免费实时同步）');
    }
    console.log('  ⚠️  请勿访问 192.168.207.x / VMware / Hyper-V 等虚拟IP：跨子网会卡死"正在加载题库..."');
    console.log('  按 Ctrl + C 停止服务');
    console.log('============================================');
  });
})().catch(e => { console.error('[main] 启动失败:', e); process.exit(1); });
