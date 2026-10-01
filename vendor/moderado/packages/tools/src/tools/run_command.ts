import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import {
  IToolDefinition,
  RunCommandParams,
  RunCommandParamsSchema,
  ToolExecutionContext,
  ToolResult,
} from '@moderado/contracts';
import { resolveInJail } from '../jail.js';

const SENSITIVE_ENV_VARS = [
  'NVIDIA_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'MODERADO_TOKEN',
];

const MAX_BUFFER_BYTES = 64 * 1024; // 64KB limit per stream

export function getSanitizedEnv(): NodeJS.ProcessEnv {
  const cleanEnv = { ...process.env };
  for (const key of SENSITIVE_ENV_VARS) {
    delete cleanEnv[key];
  }
  return cleanEnv;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export function isLongRunningDevCommand(executable: string, args: string[] = []): boolean {
  const fullCmd = [executable, ...args].join(' ').toLowerCase();
  const devPatterns = [
    /\bvite\b/,
    /\bwebpack-dev-server\b/,
    /\bwebpack\s+serve\b/,
    /\bhttp-server\b/,
    /\blive-server\b/,
    /\bserv(e|ing)\b/,
    /\bnodemon\b/,
    /\bconcurrently\b/,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/,
    /\b(next|remix|astro|nuxt|gatsby)\s+dev\b/,
    /\bnode\s+--watch\b/,
    /\btsx?\s+watch\b/,
    /\b(fastapi|uvicorn)\b.*--reload/,
    /\bflask\s+run\b/,
    /\bpython\b.*-m\s+http\.server/,
  ];
  return devPatterns.some((pattern) => pattern.test(fullCmd));
}

export function detectServerReadiness(output: string): string | null {
  const clean = stripAnsi(output);

  // Common URL patterns (localhost, 127.0.0.1, 0.0.0.0, [::1])
  const urlMatch = clean.match(/(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[\w/-]*)/i);

  // Readiness indicators
  const readyKeywords = [
    /ready in\s+\d+/i,
    /local:\s+https?:\/\//i,
    /network:\s+https?:\/\//i,
    /listening on/i,
    /server running/i,
    /serving http on/i,
    /available on/i,
    /compiled successfully/i,
    /started server on/i,
    /dev server running/i,
    /application is running at/i,
  ];

  const hasIndicator = readyKeywords.some((re) => re.test(clean));

  if (urlMatch && hasIndicator) {
    return urlMatch[1];
  }

  // Fallback: if "Local:" is printed followed by a URL
  const localMatch = clean.match(/Local:\s+(https?:\/\/[^\s]+)/i);
  if (localMatch) {
    return localMatch[1];
  }

  return null;
}

export function splitCommandString(str: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (char === '\\') {
      if (process.platform === 'win32') {
        // On Windows, backslash is a directory separator unless immediately escaping a quote
        const nextChar = str[i + 1];
        if (nextChar === '"' || nextChar === "'") {
          current += nextChar;
          i++;
          continue;
        }
        current += char;
        continue;
      } else {
        // On POSIX, backslash escapes the next character
        if (i + 1 < str.length) {
          current += str[++i];
          continue;
        }
        current += char;
        continue;
      }
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseCommandLine(command: string, args: string[] = []): { executable: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { executable: '', args: [] };
  }

  if (args.length > 0) {
    if (fs.existsSync(trimmed)) {
      return { executable: trimmed, args };
    }
    if (trimmed.includes(' ')) {
      const parts = splitCommandString(trimmed);
      return {
        executable: parts[0] || trimmed,
        args: [...parts.slice(1), ...args],
      };
    }
    return { executable: trimmed, args };
  }

  if (fs.existsSync(trimmed)) {
    return { executable: trimmed, args: [] };
  }

  // Check if command starts with an existing executable path (e.g. unquoted C:\Program Files\nodejs\node.exe)
  const lower = trimmed.toLowerCase();
  for (const ext of ['.exe', '.cmd', '.bat']) {
    const idx = lower.indexOf(ext);
    if (idx !== -1 && (idx + ext.length === trimmed.length || /\s/.test(trimmed[idx + ext.length]))) {
      const candidate = trimmed.slice(0, idx + ext.length);
      if (fs.existsSync(candidate)) {
        const rest = trimmed.slice(idx + ext.length).trim();
        return {
          executable: candidate,
          args: rest ? splitCommandString(rest) : [],
        };
      }
    }
  }

  const parts = splitCommandString(trimmed);
  return {
    executable: parts[0] || trimmed,
    args: parts.slice(1),
  };
}

export const RunCommandTool: IToolDefinition<RunCommandParams> = {
  name: 'run_command',
  description: 'shell alias: execute an external command and argument array with shell: false; shell syntax is not interpreted.',
  requiresApproval: true,
  parametersSchema: RunCommandParamsSchema,

  async execute(params: RunCommandParams, context: ToolExecutionContext): Promise<ToolResult> {
    const cwd = resolveInJail(context.workspaceRoot, '.');
    const { executable, args } = parseCommandLine(params.command, params.args);

    let spawnExec = executable;
    let spawnArgs = args;

    if (process.platform === 'win32') {
      const lower = executable.toLowerCase();
      const isBatch = lower.endsWith('.cmd') || lower.endsWith('.bat');
      const isCmdBuiltin = ['dir', 'del', 'copy', 'move', 'type', 'mkdir', 'rmdir', 'cls', 'ver', 'vol'].includes(lower);
      const isCommonNodeCmd = ['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'corepack'].includes(lower);

      if (isBatch || isCmdBuiltin || isCommonNodeCmd) {
        spawnExec = process.env.COMSPEC || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', executable, ...args];
      }
    }

    return new Promise((resolve) => {
      const sanitizedEnv = getSanitizedEnv();
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let serverDetected = false;
      let serverUrl: string | null = null;
      let readinessTimer: NodeJS.Timeout | null = null;
      let exitSafetyTimer: NodeJS.Timeout | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spawnExec, spawnArgs, {
          cwd,
          env: sanitizedEnv,
          shell: false,
          windowsHide: true,
        });
      } catch (err: any) {
        return resolve({
          toolName: 'run_command',
          status: 'error',
          output: `Failed to spawn process '${params.command}': ${err.message}`,
        });
      }

      function checkReadiness() {
        if (settled || serverDetected) return;
        const combined = stdoutBuffer + '\n' + stderrBuffer;
        const detected = detectServerReadiness(combined);
        if (detected) {
          serverDetected = true;
          serverUrl = detected;
          // Wait 800ms stabilization window to make sure the process doesn't immediately crash
          readinessTimer = setTimeout(() => {
            if (settled) return;
            if (child.exitCode === null && !child.killed) {
              cleanup();
              try {
                child.stdout?.removeAllListeners('data');
                child.stderr?.removeAllListeners('data');
                child.stdout?.resume();
                child.stderr?.resume();
                child.unref();
              } catch {
                // ignore
              }
              return resolve({
                toolName: 'run_command',
                status: 'success',
                output: `Dev server started and running in background at ${serverUrl}.\n${stripAnsi(stdoutBuffer).trim()}`,
                metadata: {
                  backgrounded: true,
                  serverUrl,
                  pid: child.pid,
                },
              });
            }
          }, 800);
        }
      }

      // Output buffer capture with size capping
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBuffer.length + chunk.length > MAX_BUFFER_BYTES) {
          const allowed = Math.max(0, MAX_BUFFER_BYTES - stdoutBuffer.length);
          stdoutBuffer += chunk.toString('utf8', 0, allowed);
          stdoutTruncated = true;
        } else {
          stdoutBuffer += chunk.toString('utf8');
        }
        checkReadiness();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBuffer.length + chunk.length > MAX_BUFFER_BYTES) {
          const allowed = Math.max(0, MAX_BUFFER_BYTES - stderrBuffer.length);
          stderrBuffer += chunk.toString('utf8', 0, allowed);
          stderrTruncated = true;
        } else {
          stderrBuffer += chunk.toString('utf8');
        }
        checkReadiness();
      });

      const timeoutSecs = typeof params.timeoutSeconds === 'number' && !isNaN(params.timeoutSeconds) ? params.timeoutSeconds : 60;

      // Timeout timer
      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killProcess();
      }, timeoutSecs * 1000);

      // Hard fallback watchdog: force settlement if 'close' never emits (e.g. child leaked pipe handles)
      const forceSettleTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        killProcess();
        let output = stdoutBuffer;
        if (stderrBuffer) output += `\n[stderr]\n${stderrBuffer}`;
        resolve({
          toolName: 'run_command',
          status: 'error',
          output: `Command timed out after ${timeoutSecs} seconds.\n${output.trim()}`,
          metadata: { timedOut: true },
        });
      }, (timeoutSecs + 2) * 1000);

      // Abort signal listener
      const onAbort = () => {
        if (settled) return;
        killProcess();
      };

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      function killProcess() {
        if (process.platform === 'win32' && child.pid) {
          try {
            execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
            return;
          } catch {
            // Process may already be dead
          }
        }
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, 1500);
        } catch {
          // ignore
        }
      }

      function cleanup() {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(forceSettleTimer);
        if (readinessTimer) clearTimeout(readinessTimer);
        if (exitSafetyTimer) clearTimeout(exitSafetyTimer);
        if (context.abortSignal) {
          context.abortSignal.removeEventListener('abort', onAbort);
        }
      }

      function handleClose(code: number | null, signal: NodeJS.Signals | null) {
        if (settled) return;
        cleanup();

        let output = '';
        if (stdoutBuffer) {
          output += stdoutBuffer;
          if (stdoutTruncated) {
            output += '\n... [stdout truncated at 64KB]';
          }
        }
        if (stderrBuffer) {
          if (output) output += '\n';
          output += `[stderr]\n${stderrBuffer}`;
          if (stderrTruncated) {
            output += '\n... [stderr truncated at 64KB]';
          }
        }

        if (timedOut) {
          return resolve({
            toolName: 'run_command',
            status: 'error',
            output: `Command timed out after ${timeoutSecs} seconds.\n${output}`,
            metadata: { timedOut: true },
          });
        }

        if (signal) {
          return resolve({
            toolName: 'run_command',
            status: 'error',
            output: `Command terminated by signal ${signal}.\n${output}`,
            metadata: { signal },
          });
        }

        const isSuccess = code === 0;
        return resolve({
          toolName: 'run_command',
          status: isSuccess ? 'success' : 'error',
          output: output.trim() || `(Process exited with code ${code})`,
          metadata: {
            exitCode: code,
            stdoutTruncated,
            stderrTruncated,
          },
        });
      }

      child.on('error', (err) => {
        cleanup();
        resolve({
          toolName: 'run_command',
          status: 'error',
          output: `Process error while executing '${params.command}': ${err.message}`,
        });
      });

      child.on('exit', (code, signal) => {
        // If stdio 'close' does not fire within 500ms after exit (e.g. grandchild holding pipes), force settle
        if (!settled) {
          exitSafetyTimer = setTimeout(() => {
            if (settled) return;
            handleClose(code ?? 0, signal);
          }, 500);
        }
      });

      child.on('close', (code, signal) => {
        handleClose(code, signal);
      });
    });
  },
};
