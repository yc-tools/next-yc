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

interface SourcePatternFlags {
  onDemand: boolean;
  tags: boolean;
  serverActions: boolean;
  needsImage: boolean;
}

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
    const sourcePatterns = await this.detectSourcePatterns(projectPath);
    const isr = await this.detectISR(projectPath, sourcePatterns);
    const middleware = await this.detectMiddleware(projectPath);
    const serverActions = sourcePatterns.serverActions;
    const needsImage = sourcePatterns.needsImage;

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
      for (const error of compatCheck.errors) {
        console.error(chalk.red(`  ${error}`));
      }
      throw new Error(
        `Project has incompatible features for YC Next.js deployment:\n${compatCheck.errors
          .map((error) => `  - ${error}`)
          .join('\n')}`,
      );
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

  private async detectISR(
    projectPath: string,
    sourcePatterns: SourcePatternFlags,
  ): Promise<Capabilities['isr']> {
    const buildDir = path.join(projectPath, '.next');
    let enabled = false;

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

    const { onDemand, tags } = sourcePatterns;
    if (onDemand) {
      enabled = true;
    }

    return { enabled, onDemand, tags, paths: false };
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

  private async detectSourcePatterns(projectPath: string): Promise<SourcePatternFlags> {
    const patternGroups: Record<keyof SourcePatternFlags, string[]> = {
      onDemand: ['revalidatePath(', 'revalidateTag('],
      tags: ['revalidateTag('],
      serverActions: ["'use server'", '"use server"'],
      needsImage: ['next/image', '<Image ', '<Image\n'],
    };

    const flags: SourcePatternFlags = {
      onDemand: false,
      tags: false,
      serverActions: false,
      needsImage: false,
    };

    const files = await glob('**/*.{ts,tsx,js,jsx,mjs}', {
      cwd: projectPath,
      ignore: ['node_modules/**', '.next/**', 'dist/**', 'out/**'],
      nodir: true,
    });

    const keys = Object.keys(patternGroups) as Array<keyof SourcePatternFlags>;

    for (const file of files) {
      if (keys.every((key) => flags[key])) {
        break;
      }

      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      for (const key of keys) {
        if (!flags[key] && patternGroups[key].some((pattern) => content.includes(pattern))) {
          flags[key] = true;
        }
      }
    }

    return flags;
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
