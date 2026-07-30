import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

/**
 * Writes the `local-server.json` marker (in the Prism data dir) that lets the
 * CLI and desktop tooling discover a running local server. Moved verbatim
 * from server/index.js; the composition root supplies the path and payload.
 */
export async function writeLocalServerMarker(
  markerPath: string,
  marker: Record<string, unknown>,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(markerPath), { recursive: true });
  await fsPromises.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

/**
 * Removes the marker, but only when it still belongs to this process (another
 * concurrently started server may have overwritten it with its own pid).
 */
export async function removeLocalServerMarker(markerPath: string): Promise<void> {
  try {
    const raw = await fsPromises.readFile(markerPath, 'utf8');
    const marker = JSON.parse(raw);
    if (marker.pid && marker.pid !== process.pid) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
  }

  try {
    await fsPromises.unlink(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[WARN] Could not remove local server marker:', (error as Error).message);
    }
  }
}
