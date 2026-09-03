/* =============================================================
 *  lib/storage.js
 *  用户进度持久化：两种适配器（二选一，启动时按环境变量自动选择）
 *   · FileStorage：本地文件系统（默认，本机 npm run dev / Render+持久磁盘 场景）
 *   · GistStorage：GitHub Gist（免费、0元无卡，Vercel Serverless 场景）
 * ============================================================= */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { emptyUserData, cloneUserData } from './userdata-core.js';

const USERDATA_FILENAME = 'userdata.json';
const GIST_API = 'https://api.github.com';
const GIST_API_VERSION = '2022-11-28';
const ACCEPT_VND = 'application/vnd.github+json';

/* ----------------- 工具 ----------------- */

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': ACCEPT_VND,
    'X-GitHub-Api-Version': GIST_API_VERSION,
    'User-Agent': 'ruankao-quiz/1.0 (+https://github.com/r676767/ruankao)',
    'Content-Type': 'application/json',
  };
}

function safeJSONParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function makeDir(dir) {
  try { fsSync.mkdirSync(dir, { recursive: true }); } catch {}
}

/* ----------------- FileStorage ----------------- */

export class FileStorage {
  constructor({ dataDir }) {
    this.kind = 'file';
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, USERDATA_FILENAME);
    makeDir(this.dataDir);
  }
  async load() {
    try {
      const stat = await fs.stat(this.filePath).catch(() => null);
      if (!stat) return emptyUserData();
      const text = await fs.readFile(this.filePath, 'utf-8');
      const obj = safeJSONParse(text);
      if (!obj || typeof obj !== 'object') return emptyUserData();
      return cloneUserData(obj);
    } catch {
      return emptyUserData();
    }
  }
  async save(userData) {
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(userData, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
    return true;
  }
  describe() {
    return `FileStorage @ ${this.filePath}`;
  }
}

/* ----------------- GistStorage（免费 0 元后端） ----------------- */

export class GistStorage {
  constructor({ gistId, ghToken }) {
    this.kind = 'gist';
    this.gistId = gistId;
    this.token = ghToken;
    this._etag = null;
    if (!gistId) throw new Error('[GistStorage] 缺少 GIST_ID 环境变量');
    if (!ghToken) throw new Error('[GistStorage] 缺少 GH_TOKEN / GITHUB_TOKEN 环境变量');
  }

  async load() {
    const url = `${GIST_API}/gists/${this.gistId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...ghHeaders(this.token) },
    });
    if (res.status === 404) throw new Error('[GistStorage] GIST_ID 不存在（或 PAT 无 gist 权限）：status=404');
    if (res.status === 403 || res.status === 401) throw new Error(`[GistStorage] GitHub 鉴权失败：status=${res.status}，请检查 PAT 是否有 gist 权限`);
    if (!res.ok) throw new Error(`[GistStorage] 读取 Gist 失败：status=${res.status}`);
    this._etag = res.headers.get('etag') || null;
    const data = await res.json();
    const file = data.files && data.files[USERDATA_FILENAME];
    if (!file || file.truncated || !file.content) {
      // 文件不存在或内容为空 → 写入一份初始 userdata
      const init = emptyUserData();
      await this.save(init);
      return init;
    }
    const parsed = safeJSONParse(file.content);
    if (!parsed || typeof parsed !== 'object') {
      const init = emptyUserData();
      await this.save(init);
      return init;
    }
    return cloneUserData(parsed);
  }

  async save(userData, attempt = 0) {
    const url = `${GIST_API}/gists/${this.gistId}`;
    const content = JSON.stringify(userData, null, 2);
    const headers = { ...ghHeaders(this.token) };
    if (this._etag && attempt === 0) {
      headers['If-Match'] = this._etag;
    }
    const body = JSON.stringify({
      description: `ruankao-quiz 进度备份 · ${new Date().toISOString()}`,
      files: { [USERDATA_FILENAME]: { content } },
    });
    const res = await fetch(url, { method: 'PATCH', headers, body });
    if (res.status === 409 || res.status === 412) {
      // 版本冲突 / ETag 不匹配：重新 load 一次拿到新 ETag，最多重试 1 次
      if (attempt === 0) {
        try {
          const refetch = await fetch(url, { method: 'GET', headers: ghHeaders(this.token) });
          if (refetch.ok) this._etag = refetch.headers.get('etag') || null;
        } catch {}
        return this.save(userData, attempt + 1);
      }
      throw new Error('[GistStorage] 写入失败：版本冲突（并发写入），请稍后重试');
    }
    if (res.status === 404) throw new Error('[GistStorage] GIST_ID 不存在，写入失败：status=404');
    if (res.status === 403 || res.status === 401) throw new Error(`[GistStorage] GitHub 鉴权失败：status=${res.status}`);
    if (!res.ok) throw new Error(`[GistStorage] 写入 Gist 失败：status=${res.status}`);
    this._etag = res.headers.get('etag') || this._etag;
    return true;
  }

  describe() {
    return `GistStorage @ https://gist.github.com/${this.gistId.slice(0, 8)}…（文件：${USERDATA_FILENAME}）`;
  }
}

/* ----------------- 工厂：按环境变量自动选择适配器 ----------------- */

export function createStorageFromEnv({ dataDir, gistId, ghToken }) {
  // 优先级：显式给 GIST_ID + Token → 用 GistStorage；否则用 FileStorage
  const gId = gistId || process.env.GIST_ID || process.env.GH_GIST_ID || '';
  const tok = ghToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (gId && tok) {
    return new GistStorage({ gistId: gId, ghToken: tok });
  }
  // 缺省：文件系统
  const d = dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'app', 'data');
  return new FileStorage({ dataDir: d });
}
