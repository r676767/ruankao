/* Cloudflare Pages Functions: POST /api/reset — 全局重置 */
import { bootstrap, jsonResponse, noContentResponse } from '../_lib.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return noContentResponse();
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: `method ${request.method} not allowed (use POST)` });

  const { error, api } = bootstrap(context.env);
  if (error) return jsonResponse(500, { ok: false, error });
  let body = {};
  try { body = (request.headers.get('content-length') || '0') === '0' ? {} : await request.json(); }
  catch (e) { return jsonResponse(400, { ok: false, error: 'invalid JSON body: ' + e.message }); }
  const r = await api.postReset(body);
  return jsonResponse(r.status, r.json);
}
