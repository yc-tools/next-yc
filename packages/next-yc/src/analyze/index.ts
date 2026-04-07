import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import { Capabilities } from '../manifest/schema.js';
import { CompatibilityChecker } from '../compat/index.js';

export interface AnalyzeOptions {
  projectPath: string;
  outputDir?: string;
  verbose?: boolean;
}

export type AnalyzeCapabilities = Capabilities;

export class Analyzer {
  private readonly compat: CompatibilityChecker;

  constructor() {
    this.compat = new CompatibilityChecker();
  }

  async analyze(options: AnalyzeOptions): Promise<Capabilities> {
    const { projectPath, outputDir, verbose } = options;

    if (!(await fs.pathExists(projectPath))) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    const nextVersion = await this.detectNextVersion(projectPath);
    const appRouter = await this.detectAppRouter(projectPath);
    const pagesRouter = await this.detectPagesRouter(projectPath);
    const apiRoutes = await this.detectAPIRoutes(projectPath);
    const isr = await this.detectISR(projectPath);
    const middleware = await this.detectMiddleware(projectPath);
    const serverActions = await this.detectServerActions(projectPath);
    const needsImage = await this.detectImageOptimization(projectPath);

    const needsServer = appRouter || apiRoutes || isr.enabled || serverActions;

    const capabilities: Capabilities = {
      nextVersion,
      appRouter,
      pagesRouter,
      needsServer,
      needsImage,
      isr,
      middleware: {
        enabled: middleware,
        mode: middleware ? 'edge-emulated' : 'none',
      },
      serverActions,
      apiRoutes,
      notes: [],
    };

    const compatCheck = this.compat.checkCapabilities(nextVersion, {
      appRouter: capabilities.appRouter,
      pagesRouter: capabilities.pagesRouter,
      isr: capabilities.isr.enabled,
      middleware: capabilities.middleware.enabled,
      serverActions: capabilities.serverActions,
      imageOptimization: capabilities.needsImage,
      apiRoutes: capabilities.apiRoutes,
    });

    if (!compatCheck.compatible) {
      if (verbose) {
        for (const error of compatCheck.errors) {
          console.error(chalk.red(`  ${error}`));
        }
      }
      throw new Error('Project has incompatible features for YC Next.js deployment');
    }

    if (compatCheck.warnings.length > 0) {
      capabilities.notes.push(...compatCheck.warnings);
    }

    if (outputDir) {
      await fs.ensureDir(outputDir);
      await fs.writeJson(path.join(outputDir, 'capabilities.json'), capabilities, { spaces: 2 });

      const projectName = await this.detectProjectName(projectPath);
      await fs.writeJson(path.join(outputDir, 'project.meta.json'), { projectName }, { spaces: 2 });
    }

    if (verbose) {
      this.printCapabilities(capabilities);
    }

    return capabilities;
  }

  private async detectNextVersion(projectPath: string): Promise<string> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(packageJsonPath))) {
      throw new Error('package.json not found in project');
    }

    const packageJson = await fs.readJson(packageJsonPath);
    const versionValue =
      packageJson.dependencies?.['next'] || packageJson.devDependencies?.['next'];

    if (!versionValue) {
      throw new Error('"next" not found in package.json dependencies');
    }

    return String(versionValue).replace(/^[\^~><= ]+/, '');
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

  private async detectAppRouter(projectPath: string): Promise<boolean> {
    const appDir = path.join(projectPath, 'app');
    const srcAppDir = path.join(projectPath, 'src', 'app');
    return (await fs.pathExists(appDir)) || (await fs.pathExists(srcAppDir));
  }

  private async detectPagesRouter(projectPath: string): Promise<boolean> {
    const pagesDir = path.join(projectPath, 'pages');
    const srcPagesDir = path.join(projectPath, 'src', 'pages');
    return (await fs.pathExists(pagesDir)) || (await fs.pathExists(srcPagesDir));
  }

  private async detectAPIRoutes(projectPath: string): Promise<boolean> {
    const candidates = [
      'pages/api',
      'src/pages/api',
      'app/api',
      'src/app/api',
    ];

    for (const candidate of candidates) {
      if (await fs.pathExists(path.join(projectPath, candidate))) {
        return true;
      }
    }

    return false;
  }

  private async detectISR(projectPath: string): Promise<Capabilities['isr']> {
    const buildDir = path.join(projectPath, '.next');
    let enabled = false;
    let onDemand = false;
    let tags = false;
    const paths = false;

    // Check prerender-manifest.json for ISR pages
    const prerenderManifest = path.join(buildDir, 'prerender-manifest.json');
    if (await fs.pathExists(prerenderManifest)) {
      const manifest = await fs.readJson(prerenderManifest);
      const routes = manifest.routes || {};
      for (const route of Object.values(routes) as Array<{ initialRevalidateSeconds?: number }>) {
        if (route.initialRevalidateSeconds && route.initialRevalidateSeconds > 0) {
          enabled = true;
          break;
        }
      }
    }

    // Check source for on-demand revalidation
    onDemand = await this.detectPatternUsage(projectPath, [
      'revalidatePath(',
      'revalidateTag(',
    ]);

    tags = await this.detectPatternUsage(projectPath, ['revalidateTag(']);

    if (onDemand) {
      enabled = true;
    }

    return { enabled, onDemand, tags, paths };
  }

  private async detectMiddleware(projectPath: string): Promise<boolean> {
    const candidates = [
      'middleware.ts',
      'middleware.js',
      'src/middleware.ts',
      'src/middleware.js',
    ];

    for (const candidate of candidates) {
      if (await fs.pathExists(path.join(projectPath, candidate))) {
        return true;
      }
    }

    return false;
  }

  private async detectServerActions(projectPath: string): Promise<boolean> {
    return this.detectPatternUsage(projectPath, ["'use server'", '"use server"']);
  }

  private async detectImageOptimization(projectPath: string): Promise<boolean> {
    return this.detectPatternUsage(projectPath, [
      'next/image',
      '<Image ',
      '<Image\n',
    ]);
  }

  private async detectPatternUsage(projectPath: string, patterns: string[]): Promise<boolean> {
    const files = await glob('**/*.{ts,tsx,js,jsx,mjs}', {
      cwd: projectPath,
      ignore: ['node_modules/**', '.next/**', 'dist/**', 'out/**'],
      nodir: true,
    });

    for (const file of files) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          return true;
        }
      }
    }

    return false;
  }

  private printCapabilities(capabilities: Capabilities): void {
    console.log(chalk.cyan('\n  Next.js Capabilities'));
    console.log(chalk.gray(`  Next.js: ${capabilities.nextVersion}`));
    console.log(chalk.gray(`  App Router: ${capabilities.appRouter ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Pages Router: ${capabilities.pagesRouter ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  API routes: ${capabilities.apiRoutes ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Needs server: ${capabilities.needsServer ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  ISR: ${capabilities.isr.enabled ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Middleware: ${capabilities.middleware.enabled ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Server Actions: ${capabilities.serverActions ? 'yes' : 'no'}`));
    console.log(chalk.gray(`  Image optimization: ${capabilities.needsImage ? 'yes' : 'no'}`));

    if (capabilities.notes.length > 0) {
      console.log(chalk.yellow('\n  Notes:'));
      for (const note of capabilities.notes) {
        console.log(chalk.yellow(`  - ${note}`));
      }
    }
  }
}
