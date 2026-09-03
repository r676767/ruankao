/* =============================================================
 *  Netlify Functions Wrapper（共享工具，所有 netlify/functions/*.js 调用）
 *  - 处理 CORS + OPTIONS 预检
 *  - 读取 JSON body（含 event.isBase64Encoded 解码）
 *  - 调用 lib/* 纯函数，返回 Netlify 响应格式
 * ============================================================= */

import { createStorageFromEnv } from '../../lib/storage.js';
import { createQuizApi } from '../../lib/quiz-api.js';

const storage = createStorageFromEnv({});
const api = createQuizApi({ storage });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

function jsonResponse(status, payload, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      ...extraHeaders,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function textResponse(status, text) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...CORS,
    },
    body: String(text),
  };
}

function parseBody(event) {
  if (event.body == null || event.body === '') return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf-8');
  if (raw.length === 0) return {};
  try { return JSON.parse(raw); } catch (e) {
    throw new Error('invalid JSON body: ' + e.message);
  }
}

function isPreflight(event) {
  return event.httpMethod === 'OPTIONS';
}

/** 给每个 Function 调用：try/catch 包装 + 路由分发 */
export async function handleEvent(event, { handlers }) {
  // CORS 预检
  if (isPreflight(event)) {
    return { statusCode: 204, headers: { ...CORS }, body: '' };
  }
  try {
    const method = event.httpMethod || 'GET';
    const fn = handlers[method];
    if (!fn) return jsonResponse(405, { ok: false, error: `method ${method} not allowed` });
    const body = (method === 'POST') ? parseBody(event) : undefined;
    const result = await fn({ event, body });
    // result: { status, json } 或 { statusCode, body } 二选一
    if (result && typeof result.statusCode === 'number') return result;
    return jsonResponse(result?.status ?? 200, result?.json ?? { ok: true });
  } catch (e) {
    console.error('[netlify-fn] uncaught:', e);
    return jsonResponse(500, { ok: false, error: e.message || 'server error', storage: storage.kind });
  }
}

export { storage, api, jsonResponse, textResponse };
