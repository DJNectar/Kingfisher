#!/usr/bin/env python3
"""
Draw Kingfisher's app icon and write it as a .icns.

Written by hand because the usual route — draw a PNG, run `iconutil` — needs
macOS, and this has to build anywhere. An .icns is only a container: a magic
word, a length, then one chunk per size holding a PNG. Both that and the PNG
format itself are small enough to write directly, and it keeps the icon
reproducible from source rather than being a binary nobody can regenerate.
"""

import struct
import zlib

# Matched to the app's own palette in src/ui/styles.css.
BG_TOP = (0x1B, 0x1E, 0x24)
BG_BOTTOM = (0x10, 0x12, 0x16)
ACCENT = (0x4A, 0xA3, 0xD8)
ACCENT_DIM = (0x2D, 0x6D, 0x92)

# A waveform, as relative heights. Asymmetric on purpose: a symmetrical one
# reads as a graphic, this reads as a recording.
BARS = [0.22, 0.42, 0.68, 0.95, 0.72, 0.50, 0.85, 0.60, 0.34, 0.18]


def png(width, height, pixels):
    """Encode RGBA rows as a PNG."""
    raw = b''.join(b'\x00' + bytes(row) for row in pixels)

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def blend(under, over, alpha):
    return tuple(round(u + (o - u) * alpha) for u, o in zip(under, over))


def coverage(x, y, inside, samples=3):
    """Anti-aliasing: what fraction of this pixel is inside the shape."""
    hits = 0
    for sy in range(samples):
        for sx in range(samples):
            if inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples):
                hits += 1
    return hits / (samples * samples)


def draw(size):
    """One icon, at one size."""
    # macOS leaves a margin around the art; matching it keeps the icon the same
    # visual weight as every other app in the Dock.
    inset = size * 0.085
    box = size - inset * 2
    radius = box * 0.225

    def in_rounded_rect(px, py):
        x = px - inset
        y = py - inset
        if x < 0 or y < 0 or x > box or y > box:
            return False
        cx = min(max(x, radius), box - radius)
        cy = min(max(y, radius), box - radius)
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2

    bar_area = box * 0.62
    bar_left = inset + (box - bar_area) / 2
    slot = bar_area / len(BARS)
    bar_width = slot * 0.54
    centre_y = inset + box / 2

    bars = []
    for i, height in enumerate(BARS):
        x0 = bar_left + i * slot + (slot - bar_width) / 2
        half = (box * 0.36) * height / 2
        bars.append((x0, x0 + bar_width, centre_y - half, centre_y + half, bar_width / 2))

    def in_bars(px, py):
        for x0, x1, y0, y1, r in bars:
            if x0 <= px <= x1 and y0 <= py <= y1:
                cy = min(max(py, y0 + r), y1 - r)
                if (py - cy) ** 2 <= r ** 2 or y0 + r <= py <= y1 - r:
                    return True
        return False

    rows = []
    for y in range(size):
        row = bytearray()
        # A vertical gradient across the tile, so it is not a flat slab.
        t = y / max(1, size - 1)
        base = blend(BG_TOP, BG_BOTTOM, t)
        for x in range(size):
            tile = coverage(x, y, in_rounded_rect)
            if tile <= 0:
                row += bytes((0, 0, 0, 0))
                continue
            # Bars pick up the same gradient, top brighter than bottom.
            bar_colour = blend(ACCENT, ACCENT_DIM, t)
            ink = coverage(x, y, in_bars)
            colour = blend(base, bar_colour, ink)
            row += bytes((*colour, round(255 * tile)))
        rows.append(row)
    return png(size, size, rows)


def icns(images):
    """Wrap PNGs in an .icns container, one chunk per size."""
    body = b''
    for kind, data in images:
        body += kind + struct.pack('>I', len(data) + 8) + data
    return b'icns' + struct.pack('>I', len(body) + 8) + body


if __name__ == '__main__':
    # The sizes macOS actually reaches for, as PNG-backed types.
    wanted = [(b'ic11', 32), (b'ic12', 64), (b'ic07', 128), (b'ic13', 256), (b'ic14', 512)]
    out = icns([(kind, draw(size)) for kind, size in wanted])
    with open('packaging/Kingfisher.icns', 'wb') as f:
        f.write(out)
    print(f'wrote packaging/Kingfisher.icns ({len(out):,} bytes, {len(wanted)} sizes)')

    # A PNG alongside, for anywhere that cannot read .icns.
    with open('packaging/icon-512.png', 'wb') as f:
        f.write(draw(512))
    print('wrote packaging/icon-512.png')
