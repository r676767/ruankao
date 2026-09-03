/* =============================================================
 *  scripts/create-gist.cjs  （CommonJS，可直接 node 运行，无需 import）
 *  用途：一键创建私有 Gist 存 userdata.json，输出 GIST_ID，方便部署 Vercel 环境变量使用
 *
 *  使用方式（2 选 1）：
 *    A) 交互输入：
 *       $ node scripts/create-gist.cjs
 *       然后提示你粘贴 GitHub PAT。
 *
 *    B) 环境变量（非交互，脚本化）：
 *       $ $env:GH_TOKEN="ghp_xxxxxxxxxxxxxxxxx" ; node scripts/create-gist.cjs
 *       或：
 *       $ $env:GITHUB_TOKEN="ghp_..." ; node scripts/create-gist.cjs
 *
 *  输出：成功时打印 GIST_ID，并把一个含结果的 JSON 写到 .gist-info.json 供参考
 *
 *  GitHub PAT 生成方式：
 *    GitHub 右上角头像 → Settings → Developer settings → Personal access tokens
 *      → Tokens (classic) → Generate new token (classic)
 *      → Note: 填 "ruankao-gist-sync"
 *      → Expiration: 建议选 "No expiration" 或至少 90 天
 *      → 勾选 scopes 里的 ** [√] gist ** （只需这一项，不要勾多余，遵循最小权限）
 *      → Generate token，复制出来（只显示一次！）
 * ============================================================= */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { URL } = require('url');

const GIST_API = 'api.github.com';
const API_VERSION = '2022-11-28';
const USERDATA_FILE = 'userdata.json';
const INITIAL_BODY = JSON.stringify({
  progress: {},
  wrong: [],
  favorites: [],
  last: null,
  version: Date.now(),
}, null, 2);

function ghRequest(method, path, token, jsonBody) {
  return new Promise((resolve, reject) => {
    const body = jsonBody ? JSON.stringify(jsonBody) : null;
    const opts = {
      hostname: GIST_API,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'ruankao-create-gist/1.0',
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const obj = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: obj, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

async function main() {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  console.log('================================================');
  console.log('  🛠️  ruankao · 私有 Gist 创建工具（0元实时同步）');
  console.log('================================================\n');
  if (!token) {
    console.log('请输入 GitHub Personal Access Token (classic)：');
    console.log('  · 生成地址：https://github.com/settings/tokens?type=beta （切到 classic 选项）');
    console.log('  · 只需要勾选 gist 这一个权限即可\n');
    token = (await prompt('Paste your token: ghp_')).trim();
    if (!token) { console.error('❌ Token 不能为空'); process.exit(1); }
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      // 新版 fine-grained 也是不同前缀开头；给个提醒但不强制
      console.warn('⚠️  Token 前缀不是 ghp_ / github_pat_，如果是 fine-grained token 请确认已授予 Gists 读写权限');
    }
  }

  // 先测试：GET /user 判断 token 有效性
  console.log('\n1/3 验证 Token 权限…');
  const me = await ghRequest('GET', '/user', token);
  if (me.status !== 200) {
    console.error('❌ Token 无效或无权限：status=' + me.status);
    if (me.data && me.data.message) console.error('  GitHub 返回：', me.data.message);
    process.exit(1);
  }
  console.log('  ✅ 登录用户：@' + me.data.login);

  // 创建私有 Gist
  console.log('\n2/3 创建私有 Gist（包含 userdata.json 初始值）…');
  const created = await ghRequest('POST', '/gists', token, {
    description: `ruankao-quiz 进度备份 · 创建于 ${new Date().toISOString()} · owner=@${me.data.login}`,
    public: false,
    files: {
      [USERDATA_FILE]: {
        filename: USERDATA_FILE,
        content: INITIAL_BODY,
      },
      'README.md': {
        filename: 'README.md',
        content:
`# ruankao-quiz 进度备份（私有）

此 Gist 由 **ruankao 刷题应用** 自动维护，用于 **0 元免费实时同步** 手机/电脑之间的答题进度、错题本、收藏夹、上次答题位置。

## 手动编辑会被覆盖

请不要手动修改下面的 \`userdata.json\` 内容。应用每次写入会覆盖。

- 归属用户：@${me.data.login}
- 创建时间：${new Date().toISOString()}
- 兼容客户端版本：ruankao v1.x
`,
      },
    },
  });
  if (created.status !== 201) {
    console.error('❌ 创建 Gist 失败：status=' + created.status);
    if (created.data && created.data.message) console.error('  GitHub 返回：', created.data.message);
    if (created.data && created.data.errors) console.error('  Errors:', JSON.stringify(created.data.errors, null, 2));
    process.exit(1);
  }
  const gistId = created.data.id;
  const gistUrl = `https://gist.github.com/${me.data.login}/${gistId}`;
  console.log('  ✅ Gist 已创建：' + gistUrl);

  // 读取校验：GET gist，内容能解析，且包含 userdata.json
  console.log('\n3/3 回读校验（确认 Gist 可正常读写）…');
  const readback = await ghRequest('GET', `/gists/${gistId}`, token);
  if (readback.status !== 200) {
    console.error('❌ 回读失败：status=' + readback.status);
    process.exit(1);
  }
  const file = readback.data.files && readback.data.files[USERDATA_FILE];
  if (!file || !file.content) {
    console.error('❌ 回读后 userdata.json 缺失，请检查 Gist 页面手动添加');
    process.exit(1);
  }
  const parsed = JSON.parse(file.content);
  if (!parsed || typeof parsed.progress !== 'object') {
    console.error('❌ userdata.json 内容非法');
    process.exit(1);
  }
  console.log('  ✅ userdata.json 内容合法，progress=0 条初始记录');

  // 输出结果
  const infoPath = path.join(process.cwd(), '.gist-info.json');
  const info = {
    createdAt: new Date().toISOString(),
    owner: me.data.login,
    gistId,
    gistUrl,
    storageKind: 'gist',
    envVarsHint: {
      GIST_ID: gistId,
      GH_TOKEN: '(在 Vercel 环境变量粘贴你的 GitHub PAT)',
    },
  };
  try { fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf-8'); } catch {}

  console.log('\n================================================');
  console.log('  🎉 创建完成！以下环境变量粘贴到 Vercel：');
  console.log('================================================\n');
  console.log('  ① GIST_ID ：  ' + gistId);
  console.log('  ② GH_TOKEN：  （你刚才输入的那个 Token，形如 ghp_xxxxx）\n');
  console.log('  · 私有 Gist 页面：' + gistUrl);
  console.log('  · 本地结果备份：' + infoPath);
  console.log('\n接下来部署步骤看项目 README 或聊天里的「Vercel 部署分步指引」。');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
