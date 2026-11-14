// 打印 CHANGELOG.md 中某个版本的一节，供发布工作流作为草稿 Release 的正文：
//   node scripts/changelog-section.mjs <版本> > notes.md
// 找不到该版本的一节时退出码 1。
import fs from 'node:fs';
import { changelogSection } from './release-plan.mjs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const body = version ? changelogSection(fs.readFileSync('CHANGELOG.md', 'utf8'), version) : '';
if (!body) {
  console.error(`CHANGELOG.md 里没有版本 ${version || '（未指定）'} 的一节。`);
  process.exit(1);
}
process.stdout.write(body + '\n');
