import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import path from 'path';
import fs from 'fs';

/* ------------------------------------------------------------------ */
/*  Yandex Cloud Functions event / response types                     */
/* ------------------------------------------------------------------ */

export interface APIGatewayProxyEventV2 {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    domainPrefix: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface HandlerOptions {
  dir: string;
  trustProxy?: boolean;
  serverModuleCandidates?: string[];
}

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

export function createServerHandler(options: HandlerOptions) {
  const {
    dir,
    trustProxy = true,
    serverModuleCandidates = [
      'server.js',
      'server.mjs',
      'index.js',
    ],
  } = options;

  const debug = Boolean(process.env.NYC_DEBUG);

  let nodeHandler: NodeRequestHandler | null = null;

  const initialize = async (): Promise<void> => {
    if (nodeHandler) {
      console.log('[Server] Already initialized, skipping');
      return;
    }

    const initStart = Date.now();

    // Next.js standalone server.js starts an HTTP server when imported.
    // We intercept http.createServer to capture the request handler.
    const http = await import('http');
    const originalCreateServer = http.createServer;
    let capturedHandler: NodeRequestHandler | null = null;

    (http as { createServer: typeof http.createServer }).createServer = function (...args: Parameters<typeof http.createServer>) {
      // The first function argument is the request handler
      const handler = args.find((a) => typeof a === 'function') as NodeRequestHandler | undefined;
      if (handler) {
        capturedHandler = handler;
      }
      // Return a dummy server that doesn't actually listen
      const server = originalCreateServer.apply(http, args as never);
      const originalListen = server.listen.bind(server);
      server.listen = function (..._listenArgs: Parameters<typeof server.listen>) {
        console.log(`[Server] Intercepted server.listen(), not binding (+${Date.now() - initStart}ms)`);
        return server;
      } as typeof server.listen;
      // Suppress unhandled listen if called with callback
      void originalListen;
      return server;
    } as typeof http.createServer;

    // Set env to prevent Next.js from binding
    process.env.HOSTNAME = '0.0.0.0';
    process.env.PORT = '0';

    const modulePath = resolveServerModule(dir, serverModuleCandidates);
    console.log(`[Server] Loading module: ${modulePath}`);
    await import(modulePath);
    console.log(`[Server] Module loaded (+${Date.now() - initStart}ms)`);

    // Restore original createServer
    (http as { createServer: typeof http.createServer }).createServer = originalCreateServer;

    if (capturedHandler) {
      nodeHandler = capturedHandler;
      console.log(`[Server] Captured request handler from http.createServer (+${Date.now() - initStart}ms)`);
    } else {
      throw new Error(`Could not capture request handler from ${modulePath}. Ensure the Next.js app uses standalone output mode.`);
    }
  };

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const startTime = Date.now();
    const method = event.requestContext?.http?.method || 'GET';
    const urlPath = event.rawPath || '/';
    const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const requestId = event.requestContext?.requestId || 'unknown';

    console.log(`[Server] --> ${method} ${urlPath}${qs} (reqId: ${requestId})`);
    if (debug) console.log(`[Server] Headers: ${JSON.stringify(event.headers)}`);

    try {
      await initialize();
      console.log(`[Server] Initialized (+${Date.now() - startTime}ms)`);

      if (nodeHandler) {
        console.log(`[Server] Routing to Node handler`);
        const result = await handleViaNode(nodeHandler, event, trustProxy);
        console.log(
          `[Server] <-- ${result.statusCode} ${method} ${urlPath} (body: ${result.body?.length ?? 0} bytes, +${Date.now() - startTime}ms)`,
        );
        return result;
      }

      console.log(`[Server] <-- 404 ${method} ${urlPath} (no handler matched)`);
      return {
        statusCode: 404,
        headers: { 'content-type': 'text/plain' },
        body: 'Not Found',
        isBase64Encoded: false,
      };
    } catch (error) {
      console.error(
        `[Server] <-- 500 ${method} ${urlPath} (+${Date.now() - startTime}ms) Error:`,
        error,
      );
      return {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Internal Server Error',
        isBase64Encoded: false,
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Node.js handler (Next.js standalone server)                       */
/* ------------------------------------------------------------------ */

function handleViaNode(
  handler: NodeRequestHandler,
  event: APIGatewayProxyEventV2,
  trustProxy: boolean,
): Promise<APIGatewayProxyResultV2> {
  const nodeStart = Date.now();
  console.log(
    `[Server:Node] Starting handler for ${event.requestContext.http.method} ${event.rawPath}`,
  );

  return new Promise((resolve, reject) => {
    const req = new IncomingMessage(null as never);
    req.method = event.requestContext.http.method;
    req.url = event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : '');

    req.headers = {};
    for (const [key, value] of Object.entries(event.headers || {})) {
      if (value !== undefined) req.headers[key.toLowerCase()] = value;
    }
    if (event.cookies?.length) {
      req.headers.cookie = event.cookies.join('; ');
    }

    const ip =
      trustProxy && req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : event.requestContext.http.sourceIp;

    const socket = new PassThrough();
    (socket as unknown as Record<string, unknown>).remoteAddress = ip;
    Object.defineProperty(req, 'socket', { value: socket, writable: true });

    const chunks: Buffer[] = [];
    const resHeaders: Record<string, string | string[]> = {};
    let statusCode = 200;

    const res = new ServerResponse(req);

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (code: number, ...args: unknown[]) {
      statusCode = code;
      console.log(`[Server:Node] writeHead(${code}) (+${Date.now() - nodeStart}ms)`);
      return origWriteHead(code, ...(args as []));
    };

    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: number | string | readonly string[]) {
      const v = Array.isArray(value) ? value.map(String) : String(value);
      resHeaders[name.toLowerCase()] = v;
      return origSetHeader(name, v);
    };

    // Do NOT delegate to the real res.write / res.end.
    // ServerResponse without a socket returns false (backpressure) from write(),
    // which causes streams to pause and wait for a 'drain' event
    // that never fires — resulting in a timeout.
    res.write = function (chunk: unknown) {
      if (chunk) {
        const buf = toBuffer(chunk);
        chunks.push(buf);
        console.log(`[Server:Node] write(${buf.length} bytes) (+${Date.now() - nodeStart}ms)`);
      }
      return true; // No backpressure — buffering in memory.
    } as typeof res.write;

    res.end = function (chunk?: unknown) {
      if (chunk) chunks.push(toBuffer(chunk));

      const body = Buffer.concat(chunks);
      const ct = resHeaders['content-type'];
      const isBase64 = shouldBase64Encode(Array.isArray(ct) ? ct[0] : ct);

      // Read res.statusCode as the authoritative source.
      const finalStatusCode = res.statusCode || statusCode;

      console.log(
        `[Server:Node] end() status=${finalStatusCode}, body=${body.length} bytes, content-type=${ct || 'none'} (+${Date.now() - nodeStart}ms)`,
      );

      const result: APIGatewayProxyResultV2 = {
        statusCode: finalStatusCode,
        headers: {},
        body: isBase64 ? body.toString('base64') : body.toString('utf-8'),
        isBase64Encoded: isBase64,
      };

      for (const [key, value] of Object.entries(resHeaders)) {
        if (Array.isArray(value)) {
          result.multiValueHeaders = result.multiValueHeaders || {};
          result.multiValueHeaders[key] = value;
        } else {
          result.headers![key] = value;
        }
      }

      const setCookie = resHeaders['set-cookie'];
      if (setCookie) {
        result.cookies = Array.isArray(setCookie) ? setCookie.map(String) : [String(setCookie)];
      }

      resolve(result);
      return res;
    } as typeof res.end;

    res.on('error', (err) => {
      console.error(
        `[Server:Node] res error: ${err?.message || err} (+${Date.now() - nodeStart}ms)`,
      );
      reject(err);
    });

    // Push body into the Readable stream's internal buffer synchronously.
    if (event.body) {
      const buf = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body, 'utf-8');
      console.log(`[Server:Node] Pushing body (${buf.length} bytes)`);
      req.push(buf);
      req.push(null);
    } else {
      req.push(null);
    }

    console.log(`[Server:Node] Calling handler function...`);
    const maybePromise = handler(req, res);
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      console.log(`[Server:Node] Handler returned a promise`);
      (maybePromise as Promise<unknown>).catch((err) => {
        console.error(
          `[Server:Node] Handler promise rejected: ${err?.message || err} (+${Date.now() - nodeStart}ms)`,
        );
        reject(err);
      });
    } else {
      console.log(`[Server:Node] Handler returned synchronously`);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Shared utilities                                                  */
/* ------------------------------------------------------------------ */

function resolveServerModule(dir: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const fullPath = path.resolve(dir, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  throw new Error(`Could not resolve Next.js server module in ${dir}`);
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function shouldBase64Encode(contentType?: string): boolean {
  if (!contentType) return false;
  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-www-form-urlencoded',
  ];
  return !textTypes.some((type) => contentType.includes(type));
}
