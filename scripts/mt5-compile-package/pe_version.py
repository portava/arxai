#!/usr/bin/env python3
"""Print the file and product version of a Windows PE file (e.g. metaeditor64.exe).

Reads the VS_FIXEDFILEINFO block from the file's bytes. It never executes the file.
Usage: python3 pe_version.py <path-to-exe>
"""
import struct
import sys

SIGNATURE = struct.pack("<I", 0xFEEF04BD)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pe_version.py <path-to-exe>", file=sys.stderr)
        return 2
    with open(sys.argv[1], "rb") as handle:
        data = handle.read()
    at = data.find(SIGNATURE)
    if at < 0:
        print("no VS_FIXEDFILEINFO block found", file=sys.stderr)
        return 1
    _sig, _struct_ver, file_ms, file_ls, prod_ms, prod_ls = struct.unpack_from("<6I", data, at)

    def fmt(ms: int, ls: int) -> str:
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"

    print(f"FileVersion={fmt(file_ms, file_ls)}")
    print(f"ProductVersion={fmt(prod_ms, prod_ls)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
