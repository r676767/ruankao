/* =============================================================
 *  gist-client.js（插入在 app.js 之前加载）
 *  功能：0 后端服务器，客户端浏览器直接读写 GitHub Gist 实现跨设备实时同步
 *  对外暴露 window.RuanKaoSync，包含：
 *    - isAvailable()  → 是否有合法配置（GH_TOKEN + GIST_ID）
 *    - getSync() / postSync(patch, opts) / postReset(opts)  → 替代旧的 /api 接口
 *    - openSettingsModal() / closeSettingsModal() / testConnection() → UI 操作
 *  存储：
 *    - 配置（Token/GistID）存在 localStorage：ruankao.cloud.cfg.v1
 *    - 云端进度：存在 GitHub Gist 的 files.userdata.json（和后端方案完全同一个 Gist，可平滑切换）
 * ============================================================= */
(function () {
  const LS_CFG = 'ruankao.cloud.cfg.v1';
  const USERDATA_FILENAME = 'userdata.json';
  const GIST_API = 'https://api.github.com';
  const GIST_API_VERSION = '2022-11-28';
  const ACCEPT_VND = 'application/vnd.github+json';
  const UA = 'ruankao-quiz/1.0 (+https://github.com/r676767/ruankao)';

  /* ---------------- 1. userdata-core 纯函数（无依赖） ---------------- */
  function emptyUserData() {
    return { progress: {}, wrong: [], favorites: [], last: null, version: Date.now() };
  }
  function cloneUserData(u) {
    if (!u) return emptyUserData();
    return {
      progress: u.progress ? { ...u.progress } : {},
      wrong: Array.isArray(u.wrong) ? u.wrong.map(w => ({ ...w })) : [],
      favorites: Array.isArray(u.favorites) ? u.favorites.slice() : [],
      last: u.last ? { ...u.last } : null,
      version: typeof u.version === 'number' ? u.version : Date.now(),
    };
  }
  function rebuildWrongFromProgress(progress) {
    const list = [];
    for (const [qid, rec] of Object.entries(progress || {})) {
      if (rec && rec.my && rec.correct === false) list.push({ id: qid, answeredAt: rec.answeredAt || Date.now() });
    }
    list.sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
    const seen = new Set();
    return list.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  }
  function mergeProgress(localProgress, serverProgress) {
    const merged = { ...(localProgress || {}) };
    for (const [qid, rec] of Object.entries(serverProgress || {})) {
      if (!rec || typeof rec !== 'object') continue;
      const prev = merged[qid];
      if (!prev) { merged[qid] = { ...rec }; continue; }
      const tsPrev = prev.answeredAt || 0, tsCur = rec.answeredAt || 0;
      if (tsCur >= tsPrev) merged[qid] = { ...rec };
    }
    return merged;
  }
  function applySyncPatch(currentUserData, patch, { enforceExactSnapshot = false } = {}) {
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
  function resetSectionAll(currentUserData) {
    const cur = cloneUserData(currentUserData);
    cur.progress = {};
    cur.favorites = [];
    cur.last = null;
    cur.wrong = [];
    cur.version = Date.now();
    return cur;
  }

  /* ---------------- 2. Gist 客户端（直接 fetch GitHub API） ---------------- */
  function ghHeaders(token) {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': ACCEPT_VND,
      'X-GitHub-Api-Version': GIST_API_VERSION,
      'User-Agent': UA,
      'Content-Type': 'application/json',
    };
  }
  function safeJSONParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }
  class GistClient {
    constructor({ ghToken, gistId }) {
      this.token = ghToken;
      this.gistId = gistId;
      if (!ghToken) throw new Error('缺少 GitHub Token（settings 里需填写 GH_TOKEN）');
      if (!gistId) throw new Error('缺少 GIST_ID（请先创建一个 Gist，或使用已生成的）');
    }
    async load() {
      const res = await fetch(`${GIST_API}/gists/${this.gistId}`, {
        headers: ghHeaders(this.token),
        cache: 'no-store',
      });
      if (!res.ok) {
        if (res.status === 404) return emptyUserData();
        if (res.status === 401) throw new Error('GitHub Token 无效或已过期（请重新生成并填入）');
        if (res.status === 403) throw new Error('GitHub API 限流或无权限（请确认 Token 有 gist scope）');
        throw new Error(`读取 Gist 失败：HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      const file = data.files && data.files[USERDATA_FILENAME];
      if (!file || !file.content) return emptyUserData();
      const obj = safeJSONParse(file.content);
      if (!obj || typeof obj !== 'object') return emptyUserData();
      return cloneUserData(obj);
    }
    async save(userdata) {
      // 去掉冗余 wrong（后端始终从 progress 重建，避免写入冗余）
      const { wrong, ...payload } = cloneUserData(userdata);
      void wrong;
      const body = {
        description: 'ruankao quiz userdata (client-side synced)',
        files: { [USERDATA_FILENAME]: { content: JSON.stringify(payload, null, 2) } },
      };
      const res = await fetch(`${GIST_API}/gists/${this.gistId}`, {
        method: 'PATCH',
        headers: ghHeaders(this.token),
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('GitHub Token 无效（请检查）');
        if (res.status === 403) throw new Error('GitHub API 限流 / 无写权限');
        if (res.status === 404) throw new Error('Gist 不存在（GIST_ID 填错？）');
        throw new Error(`写入 Gist 失败：HTTP ${res.status} ${res.statusText}`);
      }
      return true;
    }
    async describe() {
      return `Gist: https://gist.github.com/${this.gistId} (file: ${USERDATA_FILENAME})`;
    }
  }

  /* ---------------- 3. 配置存储 + 单例 ---------------- */
  let _clientCache = null;
  let _clientCacheKey = '';
  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_CFG);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.ghToken === 'string' && typeof obj.gistId === 'string') {
        if (obj.ghToken.length > 0 && obj.gistId.length > 0) return obj;
      }
      return null;
    } catch { return null; }
  }
  function saveCfg({ ghToken, gistId }) {
    localStorage.setItem(LS_CFG, JSON.stringify({ ghToken: String(ghToken || ''), gistId: String(gistId || '') }));
    _clientCache = null; _clientCacheKey = '';
  }
  function clearCfg() {
    localStorage.removeItem(LS_CFG);
    _clientCache = null; _clientCacheKey = '';
  }
  function getClient() {
    const cfg = loadCfg();
    if (!cfg) return null;
    const k = cfg.ghToken + '||' + cfg.gistId;
    if (_clientCache && _clientCacheKey === k) return _clientCache;
    try {
      const c = new GistClient({ ghToken: cfg.ghToken, gistId: cfg.gistId });
      _clientCache = c; _clientCacheKey = k;
      return c;
    } catch { return null; }
  }

  /* ---------------- 4. 对外 sync 接口（直接返回与后端 /api 同结构） ---------------- */
  async function apiGetSync({ forceReload = true } = {}) {
    const c = getClient();
    if (!c) throw new Error('[cloud] 未配置云端同步（请点右上角 ⚙️ 填写 GIST_ID 和 GitHub Token）');
    void forceReload; // 每次请求都 fetch 直连，确保跨设备实时
    const u = await c.load();
    const wrong = rebuildWrongFromProgress(u.progress);
    return { status: 200, json: { progress: u.progress, wrong, favorites: u.favorites, last: u.last, version: u.version } };
  }
  async function apiPostSync(patch, { replaceSnapshot = false } = {}) {
    const c = getClient();
    if (!c) throw new Error('[cloud] 未配置云端同步');
    if (!patch || typeof patch !== 'object') return { status: 400, json: { ok: false, error: 'body 必须是 JSON' } };
    const base = await c.load();
    const next = applySyncPatch(base, patch, { enforceExactSnapshot: replaceSnapshot });
    await c.save(next);
    const wrong = rebuildWrongFromProgress(next.progress);
    return {
      status: 200,
      json: { ok: true, progress: next.progress, wrong, favorites: next.favorites, last: next.last, version: next.version },
    };
  }
  async function apiPostReset({ chapterId = null, sectionId = null, forceAll = false } = {}) {
    const c = getClient();
    if (!c) throw new Error('[cloud] 未配置云端同步');
    const base = await c.load();
    // 无后端模式下：只支持全局重置（chapterId=sectionId=null 或 forceAll=true）
    // 按章节/节重置由前端自己修改 progress（见 notifyReset 前端 apply ids patch）
    if ((chapterId || sectionId) && !forceAll) {
      return { status: 400, json: { ok: false, error: '无后端模式下不支持服务器端按章节重置（请在答题页内按重置按钮，前端直接修改本地后写回 Gist）' } };
    }
    const next = resetSectionAll(base);
    await c.save(next);
    return {
      status: 200,
      json: { ok: true, progress: next.progress, wrong: next.wrong, favorites: next.favorites, last: next.last, version: next.version },
    };
  }

  /* ---------------- 5. 重置 ids 的特殊支持（前端 notifyReset 传 ids） ---------------- */
  async function apiPatchRemoveIds(ids) {
    if (!Array.isArray(ids)) return apiPostReset({ forceAll: false });
    const c = getClient();
    if (!c) throw new Error('[cloud] 未配置云端同步');
    const base = await c.load();
    const next = cloneUserData(base);
    const rm = new Set(ids);
    for (const id of rm) delete next.progress[id];
    next.favorites = next.favorites.filter(id => !rm.has(id));
    next.wrong = rebuildWrongFromProgress(next.progress);
    next.version = Date.now();
    await c.save(next);
    return {
      status: 200,
      json: { ok: true, progress: next.progress, wrong: next.wrong, favorites: next.favorites, last: next.last, version: next.version },
    };
  }

  /* ---------------- 6. Settings Modal UI（自动注入 HTML+事件） ---------------- */
  const MODAL_HTML = `
  <div class="sheet-mask" id="rcSyncMask" hidden style="z-index:50"></div>
  <aside class="sheet" id="rcSyncModal" hidden style="z-index:51;max-width:560px">
    <div class="sheet-header">
      <div class="sheet-title">☁️ 云端同步设置</div>
      <button class="icon-btn" id="rcSyncClose" aria-label="关闭">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.8 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
      </button>
    </div>
    <div style="padding:12px 20px 20px">
      <div id="rcSyncTip" style="background:#eef6ff;border:1px solid #d7e8ff;color:#1b4b8a;border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.7;margin-bottom:12px"></div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">GIST_ID</div>
          <input id="rcGistId" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-family:ui-monospace,Menlo,Consolas,monospace" placeholder="例如：fca886b3e1393d79eb9b8d4e6afda25f" spellcheck="false" />
        </div>
        <div>
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">GitHub Token（只勾选 gist 权限的 Classic PAT）</div>
          <input id="rcGhToken" type="password" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-family:ui-monospace,Menlo,Consolas,monospace" placeholder="github_pat_.....（只勾选 gist 权限）" spellcheck="false" autocomplete="off" />
          <div style="margin-top:6px;font-size:12px;color:#64748b">
            生成地址：<a href="https://github.com/settings/tokens/new?scopes=gist&description=ruankao-quiz-sync" target="_blank" rel="noopener">github.com/settings/tokens/new → 只勾 gist</a>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button id="rcSyncSave" class="chip-btn primary" style="flex:1;min-width:120px">💾 保存并启用</button>
          <button id="rcSyncTest" class="chip-btn" style="min-width:120px">🔌 测试连接</button>
          <button id="rcSyncClear" class="chip-btn danger" style="min-width:100px">🗑 清空配置</button>
        </div>
        <div id="rcSyncResult" style="min-height:40px;font-size:13px;line-height:1.7;border-radius:8px;padding:8px 12px;margin-top:4px"></div>
      </div>
    </div>
  </aside>`;

  function ensureModalInDOM() {
    if (document.getElementById('rcSyncModal')) return true;
    // 如果有 #app 就插到 #app 末尾（在 script 之前）
    const target = document.getElementById('app') || document.body;
    const wrap = document.createElement('template');
    wrap.innerHTML = MODAL_HTML.trim();
    while (wrap.content.firstChild) target.appendChild(wrap.content.firstChild);
    // 绑定事件
    const $ = (id) => document.getElementById(id);
    const mask = $('rcSyncMask'), modal = $('rcSyncModal');
    const close = () => { mask.hidden = true; modal.hidden = true; $('rcSyncResult').textContent = ''; };
    const open = () => {
      ensureModalInDOM();
      const cfg = loadCfg();
      $('rcGistId').value = cfg?.gistId || '';
      $('rcGhToken').value = cfg?.ghToken || '';
      updateTip();
      $('rcSyncResult').textContent = '';
      mask.hidden = false; modal.hidden = false;
    };
    $('rcSyncClose')?.addEventListener('click', close);
    mask?.addEventListener('click', close);
    $('rcSyncSave')?.addEventListener('click', () => {
      const gistId = $('rcGistId').value.trim();
      const token = $('rcGhToken').value.trim();
      if (!gistId || !token) { showResult('❌ 请同时填写 GIST_ID 和 GitHub Token', 'err'); return; }
      saveCfg({ gistId, ghToken: token });
      showResult('✅ 已保存。跨设备只需填写相同的 GIST_ID + Token 即可实时同步。', 'ok');
      updateTip();
    });
    $('rcSyncTest')?.addEventListener('click', async () => {
      const gistId = $('rcGistId').value.trim();
      const token = $('rcGhToken').value.trim();
      if (!gistId || !token) { showResult('❌ 先填好上方两项', 'err'); return; }
      const prev = loadCfg();
      saveCfg({ gistId, ghToken: token });
      const r = $('rcSyncResult');
      r.textContent = '⏳ 正在连接 GitHub Gist…';
      r.style.background = '#fff7ed'; r.style.color = '#92400e';
      try {
        const c = new GistClient({ ghToken: token, gistId });
        const u = await c.load();
        const desc = await c.describe();
        const doneCnt = Object.keys(u.progress || {}).length;
        showResult(`✅ 连接成功！${desc}\n   当前 Gist 中已有答题记录 ${doneCnt} 道。保存配置后跨设备即可互通。`, 'ok');
      } catch (e) {
        showResult('❌ ' + (e.message || String(e)), 'err');
        if (prev) saveCfg(prev); else clearCfg(); // 恢复原配置
      }
    });
    $('rcSyncClear')?.addEventListener('click', () => {
      if (!confirm('确定清空云端同步配置？（不会清空本地进度或 Gist 中的数据）')) return;
      clearCfg();
      $('rcGistId').value = ''; $('rcGhToken').value = '';
      showResult('已清空配置。', 'warn');
      updateTip();
    });
    // 把 open/close 绑到闭包
    RuanKaoSync.openSettingsModal = open;
    RuanKaoSync.closeSettingsModal = close;
    return true;
  }
  function showResult(msg, type = 'info') {
    const r = document.getElementById('rcSyncResult');
    if (!r) return;
    r.textContent = msg;
    r.style.whiteSpace = 'pre-wrap';
    if (type === 'ok') { r.style.background = '#ecfdf5'; r.style.color = '#065f46'; r.style.border = '1px solid #a7f3d0'; }
    else if (type === 'err') { r.style.background = '#fef2f2'; r.style.color = '#991b1b'; r.style.border = '1px solid #fecaca'; }
    else if (type === 'warn') { r.style.background = '#fffbeb'; r.style.color = '#92400e'; r.style.border = '1px solid #fde68a'; }
    else { r.style.background = '#eff6ff'; r.style.color = '#1e40af'; r.style.border = '1px solid #bfdbfe'; }
  }
  function updateTip() {
    const tip = document.getElementById('rcSyncTip');
    if (!tip) return;
    const cfg = loadCfg();
    if (cfg) {
      tip.style.background = '#ecfdf5'; tip.style.borderColor = '#a7f3d0'; tip.style.color = '#065f46';
      tip.innerHTML = `✅ <b>云端同步已启用</b>（Gist ID: ${escapeAttr(cfg.gistId)}）。<br/>任何两台设备都填入<b>相同的 Token + Gist ID</b>，即可实现 5 秒级跨设备实时同步。`;
    } else {
      tip.innerHTML = `☁️ <b>0 元跨设备实时同步</b>（无需服务器，手机电脑互通）。<br/>
        1️⃣ 点击上方链接生成只含 <code>gist</code> 权限的 GitHub Token（1 分钟）<br/>
        2️⃣ 把 <code>GIST_ID</code> 和 Token 填到下方 → <b>保存并启用</b> → 完成。<br/>
        ℹ️ GIST_ID 已提前为你预填：<code style="background:#e0e7ff;padding:1px 6px;border-radius:6px">fca886b3e1393d79eb9b8d4e6afda25f</code>`;
    }
  }
  function escapeAttr(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------- 8. 书签 URL 自动配置（gh_token / gist_id / autoconf hash 传参） ---------------- */
  function parseHashParams() {
    const hash = (typeof location !== 'undefined' && location.hash) || '';
    if (!hash || hash.length < 2) return {};
    const out = {};
    for (const part of hash.slice(1).split('&')) {
      if (!part) continue;
      const idx = part.indexOf('=');
      const k = idx === -1 ? part : part.slice(0, idx);
      const v = idx === -1 ? '' : decodeURIComponent(part.slice(idx + 1).replace(/\+/g, ' '));
      out[String(k).toLowerCase().trim()] = v;
    }
    return out;
  }
  function pickParam(params, keys) {
    for (const k of keys) {
      const v = params[k.toLowerCase()];
      if (v != null && v !== '') return v;
    }
    return '';
  }
  function showTopToast(msg, type = 'info') {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;z-index:999999;top:14px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.4;max-width:92vw;text-align:center;';
    if (type === 'ok') { el.style.background = '#ecfdf5'; el.style.color = '#065f46'; el.style.border = '1px solid #a7f3d0'; }
    else if (type === 'err') { el.style.background = '#fef2f2'; el.style.color = '#991b1b'; el.style.border = '1px solid #fecaca'; }
    else if (type === 'warn') { el.style.background = '#fffbeb'; el.style.color = '#92400e'; el.style.border = '1px solid #fde68a'; }
    else { el.style.background = '#eff6ff'; el.style.color = '#1e40af'; el.style.border = '1px solid #bfdbfe'; }
    document.body.appendChild(el);
    setTimeout(() => { try { el.style.opacity = '0'; el.style.transition = 'opacity .6s'; setTimeout(() => el.remove(), 800); } catch {} }, 4500);
  }
  function autoApplyFromURL() {
    try {
      const params = parseHashParams();
      if (!params || Object.keys(params).length === 0) return;
      const token = pickParam(params, ['gh_token', 'token', 'ghtoken', 'ghToken', 'GH_TOKEN']);
      const gid = pickParam(params, ['gist_id', 'gistid', 'gistId', 'GIST_ID', 'gist']);
      if (!token || !gid) return; // 书签里没有完整参数，直接跳过
      const autoconf = ['1','true','yes','on'].includes(String(pickParam(params,['autoconf','auto','apply','save'])).toLowerCase());
      ensureModalInDOM();
      if (autoconf) {
        // 自动写入 localStorage，打开即进入同步模式
        saveCfg({ gistId: gid.trim(), ghToken: token.trim() });
        showTopToast('✅ 书签已自动启用跨设备同步（Gist ' + gid.trim().slice(0, 8) + '…），右上角⚙️可查看/修改', 'ok');
        // 通知 app.js：配置变了，立即重新拉一次（若 app.js 已初始化了 RuanKaoSync 会在下一轮 pull 里生效，这里主动触发一下）
        if (typeof window.RKNotifyHashApplied === 'function') try { window.RKNotifyHashApplied(); } catch {}
        if (typeof window.dispatchEvent === 'function') try { window.dispatchEvent(new CustomEvent('ruankao:cfg-applied', { detail: { gistId: gid.trim() } })); } catch {}
      } else {
        // 只预填，用户确认后手动点保存
        setTimeout(() => {
          try {
            document.getElementById('rcGistId').value = gid.trim();
            document.getElementById('rcGhToken').value = token.trim();
          } catch {}
          if (typeof RuanKaoSync !== 'undefined' && RuanKaoSync.openSettingsModal) {
            RuanKaoSync.openSettingsModal();
            try {
              document.getElementById('rcGistId').value = gid.trim();
              document.getElementById('rcGhToken').value = token.trim();
            } catch {}
            showTopToast('💡 书签已自动填入配置，请点【保存并启用】或先【测试连接】确认', 'warn');
          }
        }, 300);
      }
    } catch (e) { /* 书签解析失败无副作用 */ console.warn('[gist-client] autoApplyFromURL failed:', e); }
  }

  /* ---------------- 7. 初始化全局对象 ---------------- */
  const RuanKaoSync = {
    // --- 能力检测 ---
    isAvailable() { return !!getClient(); },
    hasConfigSaved() { return !!loadCfg(); },
    // --- 核心 API（返回 {status, json}，和后端 /api/* 同结构）---
    async getSync(opts) { return apiGetSync(opts); },
    async postSync(patch, opts) { return apiPostSync(patch, opts); },
    async postReset(opts) { return apiPostReset(opts); },
    async patchRemoveIds(ids) { return apiPatchRemoveIds(ids); },
    // --- UI ---
    openSettingsModal() { ensureModalInDOM(); document.getElementById('rcSyncMask').hidden = false; document.getElementById('rcSyncModal').hidden = false; updateTip(); loadCfg() && (document.getElementById('rcGistId').value = loadCfg().gistId, document.getElementById('rcGhToken').value = loadCfg().ghToken); },
    closeSettingsModal() { const m = document.getElementById('rcSyncMask'); if (m) m.hidden = true; const mm = document.getElementById('rcSyncModal'); if (mm) mm.hidden = true; },
    // --- 配置 ---
    loadCfg, saveCfg, clearCfg,
    // --- 书签解析工具（外部可直接调试）---
    autoApplyFromURL, parseHashParams,
  };

  // 启动前如果 DOM 已经 ready，先把 Modal 基础闭包绑好，再尝试从 URL 书签自动应用配置
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { ensureModalInDOM(); autoApplyFromURL(); }, { once: true });
    } else {
      ensureModalInDOM();
      autoApplyFromURL();
    }
  }

  // 暴露到全局（app.js 里可以直接用 window.RuanKaoSync 检测 / 调用）
  window.RuanKaoSync = RuanKaoSync;
})();
