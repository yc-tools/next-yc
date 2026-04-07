import { z } from 'zod';

export const ISRCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  onDemand: z.boolean(),
  tags: z.boolean(),
  paths: z.boolean(),
});

export const MiddlewareCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['edge-emulated', 'node-fallback', 'none']).default('none'),
});

export const CapabilitiesSchema = z.object({
  nextVersion: z.string(),
  appRouter: z.boolean(),
  pagesRouter: z.boolean(),
  needsServer: z.boolean(),
  needsImage: z.boolean(),
  isr: ISRCapabilitiesSchema,
  middleware: MiddlewareCapabilitiesSchema,
  serverActions: z.boolean(),
  apiRoutes: z.boolean(),
  notes: z.array(z.string()),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ArtifactSchema = z.object({
  zipPath: z.string().optional(),
  localDir: z.string().optional(),
  bucketKeyPrefix: z.string().optional(),
  entry: z.string().optional(),
  env: z.record(z.string()).optional(),
});

export const RoutingSchema = z.object({
  openapiTemplatePath: z.string().optional(),
  openapiInline: z.string().optional(),
  payloadFormat: z.enum(['1.0', '2.0']).default('2.0'),
  staticPaths: z.array(z.string()).default([]),
  apiBasePath: z.string().default('/api'),
  catchAllPath: z.string().default('/{proxy+}'),
});

export const ISRConfigSchema = z.object({
  cache: z.object({
    bucketPrefix: z.string(),
  }),
  ydb: z.object({
    tables: z.object({
      entries: z.string(),
      tags: z.string(),
      locks: z.string(),
    }),
    docapiEndpoint: z.string().optional(),
  }),
  revalidate: z.object({
    endpointPath: z.string(),
    auth: z.enum(['hmac', 'ip-whitelist', 'both']),
  }),
});

export const DeployManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  buildId: z.string(),
  timestamp: z.string().datetime(),
  nextVersion: z.string(),
  projectName: z.string(),
  capabilities: CapabilitiesSchema,
  routing: RoutingSchema,
  artifacts: z.object({
    assets: ArtifactSchema,
    server: ArtifactSchema.optional(),
    image: ArtifactSchema.optional(),
  }),
  isr: ISRConfigSchema.optional(),
  environment: z
    .object({
      variables: z.record(z.string()),
      secrets: z.array(
        z.object({
          name: z.string(),
          lockboxId: z.string().optional(),
          entryKey: z.string().optional(),
        }),
      ),
    })
    .optional(),
  deployment: z.object({
    region: z.string().default('ru-central1'),
    functions: z.object({
      server: z
        .object({
          memory: z.number().default(512),
          timeout: z.number().default(30),
          preparedInstances: z.number().default(0),
        })
        .optional(),
      image: z
        .object({
          memory: z.number().default(256),
          timeout: z.number().default(30),
          preparedInstances: z.number().default(0),
        })
        .optional(),
    }),
  }),
});

export type DeployManifest = z.infer<typeof DeployManifestSchema>;

export function validateManifest(manifest: unknown): DeployManifest {
  return DeployManifestSchema.parse(manifest);
}

export function createDefaultManifest(
  buildId: string,
  projectName: string,
  capabilities: Capabilities,
): DeployManifest {
  const staticPaths = ['/_next/static/{proxy+}', '/public/{proxy+}', '/favicon.ico', '/robots.txt'];

  return {
    schemaVersion: '1.0',
    buildId,
    timestamp: new Date().toISOString(),
    nextVersion: capabilities.nextVersion,
    projectName,
    capabilities,
    routing: {
      payloadFormat: '2.0',
      staticPaths,
      apiBasePath: '/api',
      catchAllPath: '/{proxy+}',
    },
    artifacts: {
      assets: {
        localDir: './artifacts/assets',
        bucketKeyPrefix: '',
      },
      server: capabilities.needsServer
        ? {
            zipPath: './artifacts/server.zip',
            entry: 'index.handler',
            env: {
              NODE_ENV: 'production',
              NYC_BUILD_ID: buildId,
            },
          }
        : undefined,
      image: capabilities.needsImage
        ? {
            zipPath: './artifacts/image.zip',
            entry: 'index.handler',
            env: {
              NODE_ENV: 'production',
            },
          }
        : undefined,
    },
    isr: capabilities.isr.enabled
      ? {
          cache: {
            bucketPrefix: '_cache/isr',
          },
          ydb: {
            tables: {
              entries: 'isr_cache_entries',
              tags: 'isr_cache_tags',
              locks: 'isr_cache_locks',
            },
          },
          revalidate: {
            endpointPath: '/api/__revalidate',
            auth: 'hmac',
          },
        }
      : undefined,
    environment: {
      variables: {},
      secrets: [],
    },
    deployment: {
      region: 'ru-central1',
      functions: {
        server: capabilities.needsServer
          ? {
              memory: 512,
              timeout: 30,
              preparedInstances: 0,
            }
          : undefined,
        image: capabilities.needsImage
          ? {
              memory: 256,
              timeout: 30,
              preparedInstances: 0,
            }
          : undefined,
      },
    },
  };
}
