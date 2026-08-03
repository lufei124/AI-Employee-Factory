import fs from 'fs-extra';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWriteFile(file: string, content: string, mode = 0o600): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, mode);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.remove(temporary).catch(() => undefined);
  }
}
