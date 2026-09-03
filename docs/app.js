/* ============================================================
 * 移动端刷题应用 主逻辑
 *   - 章节/题目数据：./data/questions.json
 *   - 用户数据：启动时 GET /api/sync，变更时 POST /api/sync
 *   - localStorage 作为离线缓存兜底（localStorage 里若有旧数据会自动合并到服务端）
 *   - 视图：home (章节列表) | quiz (答题) | wrong (错题本) | favorite (收藏) + 答题卡浮层
 * ============================================================ */

const DATA_URL = './data/questions.json';
const API_SYNC = './api/sync';
const API_RESET = './api/reset';

const LS_KEY = 'ruankao.quiz.progress.v1';
const LS_LAST = 'ruankao.quiz.last.v1';
const LS_WRONG = 'ruankao.quiz.wrong.v1';
const LS_FAV = 'ruankao.quiz.favorite.v1';

/* ----------------- 全局状态 ----------------- */
const State = {
  data: null,                       // 题库原始数据（扁平后的题目列表）
  flatQuestions: [],                // [{chapter, section, question}]
  total: 0,                         // 总题数
  idMap: new Map(),                 // questionId -> flat item 快速索引

  progress: loadLocal(LS_KEY, {}),  // { [questionId]: { my, correct, answeredAt } }
  wrong: loadLocal(LS_WRONG, []),   // [{ id, answeredAt }]
  favorites: loadLocal(LS_FAV, []), // [questionId]
  last: loadLocal(LS_LAST, null),   // { chapterId, sectionId, index, updatedAt }

  // 答题页
  view: 'home',
  current: null,                    // { chapterId, sectionId, questions:[...], index:0 }
  selections: new Set(),            // 当前题用户选中的字母
  submitted: false,                 // 当前题是否已提交

  // 错题/收藏模式下的临时题单
  tempList: null,                   // [{chapter, section, question}]
};

/* ----------------- 工具：本地存储 ----------------- */
function loadLocal(key, def) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return (typeof def === 'function') ? def() : JSON.parse(JSON.stringify(def));
    const val = JSON.parse(raw);
    return val;
  } catch {
    return (typeof def === 'function') ? def() : JSON.parse(JSON.stringify(def));
  }
}
function saveLocal(key, val) {
  try {
    if (val == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

/* ----------------- 工具：UI 辅助 ----------------- */
const _missingEls = new Set();
function el(id) {
  const e = document.getElementById(id);
  if (!e && !_missingEls.has(id)) {
    _missingEls.add(id);
    console.warn('[el] 找不到 DOM 元素：#' + id + '（已跳过，不会中断渲染）');
  }
  return e;
}
function setText(id, value) {
  const e = el(id);
  if (e) e.textContent = value == null ? '' : String(value);
}
function setHtml(id, html) {
  const e = el(id);
  if (e) e.innerHTML = html == null ? '' : String(html);
}
function setHidden(id, hidden) {
  const e = el(id);
  if (e) e.hidden = !!hidden;
}
function createEl(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function computeStats(listOfQs) {
  let done = 0, right = 0, wrong = 0;
  for (const f of listOfQs) {
    const rec = State.progress[f.question.id];
    if (rec && rec.my) {
      done++;
      if (rec.correct) right++; else wrong++;
    }
  }
  return { done, right, wrong, total: listOfQs.length, left: listOfQs.length - done };
}
function fmtPct(n, d) {
  if (d === 0) return '0%';
  return Math.round((n / d) * 100) + '%';
}

/* ----------------- 服务端数据同步 ----------------- */
let syncTimer = null;
let syncInFlight = false;
let pendingPush = false;
let serverVersion = 0;
let lastServerMergeSnapshot = 0;  // 最近一次从服务端 merge 回来的 version，用于判断是否需要重渲染

// ========= 实时同步：定时 pull + 变更即 push，跨设备自动一致 =========
let PULL_INTERVAL_MS = 5_000;   // 页面可见时：5 秒拉一次（手机/电脑互相同步的"实时感"）
let HIDDEN_PULL_MS    = 30_000; // 页面切后台后：30 秒拉一次（省电）
let pullLoopTimer = null;
let pullLoopRunning = false;
let lastAppliedServerProgressTs = 0; // 上次拉取后，progress 里最新 answeredAt（用来检测"是否真有新内容"）
const AUTO_RENDER_VIEWS = new Set(['home','wrong','favorite']); // 这些视图检测到有新进度就重渲染

async function pullLoopTick() {
  if (pullLoopRunning) return;
  pullLoopRunning = true;
  try { await pullFromServer({ applyRenderIfChanged: true }); }
  catch { /* ignore */ }
  finally { pullLoopRunning = false; schedulePullLoop(); }
}
function schedulePullLoop() {
  if (pullLoopTimer) { clearTimeout(pullLoopTimer); pullLoopTimer = null; }
  const hidden = typeof document !== 'undefined' && document.hidden;
  const delay = hidden ? HIDDEN_PULL_MS : PULL_INTERVAL_MS;
  pullLoopTimer = setTimeout(pullLoopTick, delay);
}

async function pullFromServer({ applyRenderIfChanged = false } = {}) {
  try {
    let data;
    // 优先：客户端直接连 Gist（0 后端，跨设备实时）
    if (window.RuanKaoSync?.isAvailable()) {
      const r = await window.RuanKaoSync.getSync({ forceReload: true });
      if (r.status !== 200) throw new Error((r.json?.error) || 'cloud sync HTTP ' + r.status);
      data = r.json;
    } else {
      // Fallback：老的后端 API（/api/sync，本地 node server 或 Vercel/Netlify Functions）
      const res = await fetch(API_SYNC, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    }

    // 记录 merge 前最新进度时间戳
    let beforeTs = 0;
    if (applyRenderIfChanged) {
      for (const rec of Object.values(State.progress || {})) {
        const t = rec?.answeredAt || 0;
        if (t > beforeTs) beforeTs = t;
      }
    }

    // progress：服务端 + 本地合并，按 answeredAt 取较新
    State.progress = mergeProgress(State.progress, data.progress || {});
    // last：按 updatedAt 较新
    if (data.last) {
      const lTs = State.last?.updatedAt || 0;
      const sTs = data.last.updatedAt || 0;
      if (sTs >= lTs) State.last = data.last;
    }
    // favorites：先合并再去重（两边 union）
    const favSet = new Set(Array.isArray(data.favorites) ? data.favorites : []);
    for (const id of (State.favorites || [])) favSet.add(id);
    State.favorites = [...favSet];
    State.wrong = rebuildWrongFromProgress(State.progress);

    // 本地兜底同步写入（即便之前有 localStorage 老版本，也保证与合并后一致）
    saveLocal(LS_KEY, State.progress);
    saveLocal(LS_WRONG, State.wrong);
    saveLocal(LS_FAV, State.favorites);
    saveLocal(LS_LAST, State.last);

    const changed = serverVersion !== (data.version || 0);
    serverVersion = data.version || Date.now();
    lastServerMergeSnapshot = serverVersion;

    if (applyRenderIfChanged && changed && AUTO_RENDER_VIEWS.has(State.view)) {
      // 如果 progress / favorites 真的变了 → 重渲染当前首页/错题/收藏，实现"其他设备做题本机立即看到"
      let afterTs = beforeTs;
      for (const rec of Object.values(State.progress || {})) {
        const t = rec?.answeredAt || 0;
        if (t > afterTs) afterTs = t;
      }
      const reallyDirty = (afterTs > beforeTs) || (lastAppliedServerProgressTs !== serverVersion);
      lastAppliedServerProgressTs = serverVersion;
      if (reallyDirty) {
        try {
          if (State.view === 'home') renderHome();
          else if (State.view === 'wrong') renderWrongList();
          else if (State.view === 'favorite') renderFavoriteList();
          updateContinueBtn?.();
        } catch (e) { console.warn('[sync] 后台刷新渲染失败：', e.message); }
      }
    }
  } catch (e) {
    // 拉取失败时不报错给用户，仅依赖 localStorage 兜底（未启用云端同步时也正常，只是 warn 一条）
    if (window.RuanKaoSync && !window.RuanKaoSync.hasConfigSaved()) {
      // 根本没配置，不算异常，静默处理
      void 0;
    } else {
      console.warn('[sync] 拉取云端/服务端数据失败，使用本地缓存：', e.message);
    }
  }
}

async function pushToServer() {
  pendingPush = true;
  if (syncInFlight) return;

  syncInFlight = true;
  try {
    while (pendingPush) {
      pendingPush = false;
      // 注意：云端进度以 answeredAt 时间戳为权威，所以
      //   上传完整 progress 集合 → （客户端直连时直接 merge）→ 写回 Gist → 客户端再 merge 回本地
      // favorites 传成 [id]
      const payload = {
        progress: State.progress,
        last: State.last,
        favorites: Array.isArray(State.favorites) ? State.favorites : [],
      };
      try {
        let data;
        if (window.RuanKaoSync?.isAvailable()) {
          const r = await window.RuanKaoSync.postSync(payload, { replaceSnapshot: false });
          if (r.status !== 200 || !r.json?.ok) throw new Error((r.json?.error) || ('cloud sync HTTP ' + (r.status || '?')));
          data = r.json;
        } else {
          const res = await fetch(API_SYNC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json();
        }
        if (data && data.ok) {
          // 合并后的版本是权威版本；再 merge 回本地（避免并发拉取导致偏差）
          if (data.progress) State.progress = mergeProgress(State.progress, data.progress);
          if (Array.isArray(data.favorites)) {
            const fset = new Set(data.favorites);
            for (const id of (State.favorites || [])) fset.add(id);
            State.favorites = [...fset];
          }
          if (data.last) {
            const a = (State.last?.updatedAt || 0);
            const b = data.last.updatedAt || 0;
            if (b >= a) State.last = data.last;
          }
          State.wrong = rebuildWrongFromProgress(State.progress);
          saveLocal(LS_KEY, State.progress);
          saveLocal(LS_WRONG, State.wrong);
          saveLocal(LS_FAV, State.favorites);
          saveLocal(LS_LAST, State.last);
          serverVersion = data.version || serverVersion;
        }
      } catch (e) {
        // 没配置云端同步（无后端 API 也无 Gist 直连）→ 静默跳过 push（已经存本地兜底）
        if (window.RuanKaoSync && !window.RuanKaoSync.hasConfigSaved()) {
          // 无需重试（因为本地已有 saveLocal 兜底）
          pendingPush = false;
          break;
        }
        console.warn('[sync] 推送失败（会重试）：', e.message);
        await new Promise(r => setTimeout(r, 2000));
        pendingPush = true;
      }
    }
  } finally {
    syncInFlight = false;
    if (pendingPush) pushToServer();
  }
}

function scheduleSync({ immediate = false } = {}) {
  // 先保存到本地（兜底）
  saveLocal(LS_KEY, State.progress);
  saveLocal(LS_LAST, State.last);
  saveLocal(LS_WRONG, State.wrong);
  saveLocal(LS_FAV, State.favorites);

  // 变更即异步推到服务端：immediate 立即推；否则短暂防抖（避免快速连点 10 题发 10 次）
  if (immediate) {
    clearTimeout(syncTimer); syncTimer = null;
    pushToServer();
    return;
  }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { pushToServer(); }, 150);
}

function startAutoSyncLoop() {
  // 页面可见性：tab 切回前台立刻拉一次，后台拉取间隔拉长
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // 切回前台 → 立即拉一次（拿到手机刚做的题），再重置循环
        pullFromServer({ applyRenderIfChanged: true }).finally(schedulePullLoop);
      } else {
        schedulePullLoop();
      }
    });
  }
  // 窗口重新 focus → 也立即拉一次
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', () => {
      pullFromServer({ applyRenderIfChanged: true });
    });
  }
  // 首次立刻拉一次，之后按间隔循环
  schedulePullLoop();
}

function mergeProgress(localProgress, serverProgress) {
  const merged = { ...(localProgress || {}) };
  for (const [qid, rec] of Object.entries(serverProgress || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const prev = merged[qid];
    if (!prev) { merged[qid] = rec; continue; }
    const tsPrev = prev.answeredAt || 0;
    const tsCur = rec.answeredAt || 0;
    if (tsCur >= tsPrev) merged[qid] = rec;
  }
  return merged;
}

function rebuildWrongFromProgress(progress) {
  const list = [];
  for (const [qid, rec] of Object.entries(progress || {})) {
    if (rec && rec.my && rec.correct === false) {
      list.push({ id: qid, answeredAt: rec.answeredAt || Date.now() });
    }
  }
  list.sort((a, b) => b.answeredAt - a.answeredAt);
  const seen = new Set();
  return list.filter(x => seen.has(x.id) ? false : (seen.add(x.id), true));
}

/* ----------------- 重置进度（通知云端 / 直连 Gist） ----------------- */
async function notifyReset(ids) {
  // 优先：客户端直接写 Gist（0 后端）
  let cloudOk = false;
  try {
    if (window.RuanKaoSync?.isAvailable()) {
      if (ids && Array.isArray(ids) && ids.length > 0) {
        await window.RuanKaoSync.patchRemoveIds(ids);
      } else {
        await window.RuanKaoSync.postReset({ forceAll: true });
      }
      cloudOk = true;
    }
  } catch (e) { console.warn('[reset] 云端直连写回失败：', e.message); }
  // Fallback：老的后端 API（/api/reset，本地 server/Vercel/Netlify Functions）
  if (!cloudOk) try {
    await fetch(API_RESET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(ids ? { ids } : {}),
    });
  } catch (e) { console.warn('[reset] 通知服务端失败：', e.message); }
}

/* ----------------- 数据加载 & 扁平化 ----------------- */
async function loadData() {
  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('加载题库失败：HTTP ' + res.status);
  const json = await res.json();
  State.data = json;
  flattenData(json);
  State.total = State.flatQuestions.length;
}

function flattenData(json) {
  const flat = [];
  for (const ch of json.chapters) {
    for (const sec of ch.sections) {
      if (!sec.questions || !sec.questions.length) continue;
      for (const q of sec.questions) {
        const item = { chapter: ch, section: sec, question: q };
        flat.push(item);
        State.idMap.set(q.id, item);
      }
    }
  }
  State.flatQuestions = flat;
}

/* ================= 首页：章节列表 ================= */
function renderHome() {
  // 顶部统计
  const { done, right, total, left } = computeStats(State.flatQuestions);
  setText('totalDone', done + ' / ' + total);
  setText('totalAcc', fmtPct(right, done || 1));
  setText('totalLeft', left);

  // 错题/收藏数量
  setText('wrongCount', State.wrong.length);
  setText('favCount', State.favorites.length);

  updateContinueBtn();

  const list = el('chapterList');
  if (!list) return;
  list.innerHTML = '';
  for (const ch of State.data.chapters) {
    const qs = State.flatQuestions.filter(f => f.chapter.id === ch.id);
    const { done, right, wrong, total, left } = computeStats(qs);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const item = createEl('div', 'chapter-item');
    item.innerHTML = `
      <div class="chapter-head">
        <span class="chapter-no">第${ch.index}章</span>
        <span class="chapter-count">${total} 题</span>
      </div>
      <div class="chapter-title">${escapeHtml(ch.title)}</div>
      <div class="chapter-bar-wrap">
        <div class="chapter-bar" style="width:${pct}%"></div>
      </div>
      <div class="chapter-meta">
        <span>完成 ${done} (${pct}%) <b>对${right}</b><span class="wrong">错${wrong}</span><span class="todo">剩${left}</span></span>
        <span>进入 ›</span>
      </div>
    `;
    item.addEventListener('click', () => enterChapter(ch.id));
    list.appendChild(item);
  }
}

function updateContinueBtn() {
  const btn = el('continueBtn');
  if (!btn) return;
  btn.hidden = !State.last;
}

/* ================= 进入章节/小节 ================= */
function enterChapter(chapterId) {
  const ch = State.data.chapters.find(c => c.id === chapterId);
  const nonEmpty = ch.sections.filter(s => s.questions && s.questions.length);
  if (nonEmpty.length === 0) return;

  if (nonEmpty.length === 1) {
    enterSection(chapterId, nonEmpty[0].id);
    return;
  }
  showSectionPicker(ch, nonEmpty);
}

function showSectionPicker(ch, sections) {
  const mask = createEl('div', 'sheet-mask');
  mask.style.zIndex = 45;
  const sheet = createEl('div', 'sheet');
  sheet.style.zIndex = 46;

  const header = createEl('div', 'sheet-header');
  header.innerHTML = `<div class="sheet-title">${escapeHtml('第' + ch.index + '章 · ' + ch.title)}</div>`;
  const closeBtn = createEl('button', 'icon-btn');
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>`;
  const close = () => { document.body.removeChild(mask); document.body.removeChild(sheet); };
  closeBtn.addEventListener('click', close);
  mask.addEventListener('click', close);
  header.appendChild(closeBtn);

  const summary = createEl('div', 'sheet-summary');
  const total = sections.reduce((n, s) => n + s.questions.length, 0);
  summary.innerHTML = `<span>共 <b>${sections.length}</b> 节 · <b>${total}</b> 题</span>`;

  const grid = createEl('div', 'chapter-list');
  grid.style.padding = '6px 14px 20px';
  for (const sec of sections) {
    const qsInSec = State.flatQuestions.filter(f => f.section.id === sec.id);
    const { done, right, wrong, total } = computeStats(qsInSec);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const it = createEl('div', 'chapter-item');
    it.innerHTML = `
      <div class="chapter-head">
        <span class="chapter-no">${sec.number}</span>
        <span class="chapter-count">${sec.questions.length}题</span>
      </div>
      <div class="chapter-title">${escapeHtml(sec.title)}</div>
      <div class="chapter-bar-wrap">
        <div class="chapter-bar" style="width:${pct}%"></div>
      </div>
      <div class="chapter-meta">
        <span>完成 ${done} · <b>对${right}</b><span class="wrong">错${wrong}</span></span>
        <span>进入 ›</span>
      </div>
    `;
    it.addEventListener('click', () => { close(); enterSection(ch.id, sec.id); });
    grid.appendChild(it);
  }

  sheet.appendChild(header);
  sheet.appendChild(summary);
  sheet.appendChild(grid);
  document.body.appendChild(mask);
  document.body.appendChild(sheet);
}

function enterSection(chapterId, sectionId) {
  const inSection = State.flatQuestions.filter(
    f => f.chapter.id === chapterId && f.section.id === sectionId
  );
  if (!inSection.length) return;
  startQuiz(inSection, { chapterId, sectionId });
}

function startQuiz(questionList, ctx) {
  State.current = {
    chapterId: ctx?.chapterId ?? null,
    sectionId: ctx?.sectionId ?? null,
    questions: questionList,
    index: 0,
  };

  // 跳到上次未答的位置
  const last = State.last;
  let targetIndex = 0;
  if (last && ctx && last.sectionId === ctx.sectionId && last.index != null) {
    const i = Math.min(Math.max(0, last.index), questionList.length - 1);
    const rec = State.progress[questionList[i].question.id];
    if (!rec || !rec.my) targetIndex = i;
    else {
      const firstUndone = questionList.findIndex(f => !State.progress[f.question.id]?.my);
      if (firstUndone >= 0) targetIndex = firstUndone;
    }
  } else {
    const firstUndone = questionList.findIndex(f => !State.progress[f.question.id]?.my);
    if (firstUndone >= 0) targetIndex = firstUndone;
  }
  State.current.index = targetIndex;

  State.view = 'quiz';
  switchView('quiz', ctx);
  renderQuiz();
  saveLast({
    chapterId: State.current.chapterId,
    sectionId: State.current.sectionId,
    index: State.current.index,
  });
}

/* ================= 视图切换 ================= */
function switchView(name, ctx) {
  State.view = name;
  setHidden('homeView', name !== 'home');
  setHidden('quizView', name !== 'quiz');
  setHidden('wrongView', name !== 'wrong');
  setHidden('favoriteView', name !== 'favorite');
  setHidden('backBtn', name === 'home');
  setHidden('bottomBar', name !== 'quiz');
  // 收藏按钮：答题页才显示
  const favBtn = el('favBtn');
  if (favBtn) favBtn.style.display = (name === 'quiz') ? 'inline-flex' : 'none';

  if (name === 'home') {
    setText('pageTitle', '系规分章节题库');
    setText('pageSubtitle', '系统规划与管理师 · 2026有解析版');
    renderHome();
  } else if (name === 'wrong') {
    setText('pageTitle', '错题本');
    setText('pageSubtitle', `共 ${State.wrong.length} 道错题`);
    renderWrongList();
  } else if (name === 'favorite') {
    setText('pageTitle', '收藏夹');
    setText('pageSubtitle', `共 ${State.favorites.length} 道收藏`);
    renderFavoriteList();
  } else {
    const ch = State.data.chapters.find(c => c.id === State.current.chapterId);
    if (ch) {
      const sec = ch.sections.find(s => s.id === State.current.sectionId);
      if (sec) {
        setText('pageTitle', `第${ch.index}章 · ${sec.number}`);
        setText('pageSubtitle', sec.title);
      }
    }
    if (!ctx) {
      setText('pageTitle', '练习模式');
      setText('pageSubtitle', `共 ${State.current.questions.length} 题`);
    }
  }
}

/* ================= 答题页渲染 ================= */
function renderQuiz() {
  if (!State.current) return;
  const qlist = State.current.questions;
  const i = State.current.index;
  const f = qlist[i];
  if (!f) return;
  const q = f.question;

  // 进度
  const pct = ((i + 1) / qlist.length) * 100;
  const bar = el('quizProgressBar'); if (bar) bar.style.width = pct + '%';
  setText('quizIndex', `${i + 1} / ${qlist.length}`);

  // 节内正确率
  const { done, right } = computeStats(qlist);
  setText('quizRate', done > 0 ? `正确率 ${fmtPct(right, done)}` : '正确率 —');

  // 标签
  setText('qSource', q.source || '自编题');
  setText('qIndexTag', '#' + q.localIndex);
  const ansLen = (q.answer || '').length;
  const isMulti = ansLen > 1;
  setText('qTypeTag', isMulti ? '多选' : '单选');

  // 收藏状态
  updateFavBtn(q.id);

  // 题干
  setHtml('qStem', highlightNumbers(escapeHtml(q.stem || '（无题干）')));

  // 之前是否有记录
  const record = State.progress[q.id];
  State.submitted = !!(record && record.my);

  // 当前选择
  State.selections = new Set();
  if (State.submitted) {
    State.selections = new Set((record.my || '').split(''));
  }

  renderOptions(q, isMulti);
  renderResult(q);
  updateBottomBar(isMulti);

  saveLast({
    chapterId: State.current.chapterId,
    sectionId: State.current.sectionId,
    index: State.current.index,
  });

  try { window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' }); } catch (_) {}
}

function updateFavBtn(qid) {
  const btn = el('favBtn');
  if (!btn) return;
  const faved = State.favorites.includes(qid);
  btn.dataset.faved = faved ? '1' : '0';
  btn.innerHTML = faved
    ? `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="#e6a23c" d="M12 17.3l-6.2 3.7 1.6-7L2 9.2l7.2-.6L12 2l2.8 6.6 7.2.6-5.4 4.8 1.6 7z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M22 9.8l-7.2-.6L12 2 9.2 8.6 2 9.2l5.4 4.7L5.8 21 12 17.3 18.2 21l-1.6-7.1L22 9.8zM12 15.2l-3.8 2.3 1-4.4-3.4-3 4.4-.4L12 6l1.8 3.7 4.4.4-3.4 3 1 4.4z"/></svg>`;
}

function highlightNumbers(html) {
  return html;
}

function renderOptions(q, isMulti) {
  const wrap = el('qOptions');
  if (!wrap) return;
  wrap.innerHTML = '';

  const record = State.progress[q.id];
  const correctSet = new Set((q.answer || '').split(''));
  const mySet = State.submitted && record
    ? new Set((record.my || '').split(''))
    : State.selections;

  for (const opt of q.options) {
    const div = createEl('div', 'option');
    div.dataset.letter = opt.letter;

    let cls = '';
    if (mySet.has(opt.letter)) cls += ' selected';
    if (State.submitted) {
      cls += ' disabled';
      if (correctSet.has(opt.letter)) cls += ' correct';
      else if (mySet.has(opt.letter)) cls += ' wrong';
    }
    if (cls) div.className += cls;

    div.innerHTML = `
      <div class="opt-letter">${opt.letter}</div>
      <div class="opt-text">${escapeHtml(opt.text)}</div>
    `;

    if (!State.submitted) {
      div.addEventListener('click', () => onOptionClick(opt.letter, isMulti));
    }
    wrap.appendChild(div);
  }

  if (!q.options.length) {
    const hint = createEl('div', 'empty-analysis');
    hint.textContent = '⚠️ 本题选项数据暂时缺失。';
    wrap.appendChild(hint);
  }
}

function onOptionClick(letter, isMulti) {
  if (State.submitted) return;
  if (isMulti) {
    if (State.selections.has(letter)) State.selections.delete(letter);
    else State.selections.add(letter);
  } else {
    State.selections = new Set([letter]);
  }
  [...el('qOptions').children].forEach(child => {
    const lt = child.dataset.letter;
    child.classList.toggle('selected', State.selections.has(lt));
  });
  updateBottomBar(isMulti);
}

function renderResult(q) {
  const card = el('resultCard');
  if (!card) return;
  if (!State.submitted) { card.hidden = true; return; }
  card.hidden = false;

  const record = State.progress[q.id];
  const myAns = (record?.my || '').split('').sort().join('') || '—';
  const riAns = (q.answer || '').split('').sort().join('') || '（缺失）';
  const isRight = record?.correct;

  const header = el('resultHeader');
  if (header) {
    header.className = 'result-header ' + (isRight ? 'right' : 'wrong');
    header.textContent = isRight ? '✅ 回答正确' : '❌ 回答错误';
  }

  setText('myAnswer', myAns.split('').join(' ') || '未作答');
  setText('rightAnswer', riAns.split('').join(' '));

  const block = el('analysisBlock');
  const txt = el('analysisText');
  if (block && txt) {
    if (q.analysis) {
      block.hidden = false;
      txt.innerHTML = highlightNumbers(escapeHtml(q.analysis));
    } else {
      block.hidden = true;
    }
  }
}

function updateBottomBar(isMulti) {
  if (!State.current) return;
  const total = State.current.questions.length;
  const i = State.current.index;
  const submitBtn = el('submitBtn');

  const prev = el('prevBtn'); if (prev) prev.disabled = i <= 0;
  const next = el('nextBtn'); if (next) next.disabled = i >= total - 1;

  if (!submitBtn) return;
  if (State.submitted) {
    submitBtn.textContent = '✓ 已作答';
    submitBtn.classList.add('done');
    submitBtn.disabled = true;
  } else {
    const hint = State.selections.size === 0
      ? '请先选择答案'
      : (isMulti ? `提交（已选${State.selections.size}项）` : '提交答案');
    submitBtn.textContent = hint;
    submitBtn.classList.remove('done');
    submitBtn.disabled = State.selections.size === 0;
  }
}

/* ================= 提交 & 导航 ================= */
function submitCurrent() {
  if (State.submitted) return;
  if (State.selections.size === 0) return;

  const f = State.current.questions[State.current.index];
  const q = f.question;
  const my = [...State.selections].sort().join('');
  const correctAns = (q.answer || '').split('').sort().join('');
  const correct = !!correctAns && my === correctAns;

  State.progress[q.id] = { my, correct, answeredAt: Date.now() };

  // 实时刷新错题列表
  State.wrong = rebuildWrongFromProgress(State.progress);

  saveProgressOnly();
  State.submitted = true;

  renderOptions(q, correctAns.length > 1);
  renderResult(q);
  updateBottomBar(correctAns.length > 1);
}

function goPrev() {
  if (State.current.index <= 0) return;
  State.current.index--;
  renderQuiz();
}
function goNext() {
  if (State.current.index >= State.current.questions.length - 1) return;
  State.current.index++;
  renderQuiz();
}

/* ================= 答题卡 ================= */
function openSheet() {
  if (!State.current) return;
  const qlist = State.current.questions;

  setText('sheetTitle', `答题卡 · ${qlist.length}题`);
  const { done, right, wrong, left } = computeStats(qlist);
  const i = State.current.index;

  const summary = el('sheetSummary');
  if (summary) summary.innerHTML = `
    <span class="ss-un"><i></i>未答 ${left}</span>
    <span class="ss-cur"><i></i>当前</span>
    <span class="ss-right"><i></i>正确 ${right}</span>
    <span class="ss-wrong"><i></i>错误 ${wrong}</span>
  `;

  const grid = el('sheetGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (let k = 0; k < qlist.length; k++) {
    const id = qlist[k].question.id;
    const rec = State.progress[id];
    let c = 'cell';
    if (k === i) c += ' cur';
    if (rec?.my) {
      c += rec.correct ? ' right' : ' wrong';
    }
    const cell = createEl('div', c, String(k + 1));
    cell.addEventListener('click', () => {
      State.current.index = k;
      closeSheet();
      renderQuiz();
    });
    grid.appendChild(cell);
  }

  setHidden('sheetMask', false);
  setHidden('sheet', false);
}
function closeSheet() {
  setHidden('sheetMask', true);
  setHidden('sheet', true);
}

/* ================= 错题本视图 ================= */
function renderWrongList() {
  const list = el('wrongList');
  if (!list) return;
  list.innerHTML = '';
  if (!State.wrong.length) {
    list.innerHTML = `<div class="empty-tip">暂无错题，太棒了 🎉</div>`;
    return;
  }
  for (const w of State.wrong) {
    const f = State.idMap.get(w.id);
    if (!f) continue;
    const q = f.question;
    const it = createEl('div', 'list-item');
    it.innerHTML = `
      <div class="li-head">
        <span class="li-ch">${escapeHtml(f.chapter.title)} · ${escapeHtml(f.section.title)}</span>
        <span class="li-type">${(q.answer?.length > 1) ? '多选' : '单选'}</span>
      </div>
      <div class="li-stem">${escapeHtml(q.stem || '').slice(0, 120)}${(q.stem || '').length > 120 ? '…' : ''}</div>
      <div class="li-meta">
        <span class="wrong-badge">错</span>
        <span class="li-ans">你的答案：<b>${(State.progress[q.id]?.my || '').split('').join(' ') || '—'}</b></span>
        <span class="li-ans">正确答案：<b style="color:#2ea062">${(q.answer || '').split('').join(' ')}</b></span>
      </div>
    `;
    it.addEventListener('click', () => startQuizFromList('wrong', w.id));
    list.appendChild(it);
  }
}

/* ================= 收藏视图 ================= */
function renderFavoriteList() {
  const list = el('favList');
  if (!list) return;
  list.innerHTML = '';
  if (!State.favorites.length) {
    list.innerHTML = `<div class="empty-tip">暂无收藏的题目</div>`;
    return;
  }
  for (const qid of State.favorites) {
    const f = State.idMap.get(qid);
    if (!f) continue;
    const q = f.question;
    const rec = State.progress[qid];
    const ans = rec?.my ? `${rec.my.split('').join(' ')}` : '未作答';
    const correct = rec ? (rec.correct ? '对' : '错') : '';
    const it = createEl('div', 'list-item');
    it.innerHTML = `
      <div class="li-head">
        <span class="li-ch">${escapeHtml(f.chapter.title)} · ${escapeHtml(f.section.title)}</span>
        <span class="li-type">${(q.answer?.length > 1) ? '多选' : '单选'}</span>
      </div>
      <div class="li-stem">${escapeHtml(q.stem || '').slice(0, 120)}${(q.stem || '').length > 120 ? '…' : ''}</div>
      <div class="li-meta">
        ${rec ? `<span class="${rec.correct ? 'right-badge' : 'wrong-badge'}">${correct}</span>` : ''}
        <span class="li-ans">答：<b>${ans}</b></span>
      </div>
      <button class="unfav-btn" title="取消收藏">✕</button>
    `;
    it.addEventListener('click', (e) => {
      if (e.target.classList.contains('unfav-btn')) {
        e.stopPropagation();
        toggleFavorite(qid, true);
        renderFavoriteList();
        return;
      }
      startQuizFromList('favorite', qid);
    });
    list.appendChild(it);
  }
}

function startQuizFromList(mode, startQid) {
  let qlist = [];
  if (mode === 'wrong') {
    qlist = State.wrong.map(w => State.idMap.get(w.id)).filter(Boolean);
  } else if (mode === 'favorite') {
    qlist = State.favorites.map(id => State.idMap.get(id)).filter(Boolean);
  }
  if (!qlist.length) return;
  const startIdx = Math.max(0, qlist.findIndex(f => f.question.id === startQid));
  State.tempList = qlist;
  State.current = {
    chapterId: null,
    sectionId: null,
    questions: qlist,
    index: startIdx,
  };
  State.view = 'quiz';
  switchView('quiz', null);
  renderQuiz();
}

/* ================= 收藏切换 ================= */
function toggleFavorite(qid, silent) {
  const idx = State.favorites.indexOf(qid);
  if (idx >= 0) State.favorites.splice(idx, 1);
  else State.favorites.push(qid);
  if (!silent) updateFavBtn(qid);
  scheduleSync();
}

/* ================= 重置进度 ================= */
function resetCurrent() {
  if (!State.current) return;
  const ok = confirm('重置本节（' + State.current.questions.length + ' 题）的所有答题记录？');
  if (!ok) return;
  const ids = State.current.questions.map(f => f.question.id);
  for (const id of ids) delete State.progress[id];
  State.wrong = rebuildWrongFromProgress(State.progress);
  saveProgressOnly();
  notifyReset(ids);
  renderQuiz();
}

async function resetAll() {
  const ok = confirm('重置整本题库（2500+题）的所有答题进度、错题和收藏？此操作不可撤销。');
  if (!ok) return;
  State.progress = {};
  State.wrong = [];
  State.favorites = [];
  saveProgressOnly();
  saveLast(null);
  await notifyReset(null);
  if (State.current) renderQuiz(); else renderHome();
}

/* ================= 进度导出 / 导入（跨设备同步） ================= */
function buildBackup() {
  // 精简：progress 字段里 answeredAt 毫秒数用 delta 节省体积（可选），这里直接全量即可
  const done = Object.keys(State.progress).length;
  let right = 0;
  for (const r of Object.values(State.progress)) if (r && r.correct) right++;
  return {
    app: 'ruankao-quiz',
    version: 1,
    exportedAt: Date.now(),
    total: State.total,
    done,
    right,
    wrong: State.wrong.length,
    favorites: State.favorites.length,
    payload: {
      progress: State.progress,
      favorites: State.favorites,
      last: State.last,
    }
  };
}

function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return '不是有效的备份文件';
  if (obj.app !== 'ruankao-quiz') return '文件不是本应用的进度备份';
  if (obj.version !== 1) return '备份版本不兼容，请用当前版本重新导出';
  if (!obj.payload || typeof obj.payload !== 'object') return '备份缺少 payload';
  return null;
}

function exportProgressToFile() {
  const backup = buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 0)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const name = `系规刷题进度_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  try { a.click(); } catch (e) { console.warn(e); }
  setTimeout(() => {
    try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch {}
  }, 2000);
  alert(`✅ 已生成备份：${name}\n\n请把这个文件发给另一台设备（微信「文件传输助手」即可），在另一台设备的题库首页点「📥导入进度」即可合并同步。`);
}

function importProgressFromFile(onDone) {
  // 复用 input file，避免重复创建
  let input = document.getElementById('__importProgressInput__');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.id = '__importProgressInput__';
    input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.onchange = async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const err = validateBackup(obj);
      if (err) { alert('❌ ' + err); return; }
      applyBackup(obj.payload, file.name);
      if (typeof onDone === 'function') onDone(obj.payload);
    } catch (e) {
      console.error(e);
      alert('❌ 导入失败：文件内容不是合法的 JSON。请确认导入的是本应用生成的「系规刷题进度_xxx.json」。');
    }
  };
  input.click();
}

function applyBackup(payload, fileName) {
  const { progress = {}, favorites = [], last = null } = payload || {};
  const existingDone = Object.keys(State.progress).length;
  const incomingDone = Object.keys(progress).length;

  // 策略：mergeProgress（同一题时间戳较新的覆盖） + 收藏合并去重
  State.progress = mergeProgress(State.progress, progress);
  const favSet = new Set(State.favorites);
  for (const id of (favorites || [])) favSet.add(id);
  State.favorites = Array.from(favSet);
  // last：如果新导入的更新就用它
  if (last && (!State.last || ((last.updatedAt || 0) >= (State.last.updatedAt || 0)))) {
    State.last = last;
  }
  State.wrong = rebuildWrongFromProgress(State.progress);
  saveProgressOnly();
  saveLast(State.last);

  const newDone = Object.keys(State.progress).length - existingDone;
  const newFav  = State.favorites.length;
  const summary =
    `📥 导入成功\n\n` +
    `导入文件：${fileName || ''}\n` +
    `· 导入答题记录：${incomingDone} 条\n` +
    `· 合并后新增记录：${newDone} 条（时间戳更新的会覆盖旧记录）\n` +
    `· 当前收藏题数：${newFav} 道\n` +
    `· 当前错题数：${State.wrong.length} 道\n\n` +
    `✅ 进度已写入本设备本地存储。如果连了服务端，会自动同步到云端。`;
  alert(summary);
  renderHome();
}

/* ================= save 辅助 ================= */
function saveProgressOnly() {
  saveLocal(LS_KEY, State.progress);
  saveLocal(LS_WRONG, State.wrong);
  saveLocal(LS_FAV, State.favorites);
  scheduleSync();
}
function saveLast(obj) {
  if (obj) obj.updatedAt = Date.now();
  State.last = obj;
  saveLocal(LS_LAST, obj);
  updateContinueBtn();
  // last 也同步到服务端（允许稍慢）
  scheduleSync();
}
/* ================= 事件绑定 ================= */
function bindEvents() {
  el('backBtn').addEventListener('click', () => {
    State.current = null;
    switchView('home');
  });
  el('submitBtn').addEventListener('click', submitCurrent);
  el('prevBtn').addEventListener('click', goPrev);
  el('nextBtn').addEventListener('click', goNext);
  el('cardBtn').addEventListener('click', openSheet);
  el('closeSheet').addEventListener('click', closeSheet);
  el('sheetMask').addEventListener('click', closeSheet);
  el('continueBtn').addEventListener('click', () => {
    if (!State.last) return;
    const ch = State.data.chapters.find(c => c.id === State.last.chapterId);
    if (!ch) { saveLast(null); return; }
    if (!ch.sections.find(s => s.id === State.last.sectionId)) { saveLast(null); return; }
    enterSection(State.last.chapterId, State.last.sectionId);
  });

  // 错题本入口
  el('wrongBtn')?.addEventListener('click', () => switchView('wrong'));
  // 收藏夹入口
  el('favBtnBar')?.addEventListener('click', () => switchView('favorite'));
  // 导出 / 导入进度
  el('exportBtn')?.addEventListener('click', exportProgressToFile);
  el('importBtn')?.addEventListener('click', () => importProgressFromFile());
  // 答题页收藏按钮
  el('favBtn')?.addEventListener('click', () => {
    if (!State.current) return;
    const qid = State.current.questions[State.current.index].question.id;
    toggleFavorite(qid);
  });

  // 错题本里的「练习错题」按钮
  el('wrongPracticeBtn')?.addEventListener('click', () => {
    if (!State.wrong.length) return;
    startQuizFromList('wrong', State.wrong[0].id);
  });
  // 错题本清空
  el('wrongClearBtn')?.addEventListener('click', () => {
    if (!State.wrong.length) return;
    // 二次确认（无 confirm 弹窗，适配移动端）
    const btn = el('wrongClearBtn');
    if (btn.dataset.confirming === '1') {
      const ids = State.wrong.map(w => w.id);
      for (const id of ids) delete State.progress[id];
      State.wrong = [];
      saveProgressOnly();
      notifyReset(ids);
      renderWrongList();
      btn.dataset.confirming = '0';
      btn.textContent = '清空错题本';
    } else {
      btn.dataset.confirming = '1';
      btn.textContent = '再次点击确认清空';
      setTimeout(() => { btn.dataset.confirming = '0'; btn.textContent = '清空错题本'; }, 3000);
    }
  });

  // 重置按钮（答题页：单击重置当前节 / 首页：双击重置全部）
  let resetTimer = null;
  el('resetBtn').addEventListener('click', () => {
    if (State.current) {
      resetCurrent();
    } else if (State.view === 'home') {
      if (resetTimer) {
        clearTimeout(resetTimer); resetTimer = null;
        resetAll();
      } else {
        resetTimer = setTimeout(() => {
          alert('请再次点击该按钮以确认清空全部进度');
          resetTimer = null;
        }, 350);
      }
    }
  });

  // 云端同步设置按钮（⚙️ 右上角齿轮）
  el('settingsBtn')?.addEventListener('click', () => {
    if (window.RuanKaoSync) window.RuanKaoSync.openSettingsModal();
    else alert('☁️ 云端同步模块加载失败，请刷新页面（或检查 gist-client.js 是否加载）。');
  });

  // 键盘快捷键（桌面可选）
  window.addEventListener('keydown', (e) => {
    if (State.current) {
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'Enter') { if (!State.submitted) submitCurrent(); else goNext(); }
      else if (/^[A-Fa-f]$/.test(e.key)) {
        if (State.submitted) return;
        const f = State.current.questions[State.current.index];
        const isMulti = (f.question.answer || '').length > 1;
        onOptionClick(e.key.toUpperCase(), isMulti);
        updateBottomBar(isMulti);
      }
    }
  });
}

/* ================= 启动 ================= */
async function main() {
  const loader = el('loader');
  try {
    if (loader) loader.hidden = false;
    // 1) 先尝试从服务端拉用户数据（localStorage 作为兜底）
    await pullFromServer();
    // 2) 加载题库
    await loadData();
    // 3) 绑定事件 & 渲染
    bindEvents();
    renderHome();
    // 4) 启动实时自动同步循环：答题/收藏后立即推；每 5s 拉取其他设备的改动
    startAutoSyncLoop();
  } catch (e) {
    console.error(e);
    const host = location?.host || '';
    const byFile = /^file:|^[a-zA-Z]:/.test(location?.href || '');
    if (loader) {
      loader.innerHTML = `
        <div style="color:#d9656f;font-weight:600">⚠️ 应用启动失败</div>
        <div style="max-width:420px;text-align:center;line-height:1.8;color:#4a5a7a;font-size:14px">
          ${byFile
            ? `<b>不要用 file:// 直接打开 HTML</b>，否则题库加载会被浏览器安全策略拦截。<br/>请在项目根目录运行：<br/><code style="background:#eef3ff;padding:2px 8px;border-radius:6px">npm run dev</code>`
            : `错误原因：<code style="font-size:12px;color:#d9656f">${escapeHtml(e.message || String(e))}</code><br/><br/>
               请访问 <b>http://${host || 'localhost:8080'}/</b>，或在项目根启动服务：<br/><code style="background:#eef3ff;padding:2px 8px;border-radius:6px">npm run dev</code>`
          }
        </div>
      `;
    }
    return;
  } finally {
    if (loader) loader.hidden = true;
  }
}

// 仅在 document 已就绪时启动
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
}
