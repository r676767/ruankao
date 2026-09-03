/* =============================================================
 *  lib/quiz-api.js
 *  统一路由层：本地 server.js 和 Vercel Serverless api/*.js 都复用这里
 *  只暴露一个 createQuizApi(storage, flatQuestionsFactory) → { getSync, postSync, postReset }
 *  说明：flatQuestionsFactory 是可选的 async 函数，返回 [{question:{id},chapter:{id},section:{id}}]
 *        reset 按章节/节过滤时才需要。没有时 reset 只会做「全部重置」。
 * ============================================================= */

import {
  emptyUserData,
  cloneUserData,
  mergeProgress,
  applySyncPatch,
  resetSection,
} from './userdata-core.js';

export function createQuizApi({ storage, flatQuestionsProvider }) {
  let memorySnapshot = null;    // 长期运行进程（server.js）内存缓存
  let dirty = false;
  let saveTimer = null;

  async function _ensureLoaded(opts) {
    const force = opts && opts.forceReload;
    if (!memorySnapshot || force) {
      memorySnapshot = await storage.load();
    }
    return memorySnapshot;
  }

  // 批写：短期多次更新只落盘/写 Gist 一次
  function _scheduleSave(delayMs = 450) {
    dirty = true;
    // GistStorage / Serverless 场景：flushImmediately=true 会立刻写，
    // 此处若已经有定时器则重置时间（快速连续写入最后统一 1 次，减少写放大）
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!dirty || !memorySnapshot) return;
      try {
        await storage.save(memorySnapshot);
        dirty = false;
      } catch (e) {
        console.error('[quiz-api] 保存失败:', e.message);
      }
    }, delayMs);
  }

  async function _flushSave() {
    if (!memorySnapshot) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    // 注意：即使 dirty=false，只要外部主动 flush，也同步一次（避免 caller 确保写入磁盘/Gist 时被 dirty 状态误跳过）
    await storage.save(memorySnapshot);
    dirty = false;
  }

  function _snapshotWithoutWrong(u) {
    // 对外返回时 wrong 从 progress 实时重建（避免内存里冗余）
    const { wrong, ...rest } = cloneUserData(u);
    void wrong;
    return rest;
  }

  async function getSync({ forceReload = false } = {}) {
    const u = await _ensureLoaded({ forceReload });
    const { progress, favorites, last, version } = cloneUserData(u);
    const wrongFromProgress = _rebuildWrongFromProgress(progress);
    return {
      status: 200,
      json: { progress, wrong: wrongFromProgress, favorites, last, version },
    };
  }

  function _rebuildWrongFromProgress(progress) {
    const list = [];
    for (const [qid, rec] of Object.entries(progress || {})) {
      if (rec && rec.my && rec.correct === false) list.push({ id: qid, answeredAt: rec.answeredAt || Date.now() });
    }
    list.sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
    const seen = new Set();
    return list.filter(x => seen.has(x.id) ? false : (seen.add(x.id), true));
  }

  async function postSync(patch, opts = {}) {
    // patch: { progress, favorites, last }
    if (!patch || typeof patch !== 'object') {
      return { status: 400, json: { ok: false, error: 'body 必须是 JSON 对象' } };
    }
    const base = await _ensureLoaded();
    const enforceExact = !!(opts && opts.replaceSnapshot);
    const next = applySyncPatch(base, patch, { enforceExactSnapshot: enforceExact });
    memorySnapshot = next;
    if (opts.flushImmediately) await _flushSave(); else _scheduleSave();

    // 回传服务端最终状态
    const { progress, favorites, last, version } = cloneUserData(memorySnapshot);
    const wrong = _rebuildWrongFromProgress(progress);
    return {
      status: 200,
      json: { ok: true, progress, wrong, favorites, last, version },
    };
  }

  async function postReset(body, opts = {}) {
    const { chapterId = null, sectionId = null, forceAll = false } = body || {};
    const base = await _ensureLoaded();
    let flatQs = null;
    if (typeof flatQuestionsProvider === 'function') {
      try { flatQs = await flatQuestionsProvider(); }
      catch (e) { console.warn('[quiz-api] flatQuestionsProvider 失败，只能全部重置：', e.message); }
    }
    // 如果提供了 chapterId/sectionId 但拿不到 flatQs，只能回退为不执行（会报错）
    if ((chapterId || sectionId) && !flatQs && !forceAll) {
      return { status: 400, json: { ok: false, error: '当前环境无法按章节重置（题目加载器不可用）。如需全部重置请在首页顶部「重置」按钮连点。' } };
    }
    memorySnapshot = resetSection(base, chapterId, sectionId, flatQs || []);
    if (opts.flushImmediately) await _flushSave(); else _scheduleSave();
    const { progress, favorites, last, version } = cloneUserData(memorySnapshot);
    const wrong = _rebuildWrongFromProgress(progress);
    return {
      status: 200,
      json: { ok: true, progress, wrong, favorites, last, version },
    };
  }

  return {
    getSync,
    postSync,
    postReset,
    // 给长运行进程的维护钩子
    _internal: {
      async flush() { await _flushSave(); },
      async reload() { memorySnapshot = null; return _ensureLoaded(); },
    },
  };
}
