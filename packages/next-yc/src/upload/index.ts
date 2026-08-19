import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import ora from 'ora';

export interface UploadOptions {
  buildDir: string;
  assetsBucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

const UPLOAD_CONCURRENCY = 8;

export class Uploader {
  constructor(private s3Client?: S3Client) {}

  async upload(options: UploadOptions): Promise<void> {
    const spinner = ora();
    const {
      buildDir,
      assetsBucket,
      region = 'ru-central1',
      endpoint = 'https://storage.yandexcloud.net',
      accessKeyId,
      secretAccessKey,
      verbose,
      dryRun,
    } = options;

    if (!this.s3Client && !dryRun) {
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          'Object Storage credentials are required for upload. Set NYC_STORAGE_ACCESS_KEY/' +
            'NYC_STORAGE_SECRET_KEY (or YC_ACCESS_KEY/YC_SECRET_KEY, or AWS_ACCESS_KEY_ID/' +
            'AWS_SECRET_ACCESS_KEY), or config "storageAccessKey"/"storageSecretKey".',
        );
      }

      this.s3Client = new S3Client({
        region,
        endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }

    try {
      if (!(await fs.pathExists(buildDir))) {
        throw new Error(`Build directory not found: ${buildDir}`);
      }

      spinner.start('Uploading static assets...');
      const assetsDir = path.join(buildDir, 'artifacts', 'assets');
      if (await fs.pathExists(assetsDir)) {
        const uploaded = await this.uploadDirectory(assetsDir, assetsBucket, '', dryRun, verbose);
        spinner.succeed(
          dryRun
            ? `Would upload ${uploaded.length} asset files`
            : `Uploaded ${uploaded.length} asset files`,
        );
      } else {
        spinner.warn('No static assets found');
      }

      const functionZips = [
        { file: 'server.zip', key: 'functions/server.zip' },
        { file: 'image.zip', key: 'functions/image.zip' },
      ];

      for (const { file, key } of functionZips) {
        const zipPath = path.join(buildDir, 'artifacts', file);
        if (await fs.pathExists(zipPath)) {
          spinner.start(`Uploading ${file}...`);
          if (!dryRun) {
            await this.uploadFile(zipPath, assetsBucket, key);
          }
          spinner.succeed(dryRun ? `Would upload ${file}` : `Uploaded ${file}`);
          if (verbose) {
            console.log(chalk.gray(`  -> s3://${assetsBucket}/${key}`));
          }
        }
      }

      const manifestPath = path.join(buildDir, 'deploy.manifest.json');
      if (await fs.pathExists(manifestPath)) {
        spinner.start('Uploading deployment manifest...');
        if (!dryRun) {
          await this.uploadFile(manifestPath, assetsBucket, 'manifest.json');
        }
        spinner.succeed(
          dryRun ? 'Would upload deployment manifest' : 'Uploaded deployment manifest',
        );
      }

      if (dryRun) {
        console.log(chalk.yellow('\nDry run mode enabled. No files were uploaded.'));
      } else {
        console.log(chalk.cyan('\nUpload summary:'));
        console.log(chalk.gray(`  Assets bucket: ${assetsBucket}`));
      }
    } catch (error) {
      spinner.fail('Upload failed');
      throw error;
    }
  }

  private async uploadDirectory(
    localDir: string,
    bucket: string,
    s3Prefix: string,
    dryRun?: boolean,
    verbose?: boolean,
  ): Promise<string[]> {
    const files = await glob('**/*', {
      cwd: localDir,
      nodir: true,
    });

    const uploaded: string[] = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++];
        const localPath = path.join(localDir, file);
        const s3Key = s3Prefix ? `${s3Prefix}/${file}` : file;

        if (!dryRun) {
          await this.uploadFile(localPath, bucket, s3Key);
        }

        uploaded.push(s3Key);
        if (verbose) {
          console.log(chalk.gray(dryRun ? `  Would upload: ${file}` : `  Uploaded: ${file}`));
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, files.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return uploaded;
  }

  private async uploadFile(localPath: string, bucket: string, key: string): Promise<void> {
    const fileStream = fs.createReadStream(localPath);

    const ext = path.extname(localPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.txt': 'text/plain',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.map': 'application/json',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    let cacheControl = 'public, max-age=3600';

    if (this.isImmutableAsset(key)) {
      cacheControl = 'public, max-age=31536000, immutable';
    } else if (ext === '.html') {
      cacheControl = 'public, max-age=0, must-revalidate';
    }

    const upload = new Upload({
      client: this.s3Client!,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: contentType,
        CacheControl: cacheControl,
        Metadata: {
          'upload-timestamp': new Date().toISOString(),
        },
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });

    await upload.done();
  }

  private isImmutableAsset(key: string): boolean {
    // Next.js hashed assets in _next/static/
    if (key.includes('_next/static/')) {
      return true;
    }

    // Hashed filenames
    const filename = path.basename(key);
    if (/\.[a-f0-9]{8,}\./i.test(filename)) {
      return true;
    }

    return false;
  }
}
