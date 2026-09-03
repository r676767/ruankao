// 重构后本地回归：跟改造前的最终验证对齐，确保 FileStorage 路径下 API 行为不变
const fs = require('fs');
const http = require('http');
function req(path, opts={}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port: 8080, path, method: opts.method||'GET', headers: opts.headers||{} }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const TMP_DIR = 'E:/code/ruankao/app/data/userdata.json';

(async () => {
  let fail = 0;
  function t(pass, label){ console.log(' ', (pass?'OK  ':'FAIL'), label); if (!pass) fail++; }

  // 0. favicon / robots / health
  const fav = await req('/favicon.ico');
  t(fav.status===200 && fav.headers['content-type'].startsWith('image/svg+xml'), 'GET /favicon.ico 200 svg');
  const rob = await req('/robots.txt');
  t(rob.status===200, 'GET /robots.txt 200');
  const hlth = await req('/health');
  const hlthJson = JSON.parse(hlth.body);
  t(hlth.status===200 && hlthJson.ok && hlthJson.storage==='file', '/health 200, storage=file reported');
  const opt = await req('/api/sync', { method:'OPTIONS' });
  t(opt.status===204 && opt.headers['access-control-allow-origin']==='*', 'OPTIONS /api/sync 204 CORS');

  // 1. GET /api/sync 初始：零进度
  const s1 = await req('/api/sync');
  const d1 = JSON.parse(s1.body);
  t(s1.status===200, 'GET /api/sync 200');
  t(typeof d1.progress === 'object' && Array.isArray(d1.wrong) && Array.isArray(d1.favorites), 'sync 结构正确');
  const initProgress = Object.keys(d1.progress).length;
  console.log(`   初始 progress 记录数: ${initProgress}`);

  // 2. POST /api/sync：写入一些 progress + favorite + last
  const ts = Date.now();
  const progress = { 'test_qid_1': { my: 'A', correct: true, answeredAt: ts } };
  const favorites = ['test_qid_1'];
  const last = { chapterId: 'c', sectionId: 's', index: 2, updatedAt: ts };
  const p1 = await req('/api/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ progress, favorites, last }) });
  t(p1.status === 200, 'POST /api/sync 200');
  const dp1 = JSON.parse(p1.body);
  t(dp1.ok === true && Object.keys(dp1.progress || {}).includes('test_qid_1'), '服务端合并正确，返回包含新记录');
  t(Array.isArray(dp1.favorites) && dp1.favorites.includes('test_qid_1'), '收藏夹写入正确');
  t(dp1.last && dp1.last.index === 2, 'last 写入正确');

  // 3. GET /api/sync：持久化之后再读，应能读到
  await new Promise(r => setTimeout(r, 700)); // 等批写 flush 120+磁盘 IO
  const s2 = await req('/api/sync');
  const d2 = JSON.parse(s2.body);
  const got = Object.keys(d2.progress).includes('test_qid_1') && d2.favorites.includes('test_qid_1');
  t(got, 'GET /api/sync 读回写入的记录，说明存储持久化');
  t(fs.existsSync(TMP_DIR), 'userdata.json 文件真实存在于磁盘');

  // 4. 再 POST 一条错题（触发 wrong 重建）
  await req('/api/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ progress: { 'test_qid_2': { my:'C', correct:false, answeredAt: ts+1 } } }) });
  await new Promise(r => setTimeout(r, 600));
  const s3 = await req('/api/sync');
  const d3 = JSON.parse(s3.body);
  const wrongHas = d3.wrong.some(w => w.id === 'test_qid_2');
  t(wrongHas && d3.wrong.length === 1, `错题自动重建：wrong=[${d3.wrong.map(x=>x.id)}] 包含 test_qid_2`);

  // 5. 兼容旧前端：POST /api/reset body={ids:['test_qid_1','test_qid_2']}
  const rs1 = await req('/api/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ids: ['test_qid_1','test_qid_2'] }) });
  t(rs1.status === 200, 'POST /api/reset (body.ids) 200');
  await new Promise(r => setTimeout(r, 2000)); // 给 flushImmediately 足够的写盘 + fs sync
  const s4 = await req('/api/sync');
  const d4 = JSON.parse(s4.body);
  t(Object.keys(d4.progress).length === 0 && d4.favorites.length === 0 && d4.wrong.length === 0, 'reset ids 后 progress/favorites/wrong 全部清空');

  // 6. 首页和静态资源
  const home = await req('/');
  t(home.status === 200 && home.body.includes('id="wrongView"') && home.body.includes('id="exportBtn"'), '首页 200 且含 错题本/导出按钮 DOM');
  const qs = await req('/data/questions.json');
  t(qs.status === 200 && qs.body.length > 2000000, 'questions.json 200 且 > 2MB');
  const appjs = await req('/app.js');
  t(appjs.status === 200, 'app.js 200');
  const css = await req('/styles.css');
  t(css.status === 200, 'styles.css 200');

  // 7. 404 不存在路径
  const nf = await req('/manifest.json');
  t(nf.status === 404, 'GET /manifest.json 404 NotFound');

  // 8. 不存在 /api/xyz
  const ax = await req('/api/xyz');
  t(ax.status === 404, 'GET /api/xyz 404');

  if (fail === 0) console.log('\n✅ 本地重构回归：全部通过');
  else { console.log(`\n❌ 失败项: ${fail}`); process.exit(1); }
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
