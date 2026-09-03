/* Cloudflare Pages Functions: GET / POST /api/sync — 跨设备进度同步 */
import { bootstrap, jsonResponse, noContentResponse } from '../_lib.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return noContentResponse();
  if (request.method === 'GET') return handleGet(context);
  if (request.method === 'POST') return handlePost(context);
  return jsonResponse(405, { ok: false, error: `method ${request.method} not allowed` });
}

async function handleGet({ env }) {
  const { error, api } = bootstrap(env);
  if (error) return jsonResponse(500, { ok: false, error });
  const r = await api.getSync({ forceReload: true });
  return jsonResponse(r.status, r.json);
}

async function handlePost({ request, env }) {
  const { error, api } = bootstrap(env);
  if (error) return jsonResponse(500, { ok: false, error });
  let body = {};
  try { body = (request.headers.get('content-length') || '0') === '0' ? {} : await request.json(); }
  catch (e) { return jsonResponse(400, { ok: false, error: 'invalid JSON body: ' + e.message }); }
  const r = await api.postSync(body, { replaceSnapshot: false });
  return jsonResponse(r.status, r.json);
}
