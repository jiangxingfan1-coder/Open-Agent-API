import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 设置页的「协议能力」显示中文名：网关在 /health 里声明的每一项（GATEWAY_FEATURES，开启开发者平台时
// 再加 platform-v1）都要在控制台的名称表里有一条，否则页面会露出原始特性 ID。只读源码文本，不加载
// 浏览器模块。

const read = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const quoted = (text: string) => [...text.matchAll(/'([a-z0-9-]+-v\d+)'/g)].map((m) => m[1]!);

test('every capability the gateway can advertise has a name in the console', () => {
  const server = read('src/gateway/server.ts');
  const from = server.indexOf('export const GATEWAY_FEATURES = [');
  assert.ok(from >= 0, 'GATEWAY_FEATURES is declared in server.ts');
  const advertised = [
    ...quoted(server.slice(from, server.indexOf('].sort()', from))),
    'platform-v1',
  ];
  assert.ok(advertised.length >= 19);
  const format = read('web/lib/format.js');
  const labels = format.slice(
    format.indexOf('const FEATURE_LABELS = {'),
    format.indexOf('export function featureName'),
  );
  const named = quoted(labels);
  assert.deepEqual(
    advertised.filter((id) => !named.includes(id)),
    [],
    'a capability without a name would show as a raw id',
  );
});
