/* Cloudflare Pages Functions: GET /api/health — 存储连通性自检 */
import { bootstrap, jsonResponse, noContentResponse } from '../_lib.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return noContentResponse();

  const { error, storage } = bootstrap(context.env);
  if (error) return jsonResponse(500, { ok: false, error, storage: 'unavailable', ts: Date.now() });

  let ok = true, detail = '';
  try {
    await storage.load();
    detail = storage.describe();
  } catch (e) {
    ok = false; detail = e.message;
  }
  return jsonResponse(200, { ok: !!ok, ts: Date.now(), version: 1, storage: storage.kind, detail });
}
