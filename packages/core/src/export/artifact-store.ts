import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretBox } from '../secret-box';

/**
 * Where finished export files wait for their download (Master Spec §15).
 *
 * A file of numbers is analytics content, so it is kept only as long as the
 * download needs it and never in the product database (Master Spec §4). On
 * disk it is encrypted and bound to its artifact id; the directory is private
 * to the process, and file names are random, so a directory listing reveals
 * nothing and a stolen file is unreadable without the key.
 */
export class ArtifactStore {
  constructor(private readonly deps: { readonly dir: string; readonly secretBox: SecretBox }) {}

  async write(artifactId: string, content: Buffer): Promise<string> {
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    const storageKey = randomBytes(32).toString('hex');
    await writeFile(this.pathOf(storageKey), this.deps.secretBox.sealBytes(content, artifactId), {
      mode: 0o600,
      flag: 'wx',
    });
    return storageKey;
  }

  async read(artifactId: string, storageKey: string): Promise<Buffer | null> {
    try {
      const sealed = await readFile(this.pathOf(storageKey));
      return this.deps.secretBox.openBytes(sealed, artifactId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.pathOf(storageKey), { force: true });
  }

  /**
   * Files older than `olderThan` that no record points to - left behind if a
   * process stopped between writing a file and recording it.
   */
  async orphans(known: ReadonlySet<string>, olderThan: Date): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const orphans: string[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name) || known.has(name)) continue;
      const info = await stat(path.join(this.deps.dir, name)).catch(() => null);
      if (info && info.mtime < olderThan) orphans.push(name);
    }
    return orphans;
  }

  async exists(storageKey: string): Promise<boolean> {
    return stat(this.pathOf(storageKey)).then(
      () => true,
      () => false,
    );
  }

  private pathOf(storageKey: string): string {
    if (!/^[0-9a-f]{64}$/.test(storageKey)) throw new Error('Invalid storage key.');
    return path.join(this.deps.dir, storageKey);
  }
}
