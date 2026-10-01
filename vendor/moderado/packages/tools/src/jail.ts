import fs from 'node:fs';
import path from 'node:path';
import { SecurityViolationError } from './errors.js';

const SENSITIVE_PATTERNS = [
  /^\.git([\\/]|$)/i,
  /^\.env(\.[a-zA-Z0-9_\-]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_[a-zA-Z0-9_]+/i,
  /credentials\.json$/i,
];

/**
 * Normalizes Windows/WSL path representations to the platform/workspace-appropriate format.
 *
 * Supported conversions:
 * - \\?\C:\... -> C:\... (Windows verbatim disk namespace)
 * - \\wsl$\<distro>\mnt\<drive>\... or //wsl$/... -> <drive>:\...
 * - \\wsl.localhost\<distro>\mnt\<drive>\... -> <drive>:\...
 * - /mnt/<drive>/... -> <drive>:\... (when running on Windows or against a Windows drive root)
 * - <drive>:\... -> /mnt/<drive>/... (when running on POSIX/WSL against a POSIX root)
 * - \\wsl$\<distro>\<path> -> <path> (when referenceRoot is a POSIX root matching <path>)
 * - Drive letters are normalized to uppercase on Windows.
 */
export function normalizeCrossPlatformPath(targetPath: string, referenceRoot?: string): string {
  if (!targetPath || typeof targetPath !== 'string') {
    return targetPath;
  }

  let p = targetPath.trim();
  if (p === '') {
    return p;
  }

  // Strip Windows extended-length prefix (\\?\ or //?/)
  if (p.startsWith('\\\\?\\UNC\\') || p.startsWith('//?/UNC/')) {
    p = '\\\\' + p.slice(8);
  } else if (p.startsWith('\\\\?\\') || p.startsWith('//?/')) {
    p = p.slice(4);
  }

  const isWin = process.platform === 'win32';
  const rootIsDrive = referenceRoot ? /^[a-zA-Z]:/i.test(referenceRoot) : isWin;

  // 1. Check WSL UNC path: \\wsl$\<distro>\... or \\wsl.localhost\<distro>\... (also //)
  const wslUncMatch = p.match(/^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i);
  if (wslUncMatch) {
    const subPath = wslUncMatch[3] || '';
    const mntMatch = subPath.match(/^[\\/]mnt[\\/]([a-zA-Z])([\\/].*)?$/i);
    if (mntMatch) {
      // Points to a Windows drive mount inside WSL (e.g. \\wsl$\Ubuntu\mnt\c\...)
      const drive = mntMatch[1].toUpperCase() + ':';
      const rest = mntMatch[2] ? mntMatch[2].replace(/\//g, '\\') : '\\';
      if (rootIsDrive) {
        return `${drive}${rest}`;
      }
      return `/mnt/${mntMatch[1].toLowerCase()}${mntMatch[2] ? mntMatch[2].replace(/\\/g, '/') : ''}`;
    }

    // It's a Linux path inside the WSL distro (e.g. \\wsl$\Ubuntu\home\alice\...)
    if (!rootIsDrive && referenceRoot && !referenceRoot.startsWith('\\\\')) {
      return subPath ? subPath.replace(/\\/g, '/') : '/';
    }

    if (referenceRoot) {
      const refWsl = referenceRoot.match(/^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i);
      if (refWsl) {
        const canonicalPrefix = `\\\\${refWsl[1]}\\${refWsl[2]}`;
        const rest = subPath ? subPath.replace(/\//g, '\\') : '';
        return `${canonicalPrefix}${rest}`;
      }
    }
    return p;
  }

  // 2. Check WSL /mnt/<drive>/... (or \mnt\<drive>\...)
  const mntMatch = p.match(/^[\\/]mnt[\\/]([a-zA-Z])([\\/].*)?$/i);
  if (mntMatch) {
    if (rootIsDrive) {
      const drive = mntMatch[1].toUpperCase() + ':';
      const rest = mntMatch[2] ? mntMatch[2].replace(/\//g, '\\') : '\\';
      return `${drive}${rest}`;
    }
    const drive = mntMatch[1].toLowerCase();
    const rest = mntMatch[2] ? mntMatch[2].replace(/\\/g, '/') : '';
    return `/mnt/${drive}${rest}`;
  }

  // 3. Check Windows drive letter: C:\... or C:/...
  const driveMatch = p.match(/^([a-zA-Z]):([\\/].*)?$/);
  if (driveMatch) {
    if (!rootIsDrive && referenceRoot && !referenceRoot.startsWith('\\\\')) {
      // Map to /mnt/<drive>/... for POSIX/WSL reference root
      const drive = driveMatch[1].toLowerCase();
      const rest = driveMatch[2] ? driveMatch[2].replace(/\\/g, '/') : '';
      return `/mnt/${drive}${rest}`;
    }
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2] ? driveMatch[2].replace(/\//g, '\\') : '\\';
    return `${drive}:${rest}`;
  }

  // 4. POSIX absolute path when referenceRoot is a WSL UNC path
  if (p.startsWith('/') && referenceRoot) {
    const refWsl = referenceRoot.match(/^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i);
    if (refWsl) {
      return `\\\\${refWsl[1]}\\${refWsl[2]}${p.replace(/\//g, '\\')}`;
    }
  }

  return p;
}

export function isProtectedPath(relativePath: string): boolean {
  if (!relativePath || relativePath.trim() === '') {
    return false;
  }

  // Strip Windows NTFS Alternate Data Streams suffix like ::$DATA
  const cleanPath = relativePath.replace(/::\$[a-zA-Z0-9_]+$/i, '');
  const segments = cleanPath.split(/[\\/]/).filter(Boolean);

  // Check if any segment is .git (case-insensitive for Windows/WSL)
  if (segments.some(s => s.toLowerCase() === '.git')) {
    return true;
  }

  // Check each segment against sensitive patterns
  for (const segment of segments) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(segment)) {
        return true;
      }
    }
  }

  const basename = path.basename(cleanPath);
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(cleanPath) || pattern.test(basename)) {
      return true;
    }
  }

  return false;
}

function normalizeDriveLetter(p: string): string {
  if (/^[a-zA-Z]:/.test(p)) {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

function isContainedInRoot(root: string, target: string): boolean {
  if (root === target) {
    return true;
  }

  if (process.platform === 'win32') {
    const rootNorm = root.toLowerCase().replace(/[\\/]+$/, '');
    const targetNorm = target.toLowerCase().replace(/[\\/]+$/, '');
    if (rootNorm === targetNorm) {
      return true;
    }
    return targetNorm.startsWith(rootNorm + '\\') || targetNorm.startsWith(rootNorm + '/');
  }

  const rootNorm = root.replace(/[\\/]+$/, '');
  const targetNorm = target.replace(/[\\/]+$/, '');
  return targetNorm.startsWith(rootNorm + path.sep);
}

export function canonicalizeRoot(workspaceRoot: string): string {
  if (!workspaceRoot || workspaceRoot.trim() === '') {
    throw new SecurityViolationError('Workspace root cannot be empty.');
  }

  const normalized = normalizeCrossPlatformPath(workspaceRoot);
  if (!fs.existsSync(normalized)) {
    throw new SecurityViolationError(`Workspace root directory does not exist: '${workspaceRoot}'`);
  }
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new SecurityViolationError(`Workspace root is not a directory: '${workspaceRoot}'`);
  }
  const canonical = fs.realpathSync(normalized);
  return normalizeDriveLetter(canonical);
}

export function resolveInJail(workspaceRoot: string, targetPath: string): string {
  if (!targetPath || targetPath.trim() === '') {
    throw new SecurityViolationError('Path argument cannot be empty.');
  }

  const canonicalRoot = canonicalizeRoot(workspaceRoot);
  const normalizedTarget = normalizeCrossPlatformPath(targetPath, canonicalRoot);
  let absoluteTarget = path.resolve(canonicalRoot, normalizedTarget);

  if (process.platform === 'win32') {
    absoluteTarget = normalizeDriveLetter(absoluteTarget);
  }

  // Pre-check containment before touching filesystem/network to prevent
  // Windows SMB timeout hangs and NetNTLM hash leaks on malicious UNC paths.
  if (!isContainedInRoot(canonicalRoot, absoluteTarget)) {
    throw new SecurityViolationError(
      `Access denied: path '${targetPath}' resolves to '${absoluteTarget}', which escapes workspace jail '${canonicalRoot}'.`
    );
  }

  // Check if target exists; if so, resolve canonical symlinks
  let canonicalTarget: string;
  if (fs.existsSync(absoluteTarget)) {
    canonicalTarget = fs.realpathSync(absoluteTarget);
  } else {
    // For non-existent paths (e.g. write_file to new file), resolve the deepest existing parent
    let currentDir = path.dirname(absoluteTarget);
    const uncreatedSegments: string[] = [path.basename(absoluteTarget)];

    while (!fs.existsSync(currentDir)) {
      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        break;
      }
      uncreatedSegments.unshift(path.basename(currentDir));
      currentDir = parent;
    }

    if (fs.existsSync(currentDir)) {
      const canonicalParent = fs.realpathSync(currentDir);
      canonicalTarget = path.resolve(canonicalParent, ...uncreatedSegments);
    } else {
      canonicalTarget = absoluteTarget;
    }
  }

  if (process.platform === 'win32') {
    canonicalTarget = normalizeDriveLetter(canonicalTarget);
  }

  // Jail containment check (guards against symlink escapes)
  if (!isContainedInRoot(canonicalRoot, canonicalTarget)) {
    throw new SecurityViolationError(
      `Access denied: path '${targetPath}' resolves to '${canonicalTarget}', which escapes workspace jail '${canonicalRoot}'.`
    );
  }

  // Relative path from canonical root to check protected file blacklist
  const relativeFromRoot = path.relative(canonicalRoot, canonicalTarget);
  if (isProtectedPath(relativeFromRoot)) {
    throw new SecurityViolationError(
      `Access denied: path '${targetPath}' refers to protected or sensitive metadata.`
    );
  }

  return canonicalTarget;
}
