/* =============================================================
 *  共享：Vercel Serverless 入口 —— 用 QuizApi
 *  环境变量（部署时在 Vercel Project Settings → Environment Variables 里填）：
 *    GH_TOKEN   = 你的 GitHub PAT（classic PAT，勾选 gist 权限）
 *    GIST_ID    = 用来存 userdata.json 的 Gist ID（scripts/create-gist.cjs 一键生成）
 *  注：Vercel Serverless 是"每次请求冷启动"，内存缓存不能复用，因此我们对
 *      POST 请求强制 flushImmediately（请求返回前确保写入 Gist）。
 * ============================================================= */

import { createStorageFromEnv } from '../lib/storage.js';
import { createQuizApi } from '../lib/quiz-api.js';

const storage = createStorageFromEnv({});
const api = createQuizApi({ storage });

/** 通用响应：CORS + JSON + 预检 */
function send(res, payload, status = 200, extraHeaders = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.setHeader('Content-Type', typeof payload === 'string' ? (extraHeaders['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    if (k.toLowerCase() !== 'content-type') res.setHeader(k, v);
  }
  res.status(status).send(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body != null) return resolve(req.body || {});
    const chunks = [];
    let size = 0;
    const MAX = 10 * 1024 * 1024;
    req.on('data', (c) => {
      size += Buffer.byteLength(c);
      if (size > MAX) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf-8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Vercel Node.js Handler（默认 Express 风格的 req/res）
export default async function handler(req, res) {
  // CORS OPTIONS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  try {
    if (req.method === 'GET') {
      const r = await api.getSync({ forceReload: true });
      return send(res, r.json, r.status);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const r = await api.postSync(body, { flushImmediately: true });
      return send(res, r.json, r.status);
    }
    return send(res, { ok: false, error: `method ${req.method} not allowed` }, 405);
  } catch (e) {
    console.error('[api/sync] uncaught:', e);
    return send(res, { ok: false, error: e.message || 'server error', storage: storage.kind }, 500);
  }
}
