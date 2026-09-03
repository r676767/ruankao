/* =============================================================
 *  Cloudflare Pages Functions 共享库（Workers Runtime，无 Node 原生模块依赖）
 *  包含：userdata-core 纯函数 + GistStorage（fetch 调 GitHub API）+ quiz-api
 *  所有 endpoint（health/sync/reset）都 import 这里的 bootstrap()
 * ============================================================= */

/* ---------------------- 1. userdata-core 纯函数（原样复制，无依赖） ---------------------- */
const USERDATA_VERSION_TICK = 1;
export function emptyUserData() {
  return { progress: {}, wrong: [], favorites: [], last: null, version: Date.now() * USERDATA_VERSION_TICK };
}
export function cloneUserData(u) {
  if (!u) return emptyUserData();
  return {
    progress: u.progress ? { ...u.progress } : {},
    wrong: Array.isArray(u.wrong) ? u.wrong.map(w => ({ ...w })) : [],
    favorites: Array.isArray(u.favorites) ? u.favorites.slice() : [],
    last: u.last ? { ...u.last } : null,
    version: typeof u.version === 'number' ? u.version : Date.now(),
  };
}
export function rebuildWrongFromProgress(progress) {
  const list = [];
  for (const [qid, rec] of Object.entries(progress || {})) {
    if (rec && rec.my && rec.correct === false) list.push({ id: qid, answeredAt: rec.answeredAt || Date.now() });
  }
  list.sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
  const seen = new Set();
  return list.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}
export function mergeProgress(localProgress, serverProgress) {
  const merged = { ...(localProgress || {}) };
  for (const [qid, rec] of Object.entries(serverProgress || {})) {
    if (!rec) continue;
    const prev = merged[qid];
    if (!prev) { merged[qid] = { ...rec }; continue; }
    const tsPrev = prev.answeredAt || 0, tsCur = rec.answeredAt || 0;
    if (tsCur >= tsPrev) merged[qid] = { ...rec };
  }
  return merged;
}
export function applySyncPatch(currentUserData, patch, { enforceExactSnapshot = false } = {}) {
  const cur = cloneUserData(currentUserData);
  if (patch && typeof patch === 'object') {
    if (enforceExactSnapshot) {
      cur.progress = patch.progress && typeof patch.progress === 'object' ? { ...patch.progress } : {};
      if (Array.isArray(patch.favorites)) cur.favorites = Array.from(new Set(patch.favorites));
      else if (Object.prototype.hasOwnProperty.call(patch, 'favorites')) cur.favorites = [];
    } else {
      if (patch.progress) cur.progress = mergeProgress(cur.progress, patch.progress);
      if (Array.isArray(patch.favorites)) {
        const set = new Set(cur.favorites);
        for (const id of patch.favorites) set.add(id);
        cur.favorites = Array.from(set);
      }
    }
    if (patch.last) {
      const tsOld = (cur.last && cur.last.updatedAt) || 0;
      const tsNew = patch.last.updatedAt || 0;
      if (tsNew >= tsOld) cur.last = { ...patch.last };
    }
  }
  cur.wrong = rebuildWrongFromProgress(cur.progress);
  cur.version = Date.now();
  return cur;
}
export function resetSection(currentUserData, chapterId, sectionId, flatQuestions) {
  const cur = cloneUserData(currentUserData);
  const toRemove = new Set();
  for (const f of flatQuestions || []) {
    if (!f?.question?.id) continue;
    const mc = !chapterId || f.chapter?.id === chapterId;
    const ms = !sectionId || f.section?.id === sectionId;
    if (mc && ms) toRemove.add(f.question.id);
  }
  if (!chapterId && !sectionId) {
    cur.progress = {}; cur.favorites = []; cur.last = null;
  } else {
    for (const id of toRemove) delete cur.progress[id];
    cur.favorites = cur.favorites.filter(id => !toRemove.has(id));
    if (cur.last && cur.last.chapterId === chapterId && cur.last.sectionId === sectionId) cur.last = null;
  }
  cur.wrong = rebuildWrongFromProgress(cur.progress);
  cur.version = Date.now();
  return cur;
}

/* ---------------------- 2. GistStorage（Workers 版：仅 fetch，无 Node 模块） ---------------------- */
const GIST_API = 'https://api.github.com';
const GIST_API_VERSION = '2022-11-28';
const ACCEPT_VND = 'application/vnd.github+json';
const USERDATA_FILENAME = 'userdata.json';

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

export class GistStorage {
  constructor({ gistId, ghToken }) {
    this.kind = 'gist';
    this.gistId = gistId;
    this.token = ghToken;
    if (!gistId) throw new Error('[GistStorage] 缺少 GIST_ID');
    if (!ghToken) throw new Error('[GistStorage] 缺少 GH_TOKEN');
  }
  async load() {
    const res = await fetch(`${GIST_API}/gists/${this.gistId}`, {
      headers: ghHeaders(this.token),
      cf: { cacheTtl: 0 }, // Pages Functions 缓存关（实时同步）
    });
    if (!res.ok) {
      // Gist 不存在或没权限：返回空 userdata（首次使用）
      if (res.status === 404 || res.status === 403) return emptyUserData();
      throw new Error(`Gist load 失败: HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const file = data.files && data.files[USERDATA_FILENAME];
    if (!file) return emptyUserData();
    const obj = safeJSONParse(file.content);
    if (!obj || typeof obj !== 'object') return emptyUserData();
    return cloneUserData(obj);
  }
  async save(userData) {
    const payload = {
      description: 'ruankao quiz userdata (auto-synced)',
      files: { [USERDATA_FILENAME]: { content: JSON.stringify(userData, null, 2) } },
    };
    const res = await fetch(`${GIST_API}/gists/${this.gistId}`, {
      method: 'PATCH',
      headers: ghHeaders(this.token),
      body: JSON.stringify(payload),
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) throw new Error(`Gist save 失败: HTTP ${res.status} ${res.statusText}`);
    return true;
  }
  describe() {
    return `GistStorage @ https://gist.github.com/${this.gistId} (file: ${USERDATA_FILENAME})`;
  }
}

/* ---------------------- 3. quiz-api（Serverless 版：写操作立即 flush，无 setTimeout 批写） ---------------------- */
export function createQuizApi({ storage }) {
  async function _ensureLoaded({ forceReload = false } = {}) {
    // Serverless 每次请求都从 Gist 拉（实时同步跨设备），不保留内存缓存
    return await storage.load();
  }
  function _snapshot(u) {
    const { progress, wrong, ...rest } = cloneUserData(u);
    void wrong;
    return { progress, wrongFromProgress: rebuildWrongFromProgress(progress), ...rest };
  }
  async function getSync({ forceReload = false } = {}) {
    const u = await _ensureLoaded({ forceReload });
    const snap = _snapshot(u);
    return {
      status: 200,
      json: { progress: snap.progress, wrong: snap.wrongFromProgress, favorites: snap.favorites, last: snap.last, version: snap.version },
    };
  }
  async function postSync(patch, { replaceSnapshot = false } = {}) {
    if (!patch || typeof patch !== 'object') return { status: 400, json: { ok: false, error: 'body 必须是 JSON 对象' } };
    const base = await _ensureLoaded();
    const next = applySyncPatch(base, patch, { enforceExactSnapshot: replaceSnapshot });
    // Serverless：写操作立即同步到 Gist（确保下一个跨设备请求能读到）
    await storage.save(next);
    const snap = _snapshot(next);
    return {
      status: 200,
      json: { ok: true, progress: snap.progress, wrong: snap.wrongFromProgress, favorites: snap.favorites, last: snap.last, version: snap.version },
    };
  }
  async function postReset(body = {}) {
    const { chapterId = null, sectionId = null, forceAll = false } = body;
    const base = await _ensureLoaded();
    // Pages Functions 没有 flatQuestionsProvider（无本地 data/ 读取权限），只支持：
    //   - 全局重置（chapterId=sectionId=null 或 forceAll=true）
    //   - 前端传 chapterId/sectionId 时：由前端自己过滤 ID 列表传 replaceSnapshot 写回（通过 postSync replaceSnapshot=true）
    if ((chapterId || sectionId) && !forceAll) {
      return { status: 400, json: { ok: false, error: 'Cloudflare Functions 部署不支持按章节/节服务器端重置（因为只读 GitHub API，无法本地扫描题目列表）。请到首页顶部「重置」连点 3 次触发全局重置。' } };
    }
    const next = resetSection(base, null, null, []); // 全局重置
    await storage.save(next);
    const snap = _snapshot(next);
    return {
      status: 200,
      json: { ok: true, progress: snap.progress, wrong: snap.wrongFromProgress, favorites: snap.favorites, last: snap.last, version: snap.version },
    };
  }
  return { getSync, postSync, postReset };
}

/* ---------------------- 4. Cloudflare Pages HTTP 工具（CORS + JSON Response） ---------------------- */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

export function jsonResponse(status, payload, extra = {}) {
  return new Response(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...CORS_HEADERS,
        ...extra,
      },
    }
  );
}

export function noContentResponse(status = 204) {
  return new Response('', { status, headers: { ...CORS_HEADERS } });
}

/* ---------------------- 5. Bootstrap：从 Pages env 初始化 storage + api ---------------------- */
export function bootstrap(env) {
  const ghToken = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  const gistId = env.GIST_ID || '';
  let storage, api;
  try {
    storage = new GistStorage({ gistId, ghToken });
    api = createQuizApi({ storage });
  } catch (e) {
    return { error: e.message, storage: null, api: null };
  }
  return { error: null, storage, api };
}
