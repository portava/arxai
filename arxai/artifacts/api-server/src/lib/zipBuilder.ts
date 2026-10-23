// Minimal pure-Node ZIP builder (STORE method, no compression).
// We use this to bundle the small text files in mt5-bridge/ into a
// single downloadable archive without adding an npm dependency.
//
// Format reference: PKWARE APPNOTE.TXT v6.3.4. Sections used:
//   - Local file header  (sig 0x04034b50)
//   - Central directory  (sig 0x02014b50)
//   - End of central dir (sig 0x06054b50)
//
// Files are bytes-as-is (compressionMethod=0 / STORE). All metadata
// (CRC32, sizes) is computed here. ZIP64 is NOT used — fine for our
// small bundle (each file is < 4 GB and we have < 65535 entries).

import { Buffer } from "node:buffer";

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// DOS-format mtime/mdate from a Date.
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  mtime?: Date;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.length;
    const { time, date } = dosDateTime(e.mtime ?? new Date());

    // ── Local file header (30 bytes + name + data) ────────────────────────
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6);       // general purpose flag (UTF-8 names)
    lfh.writeUInt16LE(0, 8);            // compression method (0 = STORE)
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);        // compressed size
    lfh.writeUInt32LE(size, 22);        // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra length

    localChunks.push(lfh, nameBuf, e.data);

    // ── Central directory entry (46 bytes + name) ─────────────────────────
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);    // signature
    cd.writeUInt16LE(0x031e, 4);        // version made by (3 = unix, 0x1e = 3.0)
    cd.writeUInt16LE(20, 6);            // version needed
    cd.writeUInt16LE(0x0800, 8);        // gp flag
    cd.writeUInt16LE(0, 10);            // method
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra
    cd.writeUInt16LE(0, 32);            // comment
    cd.writeUInt16LE(0, 34);            // disk number
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs (regular file 0644), coerced unsigned
    cd.writeUInt32LE(offset, 42);       // offset of LFH

    centralChunks.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + e.data.length;
  }

  const centralStart = offset;
  const centralBody = Buffer.concat(centralChunks);
  const centralSize = centralBody.length;

  // ── End of central directory record (22 bytes) ─────────────────────────
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(localChunks), centralBody, eocd]);
}
