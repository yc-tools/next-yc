import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import archiver from 'archiver';
import chalk from 'chalk';
import ora from 'ora';
import { Analyzer } from '../analyze/index.js';
import { createDefaultManifest, DeployManifest } from '../manifest/schema.js';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

export interface BuildOptions {
  projectPath: string;
  outputDir: string;
  buildId?: string;
  verbose?: boolean;
  skipBuild?: boolean;
}

export class Builder {
  private readonly analyzer: Analyzer;

  constructor() {
    this.analyzer = new Analyzer();
  }

  async build(options: BuildOptions): Promise<DeployManifest> {
    const spinner = ora();
    const { projectPath, outputDir, verbose } = options;

    try {
      await fs.ensureDir(outputDir);
      const artifactsDir = path.join(outputDir, 'artifacts');
      await fs.ensureDir(artifactsDir);

      if (!options.skipBuild) {
        spinner.start('Building Next.js application...');
        await this.runNextBuild(projectPath);
        spinner.succeed('Next.js build complete');
      }

      spinner.start('Analyzing Next.js capabilities...');
      const capabilities = await this.analyzer.analyze({
        projectPath,
        outputDir,
        verbose: false,
      });
      spinner.succeed('Analysis complete');

      const buildId = options.buildId || await this.detectBuildId(projectPath) || this.generateBuildId();
      const projectName = await this.detectProjectName(projectPath);

      if (verbose) {
        console.log(chalk.gray(`  Build ID: ${buildId}`));
        console.log(chalk.gray(`  Project: ${projectName}`));
      }

      if (capabilities.needsServer) {
        spinner.start('Packaging server function...');
        await this.packageServer(projectPath, artifactsDir, capabilities);
        spinner.succeed('Server function packaged');
      }

      if (capabilities.needsImage) {
        spinner.start('Packaging image optimizer...');
        await this.packageImageOptimizer(artifactsDir);
        spinner.succeed('Image optimizer packaged');
      }

      spinner.start('Copying static assets...');
      await this.copyStaticAssets(projectPath, artifactsDir, buildId);
      spinner.succeed('Static assets copied');

      spinner.start('Generating API Gateway spec...');
      await this.generateOpenAPISpec(outputDir, capabilities);
      spinner.succeed('API Gateway spec generated');

      spinner.start('Creating deployment manifest...');
      const manifest = await this.createManifest(buildId, projectName, capabilities, outputDir);
      spinner.succeed('Deployment manifest created');

      if (verbose) {
        console.log(chalk.green('\n  Build complete!'));
        console.log(chalk.cyan('  Output directory:'), outputDir);
        console.log(chalk.cyan('  Manifest:'), path.join(outputDir, 'deploy.manifest.json'));
      }

      return manifest;
    } catch (error) {
      spinner.fail('Build failed');
      throw error;
    }
  }

  private async runNextBuild(projectPath: string): Promise<void> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(packageJsonPath))) {
      throw new Error('package.json not found in Next.js project');
    }

    const packageJson = await fs.readJson(packageJsonPath);
    const scripts = packageJson.scripts || {};

    if (!scripts.build) {
      throw new Error('No build script found in package.json. Expected "build" script.');
    }

    const { stderr } = await execAsync('npm run build', {
      cwd: projectPath,
      env: { ...process.env, NODE_ENV: 'production' },
    });

    if (stderr && !stderr.toLowerCase().includes('warn')) {
      console.error(chalk.red('Build output:'), stderr);
    }
  }

  private async packageServer(
    projectPath: string,
    artifactsDir: string,
    _capabilities: DeployManifest['capabilities'],
  ): Promise<void> {
    const serverDir = path.join(artifactsDir, 'server');
    await fs.ensureDir(serverDir);

    const runtimeEntryPath = require.resolve('@yc-tools/next-yc-runtime');

    const tempEntryPath = path.join(serverDir, '_entry.mjs');
    const handlerCode = `
import { createServerHandler } from '${runtimeEntryPath.replace(/\\/g, '/')}';

export const handler = createServerHandler({
  dir: __dirname,
  trustProxy: true,
  serverModuleCandidates: [
    'server.js',
    'server.mjs',
    'index.js',
  ],
});
`;
    await fs.writeFile(tempEntryPath, handlerCode.trimStart());

    await this.bundleWithEsbuild(tempEntryPath, path.join(serverDir, 'index.js'), [
      'sharp',
      '@img/*',
    ]);
    await fs.remove(tempEntryPath);

    // Copy Next.js standalone output
    const standaloneDir = path.join(projectPath, '.next', 'standalone');
    if (await fs.pathExists(standaloneDir)) {
      await fs.copy(standaloneDir, serverDir, { overwrite: false });
    } else {
      throw new Error(
        'Next.js standalone output not found. Ensure next.config.js has output: "standalone".',
      );
    }

    // Copy .next/static into the server dir for SSR references
    const staticDir = path.join(projectPath, '.next', 'static');
    if (await fs.pathExists(staticDir)) {
      await fs.copy(staticDir, path.join(serverDir, '.next', 'static'));
    }

    await this.createZipArchive(serverDir, path.join(artifactsDir, 'server.zip'));
    await fs.remove(serverDir);
  }

  private async packageImageOptimizer(artifactsDir: string): Promise<void> {
    const imageDir = path.join(artifactsDir, 'image');
    await fs.ensureDir(imageDir);

    const runtimeEntryPath = require.resolve('@yc-tools/next-yc-runtime');

    const tempEntryPath = path.join(imageDir, '_entry.mjs');
    const handlerCode = `
import { createImageHandler } from '${runtimeEntryPath.replace(/\\/g, '/')}';

export const handler = createImageHandler({
  cacheBucket: process.env.ASSETS_BUCKET,
  sourcesBucket: process.env.ASSETS_BUCKET,
});
`;
    await fs.writeFile(tempEntryPath, handlerCode.trimStart());

    await this.bundleWithEsbuild(tempEntryPath, path.join(imageDir, 'index.js'), ['sharp', '@img/*']);
    await fs.remove(tempEntryPath);

    await this.copySharpPackage(imageDir);

    await this.createZipArchive(imageDir, path.join(artifactsDir, 'image.zip'));
    await fs.remove(imageDir);
  }

  private async bundleWithEsbuild(
    entryPoint: string,
    outfile: string,
    external: string[],
  ): Promise<void> {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      outfile,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      minify: true,
      treeShaking: true,
      external,
      logLevel: 'warning',
    });
  }

  private async copySharpPackage(targetDir: string): Promise<void> {
    const nodeModulesDest = path.join(targetDir, 'node_modules');
    await fs.ensureDir(nodeModulesDest);

    const sharpPkgPath = require.resolve('sharp/package.json');
    const sharpDir = path.dirname(sharpPkgPath);
    await fs.copy(sharpDir, path.join(nodeModulesDest, 'sharp'), { dereference: true });

    const sharpPkg = await fs.readJson(sharpPkgPath);
    const optionalDeps = Object.keys(sharpPkg.optionalDependencies || {});
    for (const dep of optionalDeps) {
      if (!dep.startsWith('@img/')) continue;
      try {
        const depPkgPath = require.resolve(`${dep}/package.json`);
        const depDir = path.dirname(depPkgPath);
        const scope = dep.split('/')[0];
        await fs.ensureDir(path.join(nodeModulesDest, scope));
        await fs.copy(depDir, path.join(nodeModulesDest, dep), { dereference: true });
      } catch {
        // Platform-specific binary not available
      }
    }
  }

  private async copyStaticAssets(
    projectPath: string,
    artifactsDir: string,
    buildId: string,
  ): Promise<void> {
    const assetsDir = path.join(artifactsDir, 'assets');
    await fs.ensureDir(assetsDir);

    // Copy .next/static/ -> assets/_next/static/
    const nextStaticDir = path.join(projectPath, '.next', 'static');
    if (await fs.pathExists(nextStaticDir)) {
      await fs.copy(nextStaticDir, path.join(assetsDir, '_next', 'static'));
    }

    // Copy public/ -> assets/public/
    const publicDir = path.join(projectPath, 'public');
    if (await fs.pathExists(publicDir)) {
      await fs.copy(publicDir, path.join(assetsDir, 'public'));
    }

    await fs.writeFile(path.join(assetsDir, 'BUILD_ID'), buildId);
  }

  private async generateOpenAPISpec(
    outputDir: string,
    capabilities: DeployManifest['capabilities'],
  ): Promise<void> {
    const spec: Record<string, unknown> = {
      openapi: '3.0.0',
      info: {
        title: 'Next.js App API Gateway',
        version: '1.0.0',
      },
      paths: {
        '/_next/static/{proxy+}': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: '_next/static/{proxy}',
              service_account_id: '${var.service_account_id}',
            },
            parameters: [
              {
                name: 'proxy',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
          },
        },
        '/favicon.ico': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: 'public/favicon.ico',
              service_account_id: '${var.service_account_id}',
            },
          },
        },
        '/robots.txt': {
          get: {
            'x-yc-apigateway-integration': {
              type: 'object_storage',
              bucket: '${var.assets_bucket}',
              object: 'public/robots.txt',
              service_account_id: '${var.service_account_id}',
            },
          },
        },
      },
    };

    const paths = spec.paths as Record<string, unknown>;

    if (capabilities.needsImage) {
      paths['/_next/image'] = {
        get: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.image_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '2.0',
          },
          parameters: [
            { name: 'url', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'w', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'q', in: 'query', required: false, schema: { type: 'integer' } },
          ],
        },
      };
    }

    if (capabilities.needsServer) {
      paths['/api/{proxy+}'] = {
        any: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.server_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '2.0',
          },
          parameters: [
            { name: 'proxy', in: 'path', required: false, schema: { type: 'string' } },
          ],
        },
      };

      paths['/{proxy+}'] = {
        any: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.server_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '2.0',
          },
          parameters: [
            { name: 'proxy', in: 'path', required: false, schema: { type: 'string' } },
          ],
        },
      };

      paths['/'] = {
        any: {
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: '${var.server_function_id}',
            service_account_id: '${var.service_account_id}',
            payload_format_version: '2.0',
          },
        },
      };
    }

    await fs.writeJson(path.join(outputDir, 'openapi-template.json'), spec, { spaces: 2 });
  }

  private async createManifest(
    buildId: string,
    projectName: string,
    capabilities: DeployManifest['capabilities'],
    outputDir: string,
  ): Promise<DeployManifest> {
    const manifest = createDefaultManifest(buildId, projectName, capabilities);
    manifest.routing.openapiTemplatePath = './openapi-template.json';

    const manifestPath = path.join(outputDir, 'deploy.manifest.json');
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    return manifest;
  }

  private async detectBuildId(projectPath: string): Promise<string | null> {
    const buildIdPath = path.join(projectPath, '.next', 'BUILD_ID');
    if (await fs.pathExists(buildIdPath)) {
      return (await fs.readFile(buildIdPath, 'utf-8')).trim();
    }
    return null;
  }

  private async detectProjectName(projectPath: string): Promise<string> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      if (typeof packageJson.name === 'string' && packageJson.name.length > 0) {
        return packageJson.name;
      }
    }
    return path.basename(projectPath);
  }

  private generateBuildId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `build-${timestamp}-${random}`;
  }

  private async createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 9 },
      });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(sourceDir, false);
      void archive.finalize();
    });
  }
}
