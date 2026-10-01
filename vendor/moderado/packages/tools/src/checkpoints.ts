import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { canonicalizeRoot, resolveInJail } from './jail.js';

const EntrySchema = z.object({
  path: z.string().min(1),
  existed: z.boolean(),
  content: z.string().optional(),
  postHash: z.string().min(1).optional(),
});
const CheckpointSchema = z.object({
  workspace: z.string().min(1),
  entries: z.array(EntrySchema).min(1),
});
type Entry = z.infer<typeof EntrySchema>;
type Checkpoint = z.infer<typeof CheckpointSchema>;

const digest = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
const currentDigest = (file: string): string => fs.existsSync(file) ? digest(fs.readFileSync(file)) : 'absent';

export class WorkspaceCheckpointStore {
  constructor(private readonly home = os.homedir()) {}

  private target(root: string, suffix = ''): string {
    const key = crypto.createHash('sha256').update(root).digest('hex');
    return path.join(this.home, '.moderado', 'checkpoints', `${key}${suffix}.json`);
  }

  private writeJson(target: string, value: Checkpoint): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
      fs.renameSync(temp, target);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  private readJson(target: string): Checkpoint {
    const parsed = CheckpointSchema.safeParse(JSON.parse(fs.readFileSync(target, 'utf8')));
    if (!parsed.success) throw new Error(`Invalid Moderado checkpoint: ${parsed.error.message}`);
    return parsed.data;
  }

  private paths(root: string, rawPaths: string[]): { root: string; paths: string[] } {
    const canonicalRoot = canonicalizeRoot(root);
    const paths = rawPaths.map((raw) => path.relative(canonicalRoot, resolveInJail(canonicalRoot, raw)).split(path.sep).join('/'));
    if (new Set(paths).size !== paths.length) throw new Error('Checkpoint paths must be unique.');
    return { root: canonicalRoot, paths };
  }

  capture(root: string, rawPaths: string[]): void {
    const prepared = this.paths(root, rawPaths);
    const entries: Entry[] = prepared.paths.map((relative) => {
      const file = resolveInJail(prepared.root, relative);
      return fs.existsSync(file)
        ? { path: relative, existed: true, content: fs.readFileSync(file).toString('base64') }
        : { path: relative, existed: false };
    });
    this.writeJson(this.target(prepared.root, '.pending'), { workspace: prepared.root, entries });
  }

  recordPostWrite(root: string, rawPaths: string[]): void {
    const prepared = this.paths(root, rawPaths);
    const pending = this.target(prepared.root, '.pending');
    if (!fs.existsSync(pending)) throw new Error('No pending checkpoint exists for this workspace.');
    const checkpoint = this.readJson(pending);
    if (checkpoint.workspace !== prepared.root) throw new Error('Checkpoint workspace does not match the active workspace.');
    if (checkpoint.entries.length !== prepared.paths.length || checkpoint.entries.some((entry) => !prepared.paths.includes(entry.path))) {
      throw new Error('Checkpoint paths do not match the completed mutation.');
    }
    for (const entry of checkpoint.entries) entry.postHash = currentDigest(resolveInJail(prepared.root, entry.path));
    this.writeJson(this.target(prepared.root), checkpoint);
    const redo = this.target(prepared.root, '.redo');
    if (fs.existsSync(redo)) fs.unlinkSync(redo);
    fs.unlinkSync(pending);
  }

  private restore(root: string, sourceSuffix: string, reverseSuffix: string): { restored: string[]; conflicts: string[] } {
    const canonicalRoot = canonicalizeRoot(root);
    const target = this.target(canonicalRoot, sourceSuffix);
    if (!fs.existsSync(target)) return { restored: [], conflicts: [] };
    const checkpoint = this.readJson(target);
    if (checkpoint.workspace !== canonicalRoot) throw new Error('Checkpoint workspace does not match the active workspace.');
    const files = checkpoint.entries.map((entry) => ({ entry, file: resolveInJail(canonicalRoot, entry.path) }));
    const conflicts = files.filter(({ entry, file }) => !entry.postHash || currentDigest(file) !== entry.postHash).map(({ entry }) => entry.path);
    if (conflicts.length) return { restored: [], conflicts };

    const backups = files.map(({ file }) => ({ file, existed: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.readFileSync(file) : undefined }));
    try {
      for (const { entry, file } of files) {
        if (entry.existed) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const temp = `${file}.${crypto.randomUUID()}.tmp`;
          fs.writeFileSync(temp, Buffer.from(entry.content ?? '', 'base64'));
          fs.renameSync(temp, file);
        } else if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    } catch (error) {
      for (const backup of backups) {
        try {
          if (backup.existed) fs.writeFileSync(backup.file, backup.bytes!);
          else if (fs.existsSync(backup.file)) fs.unlinkSync(backup.file);
        } catch { /* preserve the original write error */ }
      }
      throw error;
    }
    const reverse: Checkpoint = {
      workspace: canonicalRoot,
      entries: backups.map(({ file, existed, bytes }) => ({
        path: path.relative(canonicalRoot, file).split(path.sep).join('/'),
        existed,
        content: bytes?.toString('base64'),
        postHash: currentDigest(file),
      })),
    };
    this.writeJson(this.target(canonicalRoot, reverseSuffix), reverse);
    return { restored: checkpoint.entries.map((entry) => entry.path), conflicts: [] };
  }

  /** Restore the last completed mutation and retain a safe redo snapshot. */
  undoLatest(root: string): { restored: string[]; conflicts: string[] } {
    return this.restore(root, '', '.redo');
  }

  /** Reapply the last safely undone mutation and retain a safe undo snapshot. */
  redoLatest(root: string): { restored: string[]; conflicts: string[] } {
    return this.restore(root, '.redo', '');
  }

  /** @deprecated Use undoLatest to make redo available after a restore. */
  restoreLatest(root: string): { restored: string[]; conflicts: string[] } {
    return this.undoLatest(root);
  }
}
