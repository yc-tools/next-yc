import path from 'path';
import fs from 'fs';
import vm from 'vm';

export interface MiddlewareOptions {
  dir: string;
  middlewarePath?: string;
}

export interface MiddlewareResult {
  type: 'next' | 'rewrite' | 'redirect' | 'response';
  status?: number;
  headers?: Record<string, string>;
  rewriteUrl?: string;
  redirectUrl?: string;
  body?: string;
}

export async function runMiddleware(
  options: MiddlewareOptions,
  request: {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
  },
): Promise<MiddlewareResult> {
  const {
    dir,
    middlewarePath = '.next/server/middleware.js',
  } = options;

  const fullPath = path.resolve(dir, middlewarePath);

  if (!fs.existsSync(fullPath)) {
    console.log('[Middleware] No middleware file found, passing through');
    return { type: 'next' };
  }

  try {
    const middlewareCode = fs.readFileSync(fullPath, 'utf-8');

    const sandbox = createEdgeSandbox(request);
    const context = vm.createContext(sandbox);

    const script = new vm.Script(middlewareCode, { filename: 'middleware.js' });
    script.runInContext(context);

    const middlewareHandler = sandbox.__nextMiddleware;
    if (typeof middlewareHandler !== 'function') {
      console.log('[Middleware] No middleware handler exported, passing through');
      return { type: 'next' };
    }

    const webRequest = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers as Record<string, string>),
    });

    const response = await middlewareHandler(webRequest);

    return parseMiddlewareResponse(response);
  } catch (error) {
    console.error('[Middleware] Execution failed, falling back to passthrough:', error);
    return { type: 'next' };
  }
}

function createEdgeSandbox(
  _request: {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
  },
): Record<string, unknown> {
  return {
    // Web standard APIs
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    fetch,
    crypto,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    AbortController,
    AbortSignal,
    ReadableStream,
    WritableStream,
    TransformStream,

    // Next.js middleware export capture
    __nextMiddleware: undefined as unknown,

    // Module system shim
    module: { exports: {} },
    exports: {},
    self: {},
  };
}

function parseMiddlewareResponse(response: unknown): MiddlewareResult {
  if (!response || typeof response !== 'object') {
    return { type: 'next' };
  }

  const res = response as Response;

  // Check for NextResponse.next() — returns 200 with x-middleware-next header
  if (res.headers?.get('x-middleware-next') === '1') {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (!key.startsWith('x-middleware-')) {
        headers[key] = value;
      }
    });
    return { type: 'next', headers };
  }

  // Check for NextResponse.rewrite()
  const rewriteUrl = res.headers?.get('x-middleware-rewrite');
  if (rewriteUrl) {
    return { type: 'rewrite', rewriteUrl };
  }

  // Check for redirect (3xx status)
  const location = res.headers?.get('location');
  if (location && res.status >= 300 && res.status < 400) {
    return {
      type: 'redirect',
      status: res.status,
      redirectUrl: location,
    };
  }

  // Regular response
  return {
    type: 'response',
    status: res.status,
  };
}
