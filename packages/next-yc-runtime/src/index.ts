/**
 * @next-yc/runtime - Runtime adapters for Next.js SSR on Yandex Cloud Functions.
 */

export { createServerHandler } from './server-handler.js';
export type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  HandlerOptions,
} from './server-handler.js';

export { createImageHandler } from './image-handler.js';
export type { ImageHandlerOptions } from './image-handler.js';

export { createISRCache, InMemoryISRCache } from './isr/cache.js';
export type {
  CachedResponse,
  ISRCache,
  ISRCacheOptions,
} from './isr/cache.js';

export { ISRCacheYDB } from './isr/cache-ydb.js';
export type { ISRCacheYDBOptions } from './isr/cache-ydb.js';

export { runMiddleware } from './middleware/runner.js';
export type { MiddlewareOptions, MiddlewareResult } from './middleware/runner.js';

export { verifyPurgeAuthorization } from './purge-auth.js';
export type { PurgeAuthConfig, PurgeAuthRequest } from './purge-auth.js';
