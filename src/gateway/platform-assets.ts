import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Fault } from '../core/util.js';
import { AGENT_ICON_CSP, CONSOLE_CSP, FONT_CACHE, FONT_FILE } from './console-assets.js';

/**
 * 开发者门户的静态资源（只在配置了 `platform` 时注册）：`/portal/` 页面，`web/portal/` 下的
 * `<name>.js` 与 `<name>.css`，以及复用控制台的 `brand.svg`、`icons.js` 与智能体图标。
 * 白名单制，与控制台同样严格；找不到文件一律 404 `not_found`。CSP 与控制台一致。
 * 门户面向公众：它在任何允许的 Host 上都可用（server.ts 的 onRequest 不做控制台域名限制）。
 */
export function registerPortalAssets(app: FastifyInstance): void {
  const web = (relative: string) => new URL(`../../../web/${relative}`, import.meta.url);
  const load = async (url: URL): Promise<Buffer> => {
    try {
      return await readFile(url);
    } catch {
      throw new Fault('not_found', 'Asset not found.', 404);
    }
  };
  const send = async (
    reply: FastifyReply,
    url: URL,
    mime: string,
    csp: string | null = CONSOLE_CSP,
  ) => {
    const body = await load(url);
    if (csp) reply.header('Content-Security-Policy', csp);
    return reply.type(mime).send(body);
  };

  app.get('/portal', async (_req, reply) => reply.redirect('/portal/'));
  app.get('/portal/', async (_req, reply) =>
    send(reply, web('portal/index.html'), 'text/html; charset=utf-8'),
  );
  // Shared with the console: the mark, the icon library and the agent marks.
  app.get('/portal/brand.svg', async (_req, reply) =>
    send(reply, web('brand.svg'), 'image/svg+xml'),
  );
  app.get('/portal/icons.js', async (_req, reply) =>
    send(
      reply,
      new URL('../../../node_modules/lucide/dist/umd/lucide.js', import.meta.url),
      'text/javascript',
      null,
    ),
  );
  app.get('/portal/agents/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[a-z0-9-]{1,48}\.svg$/.test(file)) throw new Fault('not_found', 'Asset not found.', 404);
    return send(reply, web(`agents/${file}`), 'image/svg+xml', AGENT_ICON_CSP);
  });
  // Styles of the portal (web/portal/styles/) and the files it shares with the console
  // (web/shared/: design tokens, fonts, format helpers): only lowercase `name.css` / `name.js`.
  app.get('/portal/styles/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[a-z0-9-]{1,48}\.css$/.test(file)) throw new Fault('not_found', 'Asset not found.', 404);
    return send(reply, web(`portal/styles/${file}`), 'text/css; charset=utf-8');
  });
  app.get('/portal/shared/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const match = /^[a-z0-9-]{1,48}\.(css|js)$/.exec(file);
    if (!match) throw new Fault('not_found', 'Asset not found.', 404);
    return send(
      reply,
      web(`shared/${file}`),
      match[1] === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    );
  });
  app.get('/portal/fonts/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!FONT_FILE.test(file)) throw new Fault('not_found', 'Asset not found.', 404);
    const body = await load(web(`fonts/${file}`));
    return reply.header('Cache-Control', FONT_CACHE).type('font/woff2').send(body);
  });
  // Portal modules and styles: only lowercase `name.js` / `name.css` files in web/portal/.
  app.get('/portal/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const match = /^[a-z0-9-]{1,48}\.(js|css)$/.exec(file);
    if (!match) throw new Fault('not_found', 'Asset not found.', 404);
    return send(
      reply,
      web(`portal/${file}`),
      match[1] === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    );
  });
}
