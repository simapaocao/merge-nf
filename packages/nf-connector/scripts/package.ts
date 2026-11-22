import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import manifest from "../manifest.json";
import { build, dist, entries } from "./build";

/** Deterministic ZIP/deflate with exactly three allowlisted members. No staging tree, directory walk, shell or external ZIP binary. */
export function zip(files: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const entries: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, centralLength = 0;
  for (const [name, content] of files) {
    const filename = Buffer.from(name), compressed = deflateRawSync(content), checksum = crc32(content) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x0800,6); local.writeUInt16LE(8,8); local.writeUInt16LE(0x21,12); local.writeUInt32LE(checksum,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(content.length,22); local.writeUInt16LE(filename.length,26);
    entries.push(local,filename,compressed);
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50); h.writeUInt16LE(20,4); local.copy(h,6,4,28); h.writeUInt32LE(offset,42);
    central.push(h,filename); centralLength += h.length + filename.length; offset += local.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(centralLength,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...entries,...central,end]);
}
export async function packagePlugin(): Promise<string> {
  await build(); const files = await Promise.all(entries.map(async name => [name, await readFile(join(dist,name))] as const));
  const path = join(dist,`${manifest.pluginId}-${manifest.version}.nfplugin`); await writeFile(path,zip(files)); return path;
}
if (import.meta.main) console.log(await packagePlugin());
