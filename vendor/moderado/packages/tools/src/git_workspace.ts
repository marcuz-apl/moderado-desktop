import { spawn } from 'node:child_process';

export interface GitWorkspaceFile { status: string; path: string; }
export interface GitWorkspaceSummary { isRepository: boolean; branch?: string; ahead?: number; behind?: number; files: GitWorkspaceFile[]; }

function runGit(root: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 100 * 1024) stdout += chunk.toString('utf8'); });
    child.on('error', () => resolve({ code: 128, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

export async function inspectGitWorkspace(root: string): Promise<GitWorkspaceSummary> {
  const result = await runGit(root, ['status', '--porcelain=v1', '--branch']);
  if (result.code !== 0) return { isRepository: false, files: [] };
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: GitWorkspaceFile[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      branch = head.split(/[ .]/, 1)[0];
      const counts = head.match(/ahead (\d+).*behind (\d+)|behind (\d+).*ahead (\d+)/);
      if (counts) { ahead = Number(counts[1] ?? counts[4] ?? 0); behind = Number(counts[2] ?? counts[3] ?? 0); }
      continue;
    }
    if (line.length >= 4) files.push({ status: line.slice(0, 2), path: line.slice(3) });
  }
  return { isRepository: true, branch, ahead, behind, files };
}

export async function readGitDiff(root: string): Promise<string> {
  const result = await runGit(root, ['diff', '--no-ext-diff', '--no-color', '--no-textconv']);
  return result.code === 0 ? result.stdout || '(No git diff changes detected)' : '(Not a Git repository)';
}
