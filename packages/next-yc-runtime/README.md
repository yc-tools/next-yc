# @yc-tools/next-yc-runtime

Runtime adapters for running Next.js SSR on Yandex Cloud Functions behind API Gateway. Used by the [`@yc-tools/next-yc`](https://www.npmjs.com/package/@yc-tools/next-yc) CLI, which bundles these handlers into the deployed function packages.

## Install

```bash
npm install @yc-tools/next-yc-runtime
```

Requires Node.js >= 20.

## Usage

```js
import { createServerHandler, createImageHandler } from '@yc-tools/next-yc-runtime';

// SSR/API handler: loads the Next.js standalone server (server.js) and
// translates API Gateway v2 events to Node HTTP requests.
export const handler = createServerHandler({
  dir: __dirname,
  trustProxy: true,
  serverModuleCandidates: ['server.js', 'server.mjs'],
});

// Image optimization handler (sharp-based), for /_next/image.
export const imageHandler = createImageHandler({
  cacheBucket: process.env.ASSETS_BUCKET,
  sourcesBucket: process.env.ASSETS_BUCKET,
});
```

Other exports: `createISRCache` / `InMemoryISRCache` / `ISRCacheYDB` (ISR cache stores), `runMiddleware` (Node-emulated middleware runner), `verifyPurgeAuthorization` (HMAC/IP checks for revalidation endpoints).

## Environment variables

| Variable | Purpose |
|---|---|
| `NYC_DEBUG` | Enable verbose per-request logging in the server handler (off by default; one summary line per request is always logged) |
| `NYC_IMAGE_ALLOWED_HOSTS` | Comma-separated allowlist of remote hosts the image handler may fetch (`url=` query param). A leading dot allows subdomains: `.example.com` matches `cdn.example.com`. When unset, remote image URLs are rejected with 403; relative paths (served from `sourcesBucket`) are always allowed. Private, link-local, and cloud-metadata IP ranges are always blocked, and remote responses are capped at 10 MB. |
| `ASSETS_BUCKET` | Object Storage bucket used by the generated function entries for assets, image sources, and the image cache |

## License

MIT
