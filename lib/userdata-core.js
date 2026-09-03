/* =============================================================
 *  lib/userdata-core.js
 *  用户进度数据相关的纯函数工具（无副作用，Vercel/本地/测试通用）
 * ============================================================= */

const USERDATA_VERSION_TICK = 1;

/** 返回一份全新的空 userdata（带初始时间戳版本号） */
export function emptyUserData() {
  return {
    progress: {},
    wrong: [],
    favorites: [],
    last: null,
    version: Date.now() * USERDATA_VERSION_TICK,
  };
}

/** 安全深拷贝 JSON 结构（避免外部引用污染内存状态） */
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

/** 重建错题列表（从 progress 扫描，progress 始终是唯一权威数据源） */
export function rebuildWrongFromProgress(progress) {
  const list = [];
  for (const [qid, rec] of Object.entries(progress || {})) {
    if (rec && rec.my && rec.correct === false) {
      list.push({ id: qid, answeredAt: rec.answeredAt || Date.now() });
    }
  }
  list.sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
  const seen = new Set();
  return list.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** 合并两份 progress：同一题 answeredAt 更新的覆盖；错题重建由上层单独调用 */
export function mergeProgress(localProgress, serverProgress) {
  const merged = { ...(localProgress || {}) };
  for (const [qid, rec] of Object.entries(serverProgress || {})) {
    if (!rec) continue;
    const prev = merged[qid];
    if (!prev) { merged[qid] = { ...rec }; continue; }
    const tsPrev = prev.answeredAt || 0;
    const tsCur = rec.answeredAt || 0;
    if (tsCur >= tsPrev) merged[qid] = { ...rec };
  }
  return merged;
}

/** 把客户端上传的 payload 合并进当前 userdata（幂等） */
export function applySyncPatch(currentUserData, patch, { enforceExactSnapshot = false } = {}) {
  const cur = cloneUserData(currentUserData);
  if (patch && typeof patch === 'object') {
    if (enforceExactSnapshot) {
      // 调用方希望 patch.progress / favorites 就是最终状态（哪怕是空数组/空对象）
      // 也即"快照写回"模式，不再 merge 旧 currentUserData 里的 progress/favorites
      // last 仍然按时间戳更新，避免意外清空
      cur.progress = patch.progress && typeof patch.progress === 'object' ? { ...patch.progress } : {};
      if (Array.isArray(patch.favorites)) cur.favorites = Array.from(new Set(patch.favorites));
      else if (Object.prototype.hasOwnProperty.call(patch, 'favorites')) cur.favorites = [];
    } else {
      // 默认 merge 模式（客户端答题上传）
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

/** 按 section 重置进度 */
export function resetSection(currentUserData, chapterId, sectionId, flatQuestions /* [{question:{id}, chapter:{id}, section:{id}}] */) {
  const cur = cloneUserData(currentUserData);
  const toRemove = new Set();
  for (const f of flatQuestions || []) {
    if (!f?.question?.id) continue;
    const matchChapter = !chapterId || f.chapter?.id === chapterId;
    const matchSection = !sectionId || f.section?.id === sectionId;
    if (matchChapter && matchSection) toRemove.add(f.question.id);
  }
  if (!chapterId && !sectionId) {
    // 全部重置
    cur.progress = {};
    cur.favorites = [];
    cur.last = null;
  } else {
    for (const id of toRemove) delete cur.progress[id];
    cur.favorites = cur.favorites.filter(id => !toRemove.has(id));
    if (cur.last && cur.last.chapterId === chapterId && cur.last.sectionId === sectionId) {
      cur.last = null;
    }
  }
  cur.wrong = rebuildWrongFromProgress(cur.progress);
  cur.version = Date.now();
  return cur;
}
