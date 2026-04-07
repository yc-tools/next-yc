import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import semver from 'semver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface VersionEntry {
  range: string;
  label: string;
  features: Record<string, string>;
}

interface CompatMatrix {
  versions: VersionEntry[];
  yandexCloudLimitations?: Record<string, string>;
  runtimeNotes?: string[];
}

export interface CompatCheckResult {
  compatible: boolean;
  errors: string[];
  warnings: string[];
}

export class CompatibilityChecker {
  private matrix: CompatMatrix;

  constructor() {
    const filePath = path.join(__dirname, 'compat.yml');
    const content = fs.readFileSync(filePath, 'utf-8');
    this.matrix = yaml.load(content) as CompatMatrix;
  }

  isVersionSupported(version: string): boolean {
    const normalized = this.normalizeVersion(version);
    if (!normalized) return false;

    return this.matrix.versions.some((entry) => semver.satisfies(normalized, entry.range));
  }

  getFeatureCompatibility(
    version: string,
    feature: string,
  ): string | undefined {
    const normalized = this.normalizeVersion(version);
    if (!normalized) return undefined;

    const entry = this.matrix.versions.find((v) => semver.satisfies(normalized, v.range));
    return entry?.features[feature];
  }

  checkCapabilities(
    version: string,
    features: Record<string, boolean>,
  ): CompatCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!this.isVersionSupported(version)) {
      errors.push(`Next.js version ${version} is not in the supported compatibility matrix`);
      return { compatible: false, errors, warnings };
    }

    for (const [feature, enabled] of Object.entries(features)) {
      if (!enabled) continue;

      const support = this.getFeatureCompatibility(version, feature);

      if (support === 'unsupported') {
        errors.push(`Feature "${feature}" is not supported for Next.js ${version}`);
      } else if (support === 'experimental') {
        warnings.push(`Feature "${feature}" is experimental for Next.js ${version}`);
      } else if (support === 'partial') {
        warnings.push(`Feature "${feature}" has partial support for Next.js ${version}`);
      }
    }

    return {
      compatible: errors.length === 0,
      errors,
      warnings,
    };
  }

  getYCLimitations(): Record<string, string> {
    return this.matrix.yandexCloudLimitations || {};
  }

  getRuntimeNotes(): string[] {
    return this.matrix.runtimeNotes || [];
  }

  private normalizeVersion(version: string): string | null {
    const cleaned = version.replace(/^[\^~><= ]+/, '');
    const parsed = semver.coerce(cleaned);
    return parsed ? parsed.version : null;
  }
}
