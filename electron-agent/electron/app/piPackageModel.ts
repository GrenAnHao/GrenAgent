export type PackageSource = string | {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};

export type PackageScope = 'product' | 'user' | 'project';

export interface PackageListItem {
  kind: 'builtin' | 'package';
  id: string;
  title: string;
  scope: PackageScope;
  enabled: boolean;
  canDisable: boolean;
  canRemove: boolean;
}

export interface MarketplaceHit {
  name: string;
  version: string;
  description: string;
  publisher: string;
  npmUrl: string;
}

export interface PackageSearchResult {
  objects: MarketplaceHit[];
  total: number;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function sanitizeSearchQuery(input: string): string {
  return input.replace(/[^\p{L}\p{N}\s@/._-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function packageSourceString(entry: PackageSource): string {
  return typeof entry === 'string' ? entry : entry.source;
}

function stripNpmVersion(spec: string): string {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) return spec;
    const rest = spec.slice(slash + 1);
    const at = rest.lastIndexOf('@');
    if (at <= 0) return spec;
    return spec.slice(0, slash + 1 + at);
  }
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export function packageIdentity(source: string): string {
  if (
    source.startsWith('git:')
    || source.startsWith('https:')
    || source.startsWith('ssh:')
    || source.startsWith('file:')
    || source.startsWith('.')
    || source.startsWith('/')
  ) {
    return source;
  }
  const spec = source.startsWith('npm:') ? source.slice(4) : source;
  return `npm:${stripNpmVersion(spec)}`;
}

export function npmNameFromSource(source: string): string {
  const spec = source.startsWith('npm:') ? source.slice(4) : source;
  return stripNpmVersion(spec);
}

export function isPackageEnabled(entry: PackageSource): boolean {
  return typeof entry === 'string' ? true : entry.autoload !== false;
}

function resourceFilters(entry: Extract<PackageSource, object>): Pick<Extract<PackageSource, object>, 'extensions' | 'skills' | 'prompts' | 'themes'> {
  return {
    ...(entry.extensions ? { extensions: entry.extensions } : {}),
    ...(entry.skills ? { skills: entry.skills } : {}),
    ...(entry.prompts ? { prompts: entry.prompts } : {}),
    ...(entry.themes ? { themes: entry.themes } : {}),
  };
}

export function withAutoload(entry: PackageSource, enabled: boolean): PackageSource {
  const source = packageSourceString(entry);
  if (typeof entry === 'object') {
    const filters = resourceFilters(entry);
    if (enabled && Object.keys(filters).length === 0) return source;
    return { source, autoload: enabled, ...filters };
  }
  return enabled ? source : { source, autoload: false };
}

export function replacePackageEntry(packages: PackageSource[], source: string, next: PackageSource): PackageSource[] {
  const identity = packageIdentity(source);
  let found = false;
  const result = packages.map((entry) => {
    if (packageIdentity(packageSourceString(entry)) !== identity) return entry;
    found = true;
    return next;
  });
  if (!found) throw new Error('PACKAGE_NOT_FOUND');
  return result;
}

export function isValidNpmName(name: string): boolean {
  return NPM_NAME.test(name);
}

export function isValidSemver(version: string): boolean {
  return SEMVER.test(version);
}

export function pinNpmSource(name: string, version: string): string {
  return `npm:${name}@${version}`;
}

export function mapNpmSearchPayload(json: unknown): PackageSearchResult {
  if (!json || typeof json !== 'object') throw new Error('invalid npm search payload');
  const root = json as { total?: unknown; objects?: unknown };
  const rawObjects = Array.isArray(root.objects) ? root.objects : [];
  const objects: MarketplaceHit[] = [];
  for (const item of rawObjects) {
    const pkg = item && typeof item === 'object' ? (item as { package?: unknown }).package : undefined;
    if (!pkg || typeof pkg !== 'object') continue;
    const record = pkg as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
      publisher?: { username?: unknown };
    };
    if (typeof record.name !== 'string' || typeof record.version !== 'string') continue;
    objects.push({
      name: record.name,
      version: record.version,
      description: typeof record.description === 'string' ? record.description : '',
      publisher: typeof record.publisher?.username === 'string' ? record.publisher.username : '',
      npmUrl: `https://www.npmjs.com/package/${record.name}`,
    });
  }
  const total = typeof root.total === 'number' && Number.isFinite(root.total) ? root.total : objects.length;
  return { objects, total };
}

export function packageRowTestId(kind: 'builtin' | 'package', id: string): string {
  if (kind === 'builtin') return `package-row-builtin-${id}`;
  return `package-row-${id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

export function truncateError(message: string): string {
  return message.length <= 300 ? message : message.slice(0, 300);
}

export function findRawEntry(packages: PackageSource[] | undefined, source: string): PackageSource | undefined {
  const identity = packageIdentity(source);
  return (packages ?? []).find((entry) => packageIdentity(packageSourceString(entry)) === identity);
}
