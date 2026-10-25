"""Generate the code-native terminal icon, with no image dependencies."""
from pathlib import Path
import struct
import zlib

OUT = Path(__file__).resolve().parents[1] / 'public' / 'icons'
# Integer grid rectangles keep the glyph readable at small sizes and inside
# the maskable icon's central safe area. Coordinates use a 32 x 32 grid.
RECTS = [(9, 11, 11, 13), (11, 13, 13, 15), (13, 15, 15, 17),
         (11, 17, 13, 19), (9, 19, 11, 21), (17, 19, 23, 21)]
BG = (17, 20, 19)
FG = (155, 223, 181)


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def png(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            inside = any(x0 <= x * 32 / size < x1 and y0 <= y * 32 / size < y1
                         for x0, y0, x1, y1 in RECTS)
            rows.extend(FG if inside else BG)
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in [('icon-192.png', 192), ('icon-512.png', 512),
                       ('maskable-512.png', 512), ('apple-touch-icon.png', 180)]:
        (OUT / name).write_bytes(png(size))
    rects = ''.join(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}"/>'
                    for x0, y0, x1, y1 in RECTS)
    (OUT / 'taskmaster.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<rect width="32" height="32" fill="#111413"/>'
        f'<g fill="#9bdfb5">{rects}</g></svg>\n')


if __name__ == '__main__':
    main()
