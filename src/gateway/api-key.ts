import { randomBytes } from 'node:crypto';

/** 401 的两种文案（缺少 / 无效），在 core/util.ts 定义，经这里给 auth.ts 用。 */
export { invalidKey, missingKey } from '../core/util.js';

/** 调用方 API 密钥的前缀（与常见平台的 `sk-` 写法一致）；旧的 `oaa_` 密钥按哈希校验，继续有效。 */
export const API_KEY_PREFIX = 'sk-oaa-';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BODY_LENGTH = 48;
/** 62 * 4：大于等于它的字节丢弃，取模无偏。 */
const UNBIASED_LIMIT = 248;

/** 生成一把新的 API 密钥：`sk-oaa-` 加 48 位 base62（约 285 位熵）。 */
export function generateApiKey(): string {
  let body = '';
  while (body.length < BODY_LENGTH) {
    for (const byte of randomBytes(64)) {
      if (byte >= UNBIASED_LIMIT) continue;
      body += ALPHABET[byte % 62];
      if (body.length === BODY_LENGTH) break;
    }
  }
  return API_KEY_PREFIX + body;
}
