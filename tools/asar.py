"""Minimal Electron asar reader: list entries and extract files (read-only).

Usage:
  python asar.py list [prefix] [--sizes]
  python asar.py extract <prefix> <dest>
"""
import json
import os
import re
import struct
import sys

ASAR = r"D:\apps\DeepSeek Harness\resources\app.asar"


def load_header(path=ASAR):
    with open(path, "rb") as f:
        head = f.read(16)
        # pickle: [uint32 4][uint32 pickle_payload][uint32 ][uint32 json_size][json bytes]
        pickle_payload = struct.unpack("<I", head[4:8])[0]
        json_size = struct.unpack("<I", head[12:16])[0]
        f.seek(16)
        raw = f.read(json_size)
    text = raw.decode("utf-8", "replace")
    obj, _end = json.JSONDecoder().raw_decode(text)
    return obj, 8 + pickle_payload


def walk(node, prefix=""):
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}{name}"
        if "files" in entry:
            yield from walk(entry, path + "/")
        else:
            yield path, entry


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    header, base = load_header()
    entries = list(walk(header))

    if cmd == "list":
        prefix = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else ""
        sizes = "--sizes" in sys.argv
        total = 0
        for path, entry in entries:
            size = int(entry.get("size", 0))
            total += size
            if path.startswith(prefix):
                if sizes:
                    print(f"{size:>12}  {path}")
                else:
                    print(path)
        print(f"# total files={len(entries)} total_bytes={total} data_start={base}", file=sys.stderr)
        return

    if cmd == "extract":
        prefix = sys.argv[2]
        dest = sys.argv[3]
        include = re.compile(sys.argv[4]) if len(sys.argv) > 4 else None
        skip = re.compile(r"(\.map$|/node_modules/[^@]|/src/)")
        count = 0
        written = 0
        for path, entry in entries:
            if not path.startswith(prefix):
                continue
            if entry.get("unpacked") or skip.search(path):
                continue
            if include is not None and not include.search(path):
                continue
            size = int(entry.get("size", 0))
            if size > 40 * 1024 * 1024:
                print(f"skip huge {size} {path}", file=sys.stderr)
                continue
            out = os.path.join(dest, path.replace("/", os.sep))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(ASAR, "rb") as f:
                f.seek(base + int(entry["offset"]))
                data = f.read(size)
            with open(out, "wb") as g:
                g.write(data)
            count += 1
            written += size
        print(f"extracted {count} files, {written} bytes -> {dest}")
        return

    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
