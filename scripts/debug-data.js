import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/questions.json'), 'utf8'));

// 1. 找缺答案的前5道并打印章节
let noAnsSamples = [];
let noOptsSamples = [];
let weirdLocalNumSamples = [];

for (const ch of data.chapters) {
  for (const sec of ch.sections) {
    // 统计本节 localNum 的最小值是否从1开始连续
    const nums = sec.questions.map((q) => q.localIndex).sort((a, b) => a - b);
    if (nums.length && nums[0] !== 1) {
      weirdLocalNumSamples.push(`${ch.index}/${sec.number} ${sec.title}: qNum最小=${nums[0]}, 个数=${sec.questions.length}, nums前5=[${nums.slice(0, 5).join(',')}]`);
    }
    for (const q of sec.questions) {
      if (!q.answer && noAnsSamples.length < 5) {
        noAnsSamples.push({
          where: `第${ch.index}章 ${sec.number} ${sec.title} 试题${q.localIndex} (id=${q.id})`,
          stem: q.stem,
          optLen: q.options.length,
          optLetters: q.options.map((o) => o.letter).join(','),
        });
      }
      if (q.options.length === 0 && noOptsSamples.length < 5) {
        noOptsSamples.push({
          where: `第${ch.index}章 ${sec.number} ${sec.title} 试题${q.localIndex} (id=${q.id})`,
          stem: q.stem.slice(0, 80),
          answer: q.answer,
        });
      }
    }
  }
}

console.log('--- 缺失答案的样本 (前5) ---');
for (const s of noAnsSamples) console.log(JSON.stringify(s, null, 2));
console.log('\n--- 缺失选项的样本 (前5) ---');
for (const s of noOptsSamples) console.log(JSON.stringify(s, null, 2));
console.log('\n--- 本节题目非从"试题1"开始的异常 (前10) ---');
for (const s of weirdLocalNumSamples.slice(0, 10)) console.log('  ' + s);
