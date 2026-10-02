import { spawn } from 'node:child_process';

/**
 * Credential resolution against the shared Windows Credential Manager targets.
 *
 * The reference format is the CLI's: `moderado/provider/<normalized-id>`. The
 * normalization must match byte for byte, or Desktop would read a different
 * target than the CLI wrote and silently fail to find the key.
 */
export interface CredentialStore {
  get(reference: string): Promise<string | undefined>;
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

/** In-memory store for tests; never touches the real keychain. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  async get(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }
  async set(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret);
  }
  async delete(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

/**
 * The CLI's normalization, reproduced exactly.
 *
 * Trims, lowercases, and replaces every run of characters outside `[a-z0-9_-]`
 * with a single hyphen. A provider id that normalizes to nothing is an error
 * rather than a target that could collide with another.
 */
export function credentialReference(providerId: string): string {
  const safeId = providerId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!safeId) throw new Error('Provider ID is required for credential storage.');
  return `moderado/provider/${safeId}`;
}

/**
 * Resolves a key in the CLI's precedence order: environment, then credential
 * reference, then a legacy plaintext value.
 */
export async function resolveCredential(
  environment: string | undefined,
  reference: string | undefined,
  legacy: string | undefined,
  store: CredentialStore,
): Promise<string | undefined> {
  if (environment?.trim()) return environment.trim();
  if (reference) {
    const stored = await store.get(reference);
    if (stored?.trim()) return stored;
  }
  return legacy?.trim() || undefined;
}

/** True on a platform that has a Windows Credential Manager. */
export function credentialManagerAvailable(): boolean {
  return process.platform === 'win32';
}

/**
 * Real Windows Credential Manager access.
 *
 * Implemented as a child `powershell.exe` running an encoded bridge, spawned
 * with `shell: false`. The key is passed only on stdin and never appears in an
 * argument or a command line where another process could read it.
 */
export class WindowsCredentialStore implements CredentialStore {
  constructor(
    private readonly run: BridgeRunner = defaultRunner,
  ) {}

  async get(reference: string): Promise<string | undefined> {
    const parsed = JSON.parse(await this.invoke('get', reference)) as { secret?: unknown };
    return typeof parsed.secret === 'string' ? parsed.secret : undefined;
  }

  async set(reference: string, secret: string): Promise<void> {
    await this.invoke('set', reference, secret);
  }

  async delete(reference: string): Promise<void> {
    await this.invoke('delete', reference);
  }

  private async invoke(
    operation: 'get' | 'set' | 'delete',
    reference: string,
    secret?: string,
  ): Promise<string> {
    try {
      const result = await this.run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedBridge()],
        JSON.stringify({ operation, reference, secret }),
      );
      if (!result.stdout.trim()) throw new Error(result.stderr);
      return result.stdout;
    } catch {
      // Never echo the secret or the reference into an error message.
      throw new Error(
        'Windows Credential Manager operation failed. Set the provider environment variable to continue.',
      );
    }
  }
}

export type BridgeRunner = (
  file: string,
  args: string[],
  input: string,
) => Promise<{ stdout: string; stderr: string }>;

const BRIDGE_SOURCE = [
  "Add-Type @'",
  'using System;using System.Runtime.InteropServices;',
  'public static class ModeradoCred{',
  '[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct C{public UInt32 Flags,Type;public string TargetName,Comment;public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;public UInt32 CredentialBlobSize;public IntPtr CredentialBlob;public UInt32 Persist,AttributeCount;public IntPtr Attributes;public string TargetAlias,UserName;}',
  '[DllImport("Advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredRead(string t,UInt32 y,UInt32 f,out IntPtr c);',
  '[DllImport("Advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredWrite(ref C c,UInt32 f);',
  '[DllImport("Advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredDelete(string t,UInt32 y,UInt32 f);',
  '[DllImport("Advapi32.dll")]public static extern void CredFree(IntPtr b);}',
  "'@;",
  '$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;',
  'try{',
  'if($r.operation -eq "get"){',
  '$p=[IntPtr]::Zero;',
  'if(-not [ModeradoCred]::CredRead($r.reference,1,0,[ref]$p)){[Console]::Out.Write(\'{"ok":true}\');exit 0};',
  'try{$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][ModeradoCred+C]);',
  '$s=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,[int]($c.CredentialBlobSize/2));',
  '[Console]::Out.Write((@{ok=$true;secret=$s}|ConvertTo-Json -Compress))}',
  'finally{[ModeradoCred]::CredFree($p)}}',
  'elseif($r.operation -eq "set"){',
  '$b=[Text.Encoding]::Unicode.GetBytes($r.secret);',
  '$p=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length);',
  'try{[Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length);',
  '$c=New-Object ModeradoCred+C;$c.Type=1;$c.TargetName=$r.reference;$c.CredentialBlobSize=$b.Length;$c.CredentialBlob=$p;$c.Persist=2;$c.UserName="Moderado";',
  'if(-not [ModeradoCred]::CredWrite([ref]$c,0)){throw "write"};[Console]::Out.Write(\'{"ok":true}\')}',
  'finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($p)}}',
  'else{[ModeradoCred]::CredDelete($r.reference,1,0)|Out-Null;[Console]::Out.Write(\'{"ok":true}\')}',
  '}catch{[Console]::Error.Write($_.Exception.Message);exit 1}',
].join('\n');

function encodedBridge(): string {
  return Buffer.from(BRIDGE_SOURCE, 'utf16le').toString('base64');
}

const defaultRunner: BridgeRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(stderr || `PowerShell exited with ${code}`)),
    );
    child.stdin.end(input);
  });