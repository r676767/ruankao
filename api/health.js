import { createStorageFromEnv } from '../lib/storage.js';

const storage = createStorageFromEnv({});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    // 启动时 ping 一次存储：确保配置可用
    let ok = true, detail = '';
    try {
      await storage.load();
      detail = storage.describe();
    } catch (e) {
      ok = false;
      detail = e.message;
    }
    return res.status(200).json({ ok: !!ok, ts: Date.now(), version: 1, storage: storage.kind, detail });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
