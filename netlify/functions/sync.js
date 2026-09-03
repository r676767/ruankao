/* Netlify: GET / POST /api/sync — 进度同步（POST 写入强制 flush Gist） */
import { handleEvent, api } from './_lib.js';

export default async function handler(event) {
  return handleEvent(event, {
    handlers: {
      async GET() {
        const r = await api.getSync({ forceReload: true });
        return r;  // { status, json }
      },
      async POST({ body }) {
        // Serverless 无内存复用，每次请求必须 flush 立即写入 Gist
        const r = await api.postSync(body, { flushImmediately: true });
        return r;
      },
    },
  });
}
