/* Netlify: POST /api/reset — 重置进度（章节 / 节 / 全局） */
import { handleEvent, api } from './_lib.js';

export default async function handler(event) {
  return handleEvent(event, {
    handlers: {
      async POST({ body }) {
        // Serverless flush immediately
        const r = await api.postReset(body || {}, { flushImmediately: true });
        return r;
      },
    },
  });
}
