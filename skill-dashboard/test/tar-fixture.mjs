/** One ustar archive fixture, shared by the pure and route-level archive tests. */

/**
 * Build one tar archive from `{ path, text?, type? }` entries.
 *
 * The checksum is written because real archives carry one, even though the
 * reader does not verify it; directories, links and PAX headers are produced by
 * passing `type`. A 1 KiB zero block terminates the archive.
 *
 * @param {{ path: string, text?: string, type?: string }[]} entries - entries in order.
 * @returns {Buffer} the tar bytes.
 */
export function tarArchive(entries) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? '', 'utf8')
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'latin1')
    header.write('0000000\0', 108, 8, 'latin1')
    header.write('0000000\0', 116, 8, 'latin1')
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
    header.write('00000000000\0', 136, 12, 'latin1')
    header.write('        ', 148, 8, 'latin1')
    header.write(entry.type ?? '0', 156, 1, 'latin1')
    header.write('ustar\0', 257, 6, 'latin1')
    header.write('00', 263, 2, 'latin1')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
