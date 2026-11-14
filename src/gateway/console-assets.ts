import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Fault } from '../core/util.js';

/** 控制台页面与脚本的 CSP：没有内联脚本与内联样式；门户沿用同一条。 */
export const CONSOLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** 智能体图标（SVG）的 CSP：不加载任何东西，只允许图里自带的样式。 */
export const AGENT_ICON_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/**
 * The icon library script (lucide.js), found with Node's own package resolution. A global
 * `npm install -g` keeps lucide in this package's node_modules, but npx and project installs hoist
 * it next to the package, so a fixed ../../../node_modules path would miss it.
 */
export const lucideScriptUrl = (): URL =>
  pathToFileURL(
    path.join(
      path.dirname(createRequire(import.meta.url).resolve('lucide/package.json')),
      'dist',
      'umd',
      'lucide.js',
    ),
  );

/** 字体文件名白名单（`web/fonts/`）与缓存头：同名文件内容不变，可以缓存一年。 */
export const FONT_FILE = /^[a-z0-9-]{1,64}\.woff2$/;
export const FONT_CACHE = 'public, max-age=31536000, immutable';

/**
 * 控制台的静态资源：页面、脚本模块、样式、智能体图标与图标库。白名单制——只提供这里登记的
 * 文件与受限文件名的模块，其余路径一律 404。「只在控制台域名上提供」的判断在 server.ts 的
 * onRequest 里。
 */
export function registerConsoleAssets(app: FastifyInstance): void {
  const assets: { [route: string]: { file: string; mime: string } } = {
    '/': { file: 'index.html', mime: 'text/html; charset=utf-8' },
    '/boot.js': { file: 'boot.js', mime: 'text/javascript; charset=utf-8' },
    '/console.js': { file: 'console.js', mime: 'text/javascript; charset=utf-8' },
    '/run-inspector.js': { file: 'run-inspector.js', mime: 'text/javascript; charset=utf-8' },
    '/console.css': { file: 'console.css', mime: 'text/css; charset=utf-8' },
    '/brand.svg': { file: 'brand.svg', mime: 'image/svg+xml' },
  };
  for (const [route, asset] of Object.entries(assets))
    app.get(route, async (_req, reply) => {
      reply.header('Content-Security-Policy', CONSOLE_CSP);
      return reply
        .type(asset.mime)
        .send(await readFile(new URL(`../../../web/${asset.file}`, import.meta.url)));
    });
  // Console ES modules (web/lib, web/views, web/dialogs): only lowercase `name.js` files.
  for (const dir of ['lib', 'views', 'dialogs'])
    app.get(`/${dir}/:file`, async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (!/^[a-z0-9-]{1,48}\.js$/.test(file))
        throw new Fault('not_found', 'Asset not found.', 404);
      let body: Buffer;
      try {
        body = await readFile(new URL(`../../../web/${dir}/${file}`, import.meta.url));
      } catch {
        throw new Fault('not_found', 'Asset not found.', 404);
      }
      reply.header('Content-Security-Policy', CONSOLE_CSP);
      return reply.type('text/javascript; charset=utf-8').send(body);
    });
  // Styles: `console.css` only @imports `web/shared/` and `web/styles/` files. Shared files
  // (design tokens, fonts, format helpers) are also served to the portal under `/portal/shared/`.
  for (const [dir, pattern] of [
    ['styles', /^[a-z0-9-]{1,48}\.css$/],
    ['shared', /^[a-z0-9-]{1,48}\.(?:css|js)$/],
  ] as const)
    app.get(`/${dir}/:file`, async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (!pattern.test(file)) throw new Fault('not_found', 'Asset not found.', 404);
      let body: Buffer;
      try {
        body = await readFile(new URL(`../../../web/${dir}/${file}`, import.meta.url));
      } catch {
        throw new Fault('not_found', 'Asset not found.', 404);
      }
      reply.header('Content-Security-Policy', CONSOLE_CSP);
      return reply
        .type(file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8')
        .send(body);
    });
  // Web fonts (web/fonts/*.woff2, OFL; see THIRD_PARTY_NOTICES.md). File names never change under
  // the same name, so they cache for a year.
  app.get('/fonts/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!FONT_FILE.test(file)) throw new Fault('not_found', 'Asset not found.', 404);
    let body: Buffer;
    try {
      body = await readFile(new URL(`../../../web/fonts/${file}`, import.meta.url));
    } catch {
      throw new Fault('not_found', 'Asset not found.', 404);
    }
    return reply.header('Cache-Control', FONT_CACHE).type('font/woff2').send(body);
  });
  // Agent identification marks for the console (web/agents/*.svg, see THIRD_PARTY_NOTICES.md).
  app.get('/agents/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[a-z0-9-]{1,48}\.svg$/.test(file)) throw new Fault('not_found', 'Asset not found.', 404);
    let body: Buffer;
    try {
      body = await readFile(new URL(`../../../web/agents/${file}`, import.meta.url));
    } catch {
      throw new Fault('not_found', 'Asset not found.', 404);
    }
    reply.header('Content-Security-Policy', AGENT_ICON_CSP);
    return reply.type('image/svg+xml').send(body);
  });
  app.get('/icons.js', async (_req, reply) =>
    reply.type('text/javascript').send(await readFile(lucideScriptUrl())),
  );
}
