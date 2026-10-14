"""Draw the extension's code-native audio mark with no external image dependency."""
import struct, zlib
from pathlib import Path

def png(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            nx, ny = (x + .5) / size, (y + .5) / size
            corner_x = max(.17 - nx, nx - .83, 0)
            corner_y = max(.17 - ny, ny - .83, 0)
            inside = corner_x * corner_x + corner_y * corner_y < .17 * .17
            color = (41, 70, 52, 255) if inside else (0, 0, 0, 0)
            for cx, h in [(0.27, .18), (.385, .38), (.5, .56), (.615, .32), (.73, .16)]:
                if abs(nx - cx) < .027 and abs(ny - .5) < h / 2:
                    color = (210, 233, 187, 255)
            rows.extend(color)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

for size in [16, 32, 48, 128]:
    Path(f'public/icon-{size}.png').write_bytes(png(size))
