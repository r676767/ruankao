import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const raw = fs.readFileSync(path.join(ROOT, 'raw-content.md'), 'utf8');

// ---------- 1. 行级预处理 ----------
const rawLines = raw.split(/\r?\n/);

const AD_STR =
  '(解牛|牛老师|绍牛者师|蜗牛软考|蜗牛软考教育培训淘宝店|蜗牛软考内部学员辅导专用材料|辆牛款考|纳牛软考|蝴牛软考|躺牛软考|牛者师)';
const adRegexWhole = new RegExp(
  `^.*(${AD_STR}(公众号|教育培训|内部学员|淘宝店)).*$`,
  'i',
);
const adInlineRegex = new RegExp(
  `${AD_STR}[^\\n]*?(培训辅导|侵权必究|专业.*?辅导)[,，。.]*\\s*`,
  'gi',
);
const hruleRegex = /^-----+$/;
const pageRegex = /^第\s*\d+\s*页\s*$/;
const catalogStartRegex = /^\s*目录\s*$/;

let lines = [];
let inCatalog = false;
let seenFirstChapter = false;

for (const rawLine of rawLines) {
  let ln = rawLine;
  if (!seenFirstChapter && catalogStartRegex.test(ln.trim())) {
    inCatalog = true;
    continue;
  }
  if (/^#\s*第\d+章/.test(ln)) {
    seenFirstChapter = true;
    inCatalog = false;
  }
  if (inCatalog && !seenFirstChapter) continue;
  if (adRegexWhole.test(ln.trim())) continue;
  if (hruleRegex.test(ln.trim())) continue;
  if (pageRegex.test(ln.trim())) continue;
  ln = ln.replace(adInlineRegex, ' ');
  ln = ln.replace(/^#{1,6}\s*/, '');
  ln = ln.replace(/^["\*\(\)]+\s*/, '');
  lines.push(ln);
}
const firstChIdx = lines.findIndex((ln) => /^#?\s*第\d+章/.test(ln));
if (firstChIdx > 0) lines = lines.slice(firstChIdx);

// ---------- 2. 拼逻辑段落 ----------
const paragraphs = [];
let buf = [];
function flush() {
  if (buf.length) {
    const s = buf.map((l) => l.trim()).join(' ').trim();
    if (s) paragraphs.push(s);
    buf = [];
  }
}

// 章节号范围：整份材料只有 1-24 章，小节号 X.Y 中 X 必然等于章节号（1-24）
// 所以合法小节号形如 "(\d{1,2})\.(\d{1,2})"，且章节号部分 <= 24
function isValidSectionNumber(numStr) {
  const [x, y] = numStr.split('.').map((n) => parseInt(n, 10));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 1 || x > 24) return false;
  if (y < 0 || y > 99) return false;
  return true;
}

// "X.Y标题" 但不能是 "X.Y.Z"（IP地址/版本号）
function sectionLikeStart(t) {
  const m = t.match(/^(\d{1,2}\.\d{1,2})(?![.\d])/);
  if (!m) return false;
  return isValidSectionNumber(m[1]);
}

function isParaBoundary(line) {
  const t = line.trim();
  if (!t) return true;
  // 章节 "# 第N章" / "第N章"
  if (/^#?\s*第\d+章/.test(t)) return true;
  // 试题开头 绝对是边界
  if (/^试题\s*\d+\s*[-—]/.test(t)) return true;
  // 答案 / 解析
  if (/^【答案】/.test(t)) return true;
  if (/^【蜗牛?解析】/.test(t)) return true;
  // 小节标题边界：合法的 X.Y 标题形式（即使含"试题"字样，也让后面 compound 处理）
  if (sectionLikeStart(t)) return true;
  // 带 # 前缀的 "## X.Y"
  if (/^#{1,6}\s*(\d{1,2}\.\d{1,2})(?![.\d])/.test(t)) {
    const m = t.match(/^#{1,6}\s*(\d{1,2}\.\d{1,2})/);
    if (m && isValidSectionNumber(m[1])) return true;
  }
  return false;
}

// "1.1 信息系统及其发展 试题1-【蜗牛老师自编题】" 切成 标题段 + 试题段
function splitCompoundLine(line) {
  const t = line.trim().replace(/^#{1,6}\s*/, '');
  // 要求："合法X.Y + 任意文字 + 试题N-【来源】+ 任意"
  const m = t.match(
    /^(\d{1,2}\.\d{1,2})(?![.\d])\s*(.*?)(试题\s*\d+\s*[-—]\s*【[^】]+】.*)$/,
  );
  if (m && isValidSectionNumber(m[1])) {
    return [`${m[1]} ${m[2].trim()}`.trim(), m[3].trim()];
  }
  return null;
}

for (const ln of lines) {
  if (ln.trim() === '') {
    flush();
    continue;
  }
  if (isParaBoundary(ln)) {
    flush();
    const parts = splitCompoundLine(ln);
    if (parts) {
      paragraphs.push(parts[0]);
      paragraphs.push(parts[1]);
    } else {
      paragraphs.push(ln.trim());
    }
    continue;
  }
  buf.push(ln);
}
flush();

// ---------- 3. 提取章节/小节/题目 ----------
const chapters = [];
let currentChapter = null;
let currentSection = null;

const chapterRegex = /^#?\s*第(\d+)章\s*(.+?)\s*\.?\s*$/;
const sectionRegex = /^#{0,6}\s*(\d{1,2}\.\d{1,2})(?![.\d])\s*[\s\u3000]*(.+?)\s*\.?\s*$/;
const questionStartRegex = /^试题\s*(\d+)\s*[-—]\s*【([^】]+)】\s*(.*)$/;

// 从一段包含答案标记的文字中尽量提取 "A" "AB" 等答案字母
// 容忍：【答案】:A 【谷案】;A 【答案A 答案 A 答：A 等等
function extractAnswer(text) {
  if (!text) return '';
  // 1) 典型：从 "【答案" 或 "【谷案" 附近开始往后找 1-6 个 A-F（允许中间插 :：;；,，、空格 等）
  const markers = ['【答案', '【谷案', '答 案', '答案', '【答', '答：', '答:'];
  let cursor = -1;
  for (const mk of markers) {
    const p = text.indexOf(mk);
    if (p >= 0 && (cursor < 0 || p < cursor)) cursor = p;
  }
  if (cursor < 0) cursor = 0;
  const near = text.slice(cursor, cursor + 40);
  // 在 near 中剥离非 A-F 分隔字符和【】标记
  const cleaned = near.replace(/[^A-F,，、;\s:：]/g, '').replace(/[^\dA-F]/g, '');
  // cleaned 必须有 1-6 个 A-F 字符，且不能是 "PDFIUM..." 之类的误伤（答案段都以答字开头，误匹配概率极低）
  if (/^[A-F]{1,6}$/.test(cleaned)) return cleaned;
  // 2) 退而直接在整段搜 "【答案】A" 形式
  const m = text.match(/【?\s*答\s*案?\s*[\]：:;；,，、\s]*\s*([A-F]{1,6}(?:\s*[,，、;；]\s*[A-F])*)/);
  if (m) return m[1].replace(/[,，、;；\s]+/g, '');
  return '';
}
// 选项开头：字母必须是 A-F，后面紧跟 "、" "．" "." 且前面不能粘连其他字母数字（独立词位）
// 后面用 "环视" 限定：从字符串开头或前一个选项后匹配
function extractOptions(text) {
  const opts = new Map();
  // 在 text 中找出所有位置的 "A-F[、.．]" 且 该位置前不是字母数字或下划线
  const re = /(^|[^A-Za-z0-9_])([A-F])[、.．]\s*/g;
  let m;
  const hits = [];
  while ((m = re.exec(text)) !== null) {
    hits.push({ letter: m[2], pos: m.index + m[1].length });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].pos + 2; // 字母(1) + 标点(1) → 从下一位开始算内容
    const end = i + 1 < hits.length ? hits[i + 1].pos : text.length;
    const content = text
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim();
    if (content) opts.set(hits[i].letter, content);
  }
  return opts;
}

function ensureChapter() {
  if (!currentChapter) {
    currentChapter = { id: 'c_unknown', index: 0, title: '未命名章节', sections: [] };
    chapters.push(currentChapter);
  }
}
function ensureSection() {
  ensureChapter();
  if (!currentSection) {
    currentSection = {
      id: `${currentChapter.id}_s_none`,
      number: `${currentChapter.index}.0`,
      title: '章节综合',
      questions: [],
    };
    currentChapter.sections.push(currentSection);
  }
}

let i = 0;
while (i < paragraphs.length) {
  const p = paragraphs[i];
  i++;

  let m = p.match(chapterRegex);
  if (m) {
    const idx = parseInt(m[1], 10);
    currentChapter = { id: `c${idx}`, index: idx, title: m[2].trim(), sections: [] };
    chapters.push(currentChapter);
    currentSection = null;
    continue;
  }

  // 小节：先做严格校验，X.Y 中 X 应等于当前章编号（如果有的话）
  m = p.match(sectionRegex);
  if (m && isValidSectionNumber(m[1])) {
    const num = m[1];
    const [x] = num.split('.').map((n) => parseInt(n, 10));
    if (!currentChapter || x === currentChapter.index) {
      ensureChapter();
      currentSection = {
        id: `${currentChapter.id}_s_${num}`,
        number: num,
        title: m[2].trim(),
        questions: [],
      };
      currentChapter.sections.push(currentSection);
      continue;
    }
  }

  m = p.match(questionStartRegex);
  if (m) {
    ensureSection();
    const localNum = parseInt(m[1], 10);
    const source = m[2].trim();
    const headText = m[3].trim();

    const tail = [];
    if (headText) tail.push(headText);

    while (i < paragraphs.length) {
      const nxt = paragraphs[i];
      // 下一题/节/章 边界
      if (
        questionStartRegex.test(nxt) ||
        (sectionRegex.test(nxt) &&
          (() => {
            const sm = nxt.match(sectionRegex);
            if (!sm || !isValidSectionNumber(sm[1])) return false;
            const [x] = sm[1].split('.').map((n) => parseInt(n, 10));
            return !currentChapter || x === currentChapter.index;
          })()) ||
        chapterRegex.test(nxt)
      ) {
        break;
      }
      tail.push(nxt);
      i++;
    }

    // 分界：在 tail 数组中找 【答案】 和 【蜗牛解析】的首次出现段
    // 注意：PDF 识别导致答案标记有变体：【答案】、【谷案】、【答案（少闭合括号）、【答 案】、答案:X 等
    function findAnswerStart(str) {
      if (!str) return -1;
      let idx = str.indexOf('【答案】');
      if (idx < 0) idx = str.indexOf('【谷案】');
      if (idx < 0) idx = str.indexOf('【答案'); // 缺闭合括号
      if (idx < 0) idx = str.indexOf('【答 案】');
      if (idx < 0) {
        // fallback：正则模糊搜 答[案：:] 或 【答...案...】附近
        const m = str.match(/【?\s*答\s*案?\s*[:：;；\]】]/);
        if (m) idx = m.index;
      }
      return idx;
    }
    function findAnalysisStart(str) {
      if (!str) return -1;
      let idx = str.indexOf('【蜗牛解析】');
      if (idx < 0) idx = str.indexOf('【牛解析】');
      if (idx < 0) idx = str.indexOf('【蜗牛解');
      if (idx < 0) idx = str.indexOf('蜗牛解析】');
      return idx;
    }

    const rawAnsIdx = tail.findIndex((s) => findAnswerStart(s) >= 0);
    let answerIdx = rawAnsIdx >= 0 ? rawAnsIdx : tail.length;
    const rawAnaIdx = tail.findIndex((s) => findAnalysisStart(s) >= 0);
    let analysisIdx = rawAnaIdx >= 0 ? rawAnaIdx : tail.length;

    // front：所有题干+选项文本 = answer段之前的段落 + answer段中【答案】之前的字符
    let front = '';
    if (answerIdx < tail.length) {
      const before = tail.slice(0, answerIdx);
      if (before.length) front += before.join(' ') + ' ';
      const am = findAnswerStart(tail[answerIdx]);
      if (am > 0) front += tail[answerIdx].slice(0, am);
    } else {
      front = tail.join(' ');
    }
    front = front.trim();

    // answerPart：【答案】开始 到 解析开始 之间
    let answerPart = '';
    if (answerIdx < tail.length) {
      let ansSec;
      if (analysisIdx > answerIdx) {
        const pieces = [];
        const ansStart = findAnswerStart(tail[answerIdx]);
        if (ansStart >= 0) pieces.push(tail[answerIdx].slice(ansStart));
        for (let k = answerIdx + 1; k < analysisIdx; k++) pieces.push(tail[k]);
        if (analysisIdx < tail.length) {
          const aStart = findAnalysisStart(tail[analysisIdx]);
          if (aStart > 0) pieces.push(tail[analysisIdx].slice(0, aStart));
        }
        ansSec = pieces.join(' ');
      } else {
        const ansStart = findAnswerStart(tail[answerIdx]);
        const aStart = findAnalysisStart(tail[answerIdx]);
        const sub = tail[answerIdx].slice(
          ansStart >= 0 ? ansStart : 0,
          aStart >= 0 ? aStart : undefined,
        );
        ansSec = sub;
      }
      answerPart = ansSec.trim();
    }

    // analysisPart：【蜗牛解析】开始 到 末尾
    let analysisPart = '';
    if (analysisIdx < tail.length) {
      const pieces = [];
      const aStart0 = findAnalysisStart(tail[analysisIdx]);
      if (aStart0 >= 0) pieces.push(tail[analysisIdx].slice(aStart0));
      else pieces.push(tail[analysisIdx]);
      for (let k = analysisIdx + 1; k < tail.length; k++) pieces.push(tail[k]);
      analysisPart = pieces.join(' ');
    }
    // fallback1：完全没解析字样时，答案段中答案之后、下一题之前的所有文字都可能是解析
    if (!analysisPart && answerIdx < tail.length) {
      const tailAns = tail.slice(answerIdx).join(' ');
      const aPos = findAnswerStart(tailAns);
      if (aPos >= 0) {
        const after = tailAns
          .slice(aPos)
          .replace(/【?\s*答\s*案?\s*[:：;；\]】\s*]?[A-F,，、;\s]+\s*/, '');
        if (after && after.length > 4) analysisPart = after;
      }
    }
    // fallback2：答案、解析都缺失的情况下，tail末尾可能全是解析（极端个案直接放弃）

    // --- 拆分 题干 & 选项 ---
    let optionMap = extractOptions(front);
    // 回退：若 front 中没拿到任何选项，可能是选项段因排版被分到了答案段或解析段的前后
    //        此时在整个 tail 中剔掉 【答案...】 和 【蜗牛解析...】之后的所有字符后再搜
    if (optionMap.size === 0 && tail.length) {
      const whole = tail.join(' ');
      // 截取：从开始 到 【答案】 之前（若无答案则到【蜗牛解析】之前）
      let cut = whole.length;
      const aA = findAnswerStart(whole);
      const aB = findAnalysisStart(whole);
      if (aA >= 0) cut = Math.min(cut, aA);
      if (aB >= 0) cut = Math.min(cut, aB);
      const haystack = whole.slice(0, cut).trim();
      if (haystack) optionMap = extractOptions(haystack);
      // 若还是0，放宽：对整个 tail（去掉解析）搜
      if (optionMap.size === 0) {
        const h2 = (aB >= 0 ? whole.slice(0, aB) : whole).trim();
        if (h2) optionMap = extractOptions(h2);
      }
    }

    let stem = front;
    // 逐项反向剔除选项文本（仅当 front 中包含该选项文本时才剔除，避免把题干中的句子误删）
    const sorted = [...optionMap.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [letter, txt] of sorted) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pat = new RegExp(
        `(^|[^A-Za-z0-9_])${esc(letter)}[、.．]\\s*${esc(txt)}`,
        'g',
      );
      if (pat.test(stem)) {
        stem = stem.replace(pat, '$1 ');
      }
    }
    stem = stem
      .replace(/\s+/g, ' ')
      .replace(/^[：:，,。.\s、\-—]+/, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    stem = stem.replace(/^试题\s*\d+\s*[-—]\s*【[^】]+】\s*/, '').trim();
    // 如果最后 stem 还是空（极端情况），退而求其次：在 tail 中取题干（第一个选项前的文字，或答案/解析前的文字）
    if (!stem) {
      const letters = [...optionMap.keys()].sort();
      if (letters.length) {
        const allText = tail.join(' ');
        const first = letters[0];
        const re = new RegExp(`(^|[^A-Za-z0-9_])${first}[、.．]`);
        const m = allText.search(re);
        if (m >= 0) {
          stem = allText
            .slice(0, m)
            .replace(/\s+/g, ' ')
            .trim();
        }
      }
      if (!stem) {
        const whole = tail.join(' ');
        const aA = findAnswerStart(whole);
        const aB = findAnalysisStart(whole);
        const cut = Math.min(
          aA >= 0 ? aA : Infinity,
          aB >= 0 ? aB : Infinity,
        );
        if (isFinite(cut)) {
          stem = whole.slice(0, cut).replace(/\s+/g, ' ').trim();
        } else {
          stem = whole.replace(/\s+/g, ' ').trim().slice(0, 200);
        }
      }
      stem = stem.replace(/^试题\s*\d+\s*[-—]\s*【[^】]+】\s*/, '').trim();
    }

    const options = [];
    for (const [letter, text] of optionMap.entries()) {
      if (text) options.push({ letter, text });
    }
    // 按字母排序
    options.sort((a, b) => a.letter.localeCompare(b.letter));

    // --- 答案 ---
    const answer = extractAnswer(answerPart);

    // --- 解析 ---
    let analysis = analysisPart
      .replace(/^【蜗牛?解析】\s*[:：;；]?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    const q = {
      id: `${currentSection.id}_q${localNum}`,
      localIndex: localNum,
      source,
      stem,
      options,
      answer,
      analysis,
    };
    currentSection.questions.push(q);
    continue;
  }
  // 其他段落忽略
}

// ---------- 4. 输出 ----------
let totalQ = 0;
let noAnsQ = 0;
let noAnaQ = 0;
let noOptsQ = 0;
const report = [];
for (const ch of chapters) {
  let chCnt = 0;
  for (const sec of ch.sections) {
    chCnt += sec.questions.length;
    for (const q of sec.questions) {
      if (!q.answer) noAnsQ++;
      if (!q.analysis) noAnaQ++;
      if (!q.options.length) noOptsQ++;
    }
  }
  totalQ += chCnt;
  const secsInfo = ch.sections
    .map((s) => `${s.number}(${s.questions.length})`)
    .join(' ');
  report.push(
    `第${String(ch.index).padStart(2, '0')}章 ${ch.title.padEnd(22, ' ')} : ${String(
      chCnt,
    ).padStart(3, ' ')}题 / ${ch.sections.length}节  [${secsInfo}]`,
  );
}

const output = {
  meta: {
    name: '系统规划与管理师 综合分章节练习题',
    version: '2026有解析版',
    totalQuestions: totalQ,
    generatedAt: new Date().toISOString(),
  },
  chapters,
};

fs.mkdirSync(path.join(ROOT, 'app', 'data'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'app', 'data', 'questions.json'),
  JSON.stringify(output, null, 2),
  'utf8',
);

console.log('=== 提取报告 ===');
console.log(
  `总题数=${totalQ}  章节=${chapters.length}  无答案=${noAnsQ}  无解析=${noAnaQ}  无选项=${noOptsQ}`,
);
console.log('-'.repeat(90));
for (const line of report) console.log(line);

// 异常样本
console.log('\n=== 异常抽样（前6条）===');
let printed = 0;
OUTER: for (const ch of chapters) {
  for (const sec of ch.sections) {
    for (const q of sec.questions) {
      if (!q.answer || !q.analysis || !q.options.length) {
        console.log(
          `  [${!q.answer ? '缺答' : ''}${!q.analysis ? '缺解' : ''}${
            !q.options.length ? '缺选' : ''
          }] 第${ch.index}章/${sec.number} 试题${q.localIndex}`,
        );
        console.log(
          `    题干: ${q.stem.slice(0, 80)}${q.stem.length > 80 ? '…' : ''}`,
        );
        console.log(
          `    选项(${q.options.length}): ${q.options
            .map((o) => o.letter + '、' + o.text.slice(0, 14))
            .join(' | ')}`,
        );
        console.log(
          `    答案=${q.answer || '(空)'}   解析=${
            q.analysis ? q.analysis.slice(0, 60) + (q.analysis.length > 60 ? '…' : '') : '(空)'
          }`,
        );
        printed++;
        if (printed >= 6) break OUTER;
      }
    }
  }
}
