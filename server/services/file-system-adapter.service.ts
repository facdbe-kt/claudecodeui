/**
 * File-system adapter: a single interface over local fs vs. a remote host.
 *
 * Local projects keep using the exact same code paths as before (the adapter's
 * local implementation delegates to the same `fs.promises` logic the HTTP
 * handlers used inline). Remote (`project_type === 'remote'`) projects route
 * file reads/writes through SFTP and the file tree through ONE `find` exec call
 * (the test hosts only ship coreutils — no node/rg — so the tree cannot be built
 * with N SFTP round-trips per directory).
 *
 * Every consumer obtains an adapter via {@link getFileSystemAdapter}, which
 * inspects the project row and returns the local or remote implementation.
 */

import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import posix from 'path/posix';

import type { SFTPWrapper, Stats } from 'ssh2';

import { projectsDb } from '@/modules/database/index.js';
import { sshConnectionManager } from '@/services/ssh-connection-manager.service.js';
import { rowToRemoteConfig } from '@/shared/remote-project.js';
import type { RemoteProjectConfig } from '@/shared/types.js';

// ---------------------------------------------------------------------------
// FileEntry shape — MUST match server/index.js getFileTree node shape exactly
// (name, path, type, size, modified, permissions, permissionsRwx, isSymlink?,
//  children?). The client tree renderer relies on these fields, so the remote
// adapter reproduces them byte-for-byte.
// ---------------------------------------------------------------------------

/** A single node in the project file tree. Mirrors getFileTree's output. */
export type FileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileEntry[];
};

/** Stat result returned by the adapter (POSIX/portable subset). */
export type AdapterStat = {
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
};

/** Options for {@link IFileSystemAdapter.mkdir}. */
export type MkdirOptions = {
  recursive?: boolean;
};

/**
 * Uniform file-system surface used by the per-project file APIs. Implemented by
 * {@link LocalFileSystemAdapter} (delegates to `fs.promises`) and
 * {@link RemoteFileSystemAdapter} (SFTP + a single `find` exec for the tree).
 */
export interface IFileSystemAdapter {
  readTree(rootPath: string, maxDepth: number, showHidden: boolean): Promise<FileEntry[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  mkdir(dirPath: string, opts?: MkdirOptions): Promise<void>;
  stat(targetPath: string): Promise<AdapterStat>;
  exists(targetPath: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Shared helpers (kept in sync with server/index.js getFileTree output)
// ---------------------------------------------------------------------------

/** Directories skipped when building the tree (mirrors index.js IGNORED_DIRS). */
const IGNORED_DIRS = new Set([
  // JS / TS toolchains
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  // VCS
  '.git', '.svn', '.hg',
  // Python
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  // Rust / Go / Java / Ruby
  'target', 'vendor',
  // Build output / IDE
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

/** Renders a single octal permission digit as rwx (mirrors index.js permToRwx). */
function permToRwx(perm: number): string {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

/** Splits a POSIX mode into the index.js `permissions` + `permissionsRwx` pair. */
function modeToPermissions(mode: number): { permissions: string; permissionsRwx: string } {
  const ownerPerm = (mode >> 6) & 7;
  const groupPerm = (mode >> 3) & 7;
  const otherPerm = mode & 7;
  return {
    permissions:
      ownerPerm.toString() + groupPerm.toString() + otherPerm.toString(),
    permissionsRwx:
      permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm),
  };
}

/** Sort: directories first, then case-insensitive name order (mirrors index.js). */
function sortEntries(items: FileEntry[]): FileEntry[] {
  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Local adapter
// ---------------------------------------------------------------------------

/**
 * Local file-system adapter. Wraps `fs.promises`. `readTree` re-implements the
 * exact getFileTree logic (same node shape, IGNORED_DIRS, sort) so local output
 * is unchanged from before this adapter existed.
 */
export class LocalFileSystemAdapter implements IFileSystemAdapter {
  async readTree(
    rootPath: string,
    maxDepth: number,
    showHidden: boolean
  ): Promise<FileEntry[]> {
    return this.buildTree(rootPath, maxDepth, 0, showHidden);
  }

  private async buildTree(
    dirPath: string,
    maxDepth: number,
    currentDepth: number,
    showHidden: boolean
  ): Promise<FileEntry[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') {
        console.error('Error reading directory:', error);
      }
      return [];
    }

    const filtered = entries.filter(
      (entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name))
    );

    const items = await Promise.all(
      filtered.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item: FileEntry = {
          name: entry.name,
          path: itemPath,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: 0,
          modified: null,
          permissions: '000',
          permissionsRwx: '---------',
        };

        try {
          const stats = await fsPromises.lstat(itemPath);
          item.size = stats.size;
          item.modified = stats.mtime.toISOString();
          if (stats.isSymbolicLink()) {
            item.isSymlink = true;
          }
          const { permissions, permissionsRwx } = modeToPermissions(stats.mode);
          item.permissions = permissions;
          item.permissionsRwx = permissionsRwx;
        } catch {
          // Leave the default values populated above.
        }

        if (entry.isDirectory() && currentDepth < maxDepth) {
          item.children = await this.buildTree(
            itemPath,
            maxDepth,
            currentDepth + 1,
            showHidden
          );
        }

        return item;
      })
    );

    return sortEntries(items);
  }

  async readFile(filePath: string): Promise<string> {
    return fsPromises.readFile(filePath, 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fsPromises.writeFile(filePath, content, 'utf8');
  }

  async mkdir(dirPath: string, opts?: MkdirOptions): Promise<void> {
    await fsPromises.mkdir(dirPath, { recursive: opts?.recursive ?? false });
  }

  async stat(targetPath: string): Promise<AdapterStat> {
    const stats = await fsPromises.stat(targetPath);
    return {
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async exists(targetPath: string): Promise<boolean> {
    try {
      await fsPromises.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Remote adapter
// ---------------------------------------------------------------------------

/** SFTP STATUS_CODE values (numeric) we map to fs-style errno errors. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/**
 * Wraps a raw SFTP error into a Node-style error carrying a `.code`
 * (ENOENT/EACCES) so callers can branch the same way they do for local fs.
 */
function mapSftpError(err: unknown, fallbackPath: string): NodeJS.ErrnoException {
  const e = err as (Error & { code?: number }) | undefined;
  const code = e?.code;
  if (code === SFTP_NO_SUCH_FILE) {
    const mapped = new Error(
      `ENOENT: no such file or directory, '${fallbackPath}'`
    ) as NodeJS.ErrnoException;
    mapped.code = 'ENOENT';
    return mapped;
  }
  if (code === SFTP_PERMISSION_DENIED) {
    const mapped = new Error(
      `EACCES: permission denied, '${fallbackPath}'`
    ) as NodeJS.ErrnoException;
    mapped.code = 'EACCES';
    return mapped;
  }
  const mapped = new Error(
    e?.message ?? `SFTP operation failed for '${fallbackPath}'`
  ) as NodeJS.ErrnoException;
  return mapped;
}

/**
 * Remote file-system adapter backed by a single pooled SSH connection
 * (`sshConnectionManager.getConnection(projectId)`). File reads/writes go over
 * an SFTP session; the file tree is built with ONE `find` exec call to avoid N
 * SFTP round-trips on high-latency links and hosts that only have coreutils.
 */
export class RemoteFileSystemAdapter implements IFileSystemAdapter {
  private readonly projectId: string;
  private readonly config: RemoteProjectConfig;

  constructor(projectId: string) {
    this.projectId = projectId;
    const row = projectsDb.getProjectById(projectId);
    if (!row) {
      throw new Error(`Project ${projectId} not found.`);
    }
    if (row.project_type !== 'remote') {
      throw new Error(`Project ${projectId} is not a remote project.`);
    }
    // Shared mapper — keeps the remote_* column → config mapping in one place.
    this.config = rowToRemoteConfig(row);
  }

  // -------------------------------------------------------------------------
  // Shell-arg safety. Every path passed to `find` is single-quoted, but we also
  // refuse control chars and shell metacharacters defensively so a crafted path
  // can never break out of the quoting.
  // -------------------------------------------------------------------------

  private static assertShellSafe(value: string): void {
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Path contains control characters.');
    }
    if (value.includes('`') || value.includes('$(') || value.includes("'")) {
      throw new Error('Path contains shell metacharacters.');
    }
  }

  private static shellQuote(value: string): string {
    return `'${value}'`;
  }

  /**
   * readTree: ONE exec of `find -maxdepth N` (coreutils only). We request a
   * stable, parseable line format and rebuild the SAME nested FileEntry shape as
   * the local tree. This is the exec-first optimization: a single round-trip for
   * the whole subtree instead of one SFTP readdir+stat per directory.
   */
  async readTree(
    rootPath: string,
    maxDepth: number,
    showHidden: boolean
  ): Promise<FileEntry[]> {
    RemoteFileSystemAdapter.assertShellSafe(rootPath);

    // Normalize the root to drop a trailing slash so child relative paths are
    // computed against a stable prefix.
    const root = rootPath.length > 1 ? rootPath.replace(/\/+$/, '') : rootPath;
    const quotedRoot = RemoteFileSystemAdapter.shellQuote(root);

    // -maxdepth is depth FROM the root (root itself is depth 0); the local tree
    // includes `maxDepth` levels of descendants, so find needs maxDepth+1.
    const findDepth = Math.max(1, maxDepth + 1);

    // %y = type (d/f/l/...), %m = octal mode, %s = size, %T@ = mtime (epoch s),
    // %p = full path. NUL-terminate fields and records so any byte (except NUL,
    // which paths can't contain) survives parsing. -mindepth 1 skips the root.
    const fmt = '%y\\0%m\\0%s\\0%T@\\0%p\\0\\0';
    const command =
      `find ${quotedRoot} -mindepth 1 -maxdepth ${findDepth} -printf ${RemoteFileSystemAdapter.shellQuote(fmt)}`;

    const result = await sshConnectionManager.execCommand(
      this.projectId,
      command,
      this.config
    );
    if (result.code !== 0 && result.stdout.length === 0) {
      const message = result.stderr.trim() || 'Failed to list remote directory.';
      const err = new Error(message) as NodeJS.ErrnoException;
      if (/no such file/i.test(message)) err.code = 'ENOENT';
      else if (/permission denied/i.test(message)) err.code = 'EACCES';
      throw err;
    }

    return this.parseFindOutput(result.stdout, root, maxDepth, showHidden);
  }

  /**
   * Parses the NUL-delimited `find -printf` stream into the nested FileEntry
   * tree. Records are `type\0mode\0size\0mtime\0path\0\0`. Paths arrive in
   * arbitrary order, so we index nodes by absolute path and link children to
   * parents in a second pass.
   */
  private parseFindOutput(
    stdout: string,
    root: string,
    maxDepth: number,
    showHidden: boolean
  ): FileEntry[] {
    const records = stdout.split('\x00\x00');
    const nodeByPath = new Map<string, FileEntry>();
    const childrenByParent = new Map<string, FileEntry[]>();
    const roots: FileEntry[] = [];

    for (const record of records) {
      if (record.length === 0) continue;
      const fields = record.split('\x00');
      if (fields.length < 5) continue;
      const [typeChar, modeStr, sizeStr, mtimeStr, fullPath] = fields;
      if (!fullPath) continue;

      const name = posix.basename(fullPath);
      if (!showHidden && name.startsWith('.')) continue;

      const isDirectory = typeChar === 'd';
      // Mirror the local tree: skip ignored directories entirely.
      if (isDirectory && IGNORED_DIRS.has(name)) continue;

      // Depth from the root: 1 == direct child. find used maxDepth+1, so the
      // last visible level (maxDepth) should not advertise empty children.
      const rel = posix.relative(root, fullPath);
      const depth = rel.length === 0 ? 0 : rel.split('/').length;
      if (depth > maxDepth + 1) continue;

      const mode = Number.parseInt(modeStr, 8);
      const { permissions, permissionsRwx } = Number.isFinite(mode)
        ? modeToPermissions(mode)
        : { permissions: '000', permissionsRwx: '---------' };
      const mtimeSeconds = Number.parseFloat(mtimeStr);
      const modified = Number.isFinite(mtimeSeconds)
        ? new Date(mtimeSeconds * 1000).toISOString()
        : null;

      const item: FileEntry = {
        name,
        path: fullPath,
        type: isDirectory ? 'directory' : 'file',
        size: Number.parseInt(sizeStr, 10) || 0,
        modified,
        permissions,
        permissionsRwx,
      };
      if (typeChar === 'l') {
        item.isSymlink = true;
      }
      // Only directories within the descend window may host children.
      if (isDirectory && depth <= maxDepth) {
        item.children = [];
      }

      nodeByPath.set(fullPath, item);
      const parent = posix.dirname(fullPath);
      const bucket = childrenByParent.get(parent);
      if (bucket) bucket.push(item);
      else childrenByParent.set(parent, [item]);
    }

    // Link children to parents; nodes whose parent is the root become roots.
    for (const [parentPath, children] of childrenByParent) {
      if (parentPath === root) {
        roots.push(...children);
        continue;
      }
      const parent = nodeByPath.get(parentPath);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(...children);
      }
    }

    // Sort every level (directories first, then name) to match the local tree.
    const sortRecursive = (entries: FileEntry[]): void => {
      sortEntries(entries);
      for (const entry of entries) {
        if (entry.children && entry.children.length > 0) {
          sortRecursive(entry.children);
        }
      }
    };
    sortRecursive(roots);

    return roots;
  }

  // -------------------------------------------------------------------------
  // SFTP helpers
  // -------------------------------------------------------------------------

  /**
   * Opens a fresh SFTP session over the pooled connection, lazily establishing
   * the connection first if none is live yet. Editor file reads/writes can hit
   * this before any terminal/reconnect has opened a connection, so we connect
   * on demand using the project's own config (idempotent — `connect()` reuses an
   * existing pooled client).
   */
  private async getSftp(): Promise<SFTPWrapper> {
    let connection = sshConnectionManager.getConnection(this.projectId);
    if (!connection) {
      connection = await sshConnectionManager.connect(this.projectId, this.config);
    }
    return new Promise<SFTPWrapper>((resolve, reject) => {
      connection!.client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  async readFile(filePath: string): Promise<string> {
    const sftp = await this.getSftp();
    return new Promise<string>((resolve, reject) => {
      sftp.readFile(filePath, (err, data) => {
        if (err) {
          reject(mapSftpError(err, filePath));
          return;
        }
        resolve(data.toString('utf8'));
      });
    });
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(filePath, content, (err) => {
        if (err) reject(mapSftpError(err, filePath));
        else resolve();
      });
    });
  }

  async mkdir(dirPath: string, opts?: MkdirOptions): Promise<void> {
    const sftp = await this.getSftp();
    if (opts?.recursive) {
      // SFTP mkdir is non-recursive; create each ancestor in turn, ignoring
      // "already exists" failures along the way.
      const segments = dirPath.split('/').filter((s) => s.length > 0);
      const absolute = dirPath.startsWith('/');
      let current = absolute ? '' : '.';
      for (const segment of segments) {
        current = `${current}/${segment}`;
        const target = current;
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          sftp.mkdir(target, () => resolve());
        });
      }
      return;
    }
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => {
        if (err) reject(mapSftpError(err, dirPath));
        else resolve();
      });
    });
  }

  async stat(targetPath: string): Promise<AdapterStat> {
    const sftp = await this.getSftp();
    return new Promise<AdapterStat>((resolve, reject) => {
      sftp.stat(targetPath, (err, stats: Stats) => {
        if (err) {
          reject(mapSftpError(err, targetPath));
          return;
        }
        const mtime = stats.mtime;
        resolve({
          isDirectory: stats.isDirectory(),
          size: stats.size,
          mtimeMs: typeof mtime === 'number' ? mtime * 1000 : 0,
        });
      });
    });
  }

  async exists(targetPath: string): Promise<boolean> {
    const sftp = await this.getSftp();
    return new Promise<boolean>((resolve) => {
      sftp.stat(targetPath, (err) => {
        resolve(!err);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns the file-system adapter for `projectId`: a {@link LocalFileSystemAdapter}
 * for local projects (`project_type !== 'remote'`) and a
 * {@link RemoteFileSystemAdapter} for remote ones. Local projects therefore keep
 * hitting the same fs code path as before.
 */
export function getFileSystemAdapter(projectId: string): IFileSystemAdapter {
  const row = projectsDb.getProjectById(projectId);
  if (row && row.project_type === 'remote') {
    return new RemoteFileSystemAdapter(projectId);
  }
  return new LocalFileSystemAdapter();
}
