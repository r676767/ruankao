/* Netlify: GET /api/health — 验证 Storage 状态（Gist / File） */
import { handleEvent, storage } from './_lib.js';

export default async function handler(event) {
  return handleEvent(event, {
    handlers: {
      async GET() {
        let ok = true, detail = '';
        try {
          await storage.load();
          detail = storage.describe();
        } catch (e) {
          ok = false;
          detail = e.message;
        }
        return {
          status: 200,
          json: { ok: !!ok, ts: Date.now(), version: 1, storage: storage.kind, detail },
        };
      },
    },
  });
}
