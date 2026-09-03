import { createStorageFromEnv } from '../lib/storage.js';
import { createQuizApi } from '../lib/quiz-api.js';

const storage = createStorageFromEnv({});
const api = createQuizApi({ storage });

function send(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.status(status).send(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body != null) return resolve(req.body || {});
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += Buffer.byteLength(c);
      if (size > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return send(res, { ok: false, error: 'method not allowed' }, 405);
  }
  try {
    const body = await readBody(req);
    // 兼容旧版 body.ids 精确删除
    if (body && Array.isArray(body.ids) && !body.chapterId && !body.sectionId) {
      const g = await api.getSync({ forceReload: true });
      const progress = { ...(g.json.progress || {}) };
      const favs = new Set(g.json.favorites || []);
      for (const id of body.ids) {
        delete progress[id];
        favs.delete(id);
      }
      // replaceSnapshot=true：把删除后的 progress/favorites 作为最终 snapshot 写回
      const patched = await api.postSync(
        { progress, favorites: Array.from(favs), last: g.json.last },
        { flushImmediately: true, replaceSnapshot: true }
      );
      // Serverless 冷启动：下一次调用会重新 forceReload，这里不必再手动调
      return send(res, { ok: true, version: patched.json.version }, patched.status);
    }
    const result = await api.postReset(body || {}, { flushImmediately: true });
    return send(res, result.json, result.status);
  } catch (e) {
    console.error('[api/reset] uncaught:', e);
    return send(res, { ok: false, error: e.message || 'server error' }, 500);
  }
}
