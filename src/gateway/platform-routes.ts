import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerPlatformAdminRoutes } from './platform-admin-routes.js';
import { registerPortalAssets } from './platform-assets.js';
import { registerPortalRoutes } from './platform-portal-routes.js';
import type { PlatformRouteDeps } from './platform-wire.js';

/** 门户的页面与接口路径：不需要 API 密钥（接口自己校验门户会话）。 */
export const isPortalPath = (pathname: string): boolean =>
  pathname === '/portal' || pathname.startsWith('/portal/') || pathname.startsWith('/v1/portal/');

/**
 * onRequest 里、仅在启用平台时调用：返回 true 表示这个请求不再需要 API 密钥鉴权（门户路径），
 * 或已经在这里答复（非控制台域名上的 `GET /` 跳转到门户）。Host 白名单与 Origin 检查在此之前已做完。
 */
export function portalGate(
  req: FastifyRequest,
  reply: FastifyReply,
  pathname: string,
  onConsoleHost: boolean,
): boolean {
  if (pathname === '/' && req.method === 'GET' && !onConsoleHost) {
    reply.code(302).header('Location', '/portal/').send();
    return true;
  }
  return isPortalPath(pathname);
}

/** 平台的全部路由：门户接口、运营者接口与门户静态资源。只在配置了 `platform` 时调用。 */
export function registerPlatform(app: FastifyInstance, deps: PlatformRouteDeps): void {
  registerPortalRoutes(app, deps);
  registerPlatformAdminRoutes(app, deps);
  registerPortalAssets(app);
}
