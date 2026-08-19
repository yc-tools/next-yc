import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import crypto from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from './server-handler.js';

export interface ImageHandlerOptions {
  cacheBucket?: string;
  sourcesBucket?: string;
  region?: string;
  endpoint?: string;
  maxAge?: number;
  quality?: number;
  formats?: string[];
}

interface ImageParams {
  url: string;
  w?: string;
  q?: string;
}

const AVIF = 'image/avif';
const WEBP = 'image/webp';
const PNG = 'image/png';
const JPEG = 'image/jpeg';
const GIF = 'image/gif';
const SVG = 'image/svg+xml';
const ICO = 'image/x-icon';

const MAX_WIDTH = 3840;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpFactory: ((input: Buffer) => any) | undefined;

export function createImageHandler(options: ImageHandlerOptions = {}) {
  const {
    cacheBucket,
    sourcesBucket,
    region = 'ru-central1',
    endpoint = 'https://storage.yandexcloud.net',
    maxAge = 60 * 60 * 24 * 365,
    quality = 75,
    formats = [AVIF, WEBP],
  } = options;

  const s3Client =
    cacheBucket || sourcesBucket
      ? new S3Client({
          region,
          endpoint,
        })
      : null;

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
      const params = parseImageParams(event.rawQueryString || '');

      if (!params.url) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'text/plain' },
          body: 'Missing required parameter: url',
        };
      }

      let width: number | undefined;
      if (params.w !== undefined) {
        width = Number.parseInt(params.w, 10);
        if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) {
          return {
            statusCode: 400,
            headers: { 'content-type': 'text/plain' },
            body: 'Invalid width parameter',
          };
        }
      }

      let requestedQuality: number | undefined;
      if (params.q !== undefined) {
        requestedQuality = Number.parseInt(params.q, 10);
        if (!Number.isInteger(requestedQuality) || requestedQuality < 1 || requestedQuality > 100) {
          return {
            statusCode: 400,
            headers: { 'content-type': 'text/plain' },
            body: 'Invalid quality parameter',
          };
        }
      }

      if (isRemoteUrl(params.url) && !isAllowedRemoteUrl(params.url)) {
        return {
          statusCode: 403,
          headers: { 'content-type': 'text/plain' },
          body: 'Remote image host not allowed',
        };
      }

      const accept = event.headers.accept || '';
      const cacheKey = generateCacheKey(params, accept);

      if (s3Client && cacheBucket) {
        const cached = await getFromCache(s3Client, cacheBucket, cacheKey);
        if (cached) {
          return cached;
        }
      }

      const sourceImage = await fetchSourceImage(params.url, s3Client, sourcesBucket);
      if (!sourceImage) {
        return {
          statusCode: 404,
          headers: { 'content-type': 'text/plain' },
          body: 'Image not found',
        };
      }

      // SVG and ICO are not raster formats sharp should transcode — pass the
      // original bytes through with their real content type.
      const passthrough = sourceImage.contentType === SVG || sourceImage.contentType === ICO;
      const processed = passthrough
        ? { buffer: sourceImage.buffer, format: sourceImage.contentType }
        : await processImage(sourceImage.buffer, {
            width,
            quality: requestedQuality ?? quality,
            format: detectFormat(sourceImage.contentType, accept, formats),
          });

      const response: APIGatewayProxyResultV2 = {
        statusCode: 200,
        headers: {
          'content-type': processed.format,
          'cache-control': `public, max-age=${maxAge}, immutable`,
          'content-length': String(processed.buffer.length),
        },
        body: processed.buffer.toString('base64'),
        isBase64Encoded: true,
      };

      if (s3Client && cacheBucket) {
        await saveToCache(s3Client, cacheBucket, cacheKey, processed, maxAge);
      }

      return response;
    } catch (error) {
      console.error('[Image] Error:', error);
      return {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Internal Server Error',
      };
    }
  };
}

function parseImageParams(queryString: string): ImageParams {
  const params = new URLSearchParams(queryString);
  return {
    url: params.get('url') || '',
    w: params.get('w') || undefined,
    q: params.get('q') || undefined,
  };
}

function generateCacheKey(params: ImageParams, accept: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(params.url);
  hash.update(params.w || '');
  hash.update(params.q || '');
  hash.update(accept);
  return `_cache/images/${hash.digest('hex')}`;
}

async function getFromCache(
  s3Client: S3Client,
  bucket: string,
  key: string,
): Promise<APIGatewayProxyResultV2 | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      return null;
    }

    const buffer = await streamToBuffer(response.Body as Readable);

    return {
      statusCode: 200,
      headers: {
        'content-type': response.ContentType || JPEG,
        'cache-control': response.CacheControl || 'public, max-age=31536000',
        'content-length': String(buffer.length),
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    const err = error as { name?: string };
    if (err.name !== 'NoSuchKey') {
      console.error('[Image] Cache read error:', error);
    }
    return null;
  }
}

async function saveToCache(
  s3Client: S3Client,
  bucket: string,
  key: string,
  processed: { buffer: Buffer; format: string },
  maxAge: number,
): Promise<void> {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: processed.buffer,
        ContentType: processed.format,
        CacheControl: `public, max-age=${maxAge}`,
      }),
    );
  } catch (error) {
    console.error('[Image] Cache write error:', error);
  }
}

async function fetchSourceImage(
  url: string,
  s3Client: S3Client | null,
  sourcesBucket?: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    if (url.startsWith('/') && s3Client && sourcesBucket) {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: sourcesBucket,
          Key: url.substring(1),
        }),
      );

      if (!response.Body) {
        return null;
      }

      return {
        buffer: await streamToBuffer(response.Body as Readable),
        contentType: response.ContentType || JPEG,
      };
    }

    if (isRemoteUrl(url)) {
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
      if (Number.isInteger(contentLength) && contentLength > MAX_REMOTE_IMAGE_BYTES) {
        console.error(`[Image] Remote image exceeds size limit: ${contentLength} bytes`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
        console.error(`[Image] Remote image exceeds size limit: ${buffer.length} bytes`);
        return null;
      }

      const contentType = response.headers.get('content-type') || JPEG;

      return { buffer, contentType };
    }

    return null;
  } catch (error) {
    console.error('[Image] Source fetch error:', error);
    return null;
  }
}

function isRemoteUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * A remote URL is only allowed when its host matches the NYC_IMAGE_ALLOWED_HOSTS
 * allowlist (comma-separated; a leading dot allows any subdomain, e.g.
 * ".example.com" matches "cdn.example.com"). Hosts in private, link-local, or
 * cloud-metadata IP ranges are always rejected to prevent SSRF (e.g. stealing
 * IAM tokens from the 169.254.169.254 metadata endpoint).
 */
function isAllowedRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isBlockedHost(hostname)) {
    console.error(`[Image] Blocked private/metadata host: ${hostname}`);
    return false;
  }

  const allowlist = (process.env.NYC_IMAGE_ALLOWED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (allowlist.length === 0) {
    console.error(
      '[Image] Remote image URLs are disabled: set NYC_IMAGE_ALLOWED_HOSTS to a ' +
        'comma-separated list of allowed hosts to enable them.',
    );
    return false;
  }

  return allowlist.some((entry) =>
    entry.startsWith('.')
      ? hostname.endsWith(entry) || hostname === entry.slice(1)
      : hostname === entry,
  );
}

function isBlockedHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }

  // IPv6 (URL hostname strips the surrounding brackets)
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (bareHost.includes(':')) {
    const lower = bareHost.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe80:') || // link-local
      lower.startsWith('fc') || // unique-local fc00::/7
      lower.startsWith('fd') ||
      lower.startsWith('::ffff:') // IPv4-mapped
    );
  }

  // IPv4 literal
  const octets = bareHost.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map(Number);
    return (
      a === 0 || // "this" network
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) // private
    );
  }

  return false;
}

async function processImage(
  input: Buffer,
  options: {
    width?: number;
    quality: number;
    format: string;
  },
): Promise<{ buffer: Buffer; format: string }> {
  const sharp = await loadSharp();
  let pipeline = sharp(input);

  if (options.width) {
    pipeline = pipeline.resize(options.width, null, {
      withoutEnlargement: true,
      fit: 'inside',
    });
  }

  switch (options.format) {
    case AVIF:
      pipeline = pipeline.avif({ quality: options.quality });
      break;
    case WEBP:
      pipeline = pipeline.webp({ quality: options.quality });
      break;
    case PNG:
      pipeline = pipeline.png({ quality: options.quality });
      break;
    case JPEG:
    default:
      pipeline = pipeline.jpeg({ quality: options.quality });
      break;
  }

  const buffer = await pipeline.toBuffer();
  return { buffer, format: options.format };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSharp(): Promise<(input: Buffer) => any> {
  if (sharpFactory) {
    return sharpFactory;
  }

  try {
    const module = await import('sharp');
    const sharpExport = module.default;
    if (typeof sharpExport !== 'function') {
      throw new Error('sharp default export is not a function');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sharpFactory = sharpExport as (input: Buffer) => any;
    return sharpFactory;
  } catch (error) {
    throw new Error(
      `Image optimization dependency "sharp" is not available: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function detectFormat(sourceType: string, accept: string, supportedFormats: string[]): string {
  if (sourceType === SVG || sourceType === ICO) {
    return sourceType;
  }

  if (accept.includes(AVIF) && supportedFormats.includes(AVIF)) {
    return AVIF;
  }

  if (accept.includes(WEBP) && supportedFormats.includes(WEBP)) {
    return WEBP;
  }

  return sourceType === PNG || sourceType === GIF ? PNG : JPEG;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
