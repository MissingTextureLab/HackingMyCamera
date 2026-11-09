// The gallery's storage: every photo and recording goes to OPFS (the origin's
// private file system), so it survives reloads and a video never has to sit in
// RAM. Where OPFS is missing the files live in memory for the session.

export interface Capture {
  name: string;
  video: boolean;
  size: number;
  /** ms since epoch */
  time: number;
  file: File;
}

const memory = new Map<string, File>();
let dirPromise: Promise<FileSystemDirectoryHandle | null> | undefined;

function dir() {
  dirPromise ??= (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle('captures', { create: true });
    } catch {
      return null;
    }
  })();
  return dirPromise;
}

const isVideo = (name: string) => name.endsWith('.mp4');

/** Asks the browser not to evict the files under storage pressure (best effort, once). */
let persisted = false;
function persist() {
  if (persisted) return;
  persisted = true;
  navigator.storage?.persist?.().catch(() => {});
}

export async function saveCapture(blob: Blob, name: string): Promise<Capture> {
  const d = await dir();
  let file: File;
  if (d) {
    try {
      const handle = await d.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      file = await handle.getFile();
      persist();
      return toCapture(file);
    } catch {
      // quota or a missing API: keep it in memory instead of losing it
    }
  }
  file = new File([blob], name, { type: blob.type, lastModified: Date.now() });
  memory.set(name, file);
  return toCapture(file);
}

const toCapture = (file: File): Capture => ({
  name: file.name,
  video: isVideo(file.name),
  size: file.size,
  time: file.lastModified,
  file,
});

/** Newest first. */
export async function listCaptures(): Promise<Capture[]> {
  const files = new Map<string, File>(memory);
  const d = await dir();
  if (d) {
    try {
      const entries = (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
      for await (const [name, handle] of entries) {
        if (handle.kind === 'file') files.set(name, await (handle as FileSystemFileHandle).getFile());
      }
    } catch {}
  }
  return [...files.values()].map(toCapture).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
}

export async function removeCapture(name: string) {
  memory.delete(name);
  try {
    await (await dir())?.removeEntry(name);
  } catch {}
}

export async function clearCaptures() {
  for (const c of await listCaptures()) await removeCapture(c.name);
}

/** Highest HMC-NNNN number on disk, so names keep counting after the counter is lost. */
export function numberOf(name: string) {
  const m = /^HMC-(\d+)\./.exec(name);
  return m ? Number(m[1]) : 0;
}
