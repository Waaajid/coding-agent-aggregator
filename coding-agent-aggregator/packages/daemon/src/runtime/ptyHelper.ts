import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let done = false;

/**
 * node-pty's prebuilt `spawn-helper` (macOS) can lose its executable bit when the package manager extracts it,
 * which makes every PTY spawn fail with `posix_spawnp failed`. Repair it once, before the first spawn.
 */
export function ensurePtyHelperExecutable(): void {
  if (done || process.platform === 'win32') return;
  done = true;
  try {
    const pkgDir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
    for (const dir of [join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`), join(pkgDir, 'build', 'Release')]) {
      const helper = join(dir, 'spawn-helper');
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch {
    /* best effort; the spawn error will surface the real problem */
  }
}
