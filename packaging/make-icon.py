#!/usr/bin/env python3
"""
Draw Kingfisher's app icon — the bird — and write it as a .icns.

Written by hand because the usual route (draw a PNG, run `iconutil`) needs
macOS, and this has to build anywhere. An .icns is only a container: a magic
word, a length, then one chunk per size holding a PNG. Both that and PNG itself
are small enough to write directly, which keeps the icon reproducible from
source rather than a binary nobody can regenerate.

The bird is built from overlapping ellipses and polygons, painted back to
front, each one anti-aliased by supersampling. A kingfisher is a gift to draw
at icon size: the dagger bill and the blue-over-orange split are recognisable
even at 32 pixels, where feather detail would turn to mud.
"""

import math
import struct
import zlib

# --------------------------------------------------------------- palette
BG_TOP = (0x1B, 0x22, 0x2C)
BG_BOTTOM = (0x0E, 0x12, 0x18)

BLUE_LIGHT = (0x53, 0xC4, 0xEE)   # crown and back, catching the light
BLUE = (0x2A, 0x9A, 0xD4)
BLUE_DEEP = (0x17, 0x6A, 0x9E)    # wing and tail, in shadow
ORANGE = (0xD9, 0x7B, 0x3C)       # breast
ORANGE_DEEP = (0xB4, 0x5C, 0x28)
CREAM = (0xF2, 0xE9, 0xDC)        # throat and cheek patch
BILL = (0x20, 0x26, 0x2E)
BILL_LIGHT = (0x39, 0x42, 0x4E)
EYE = (0x11, 0x14, 0x19)
BRANCH = (0x4A, 0x40, 0x36)


# ------------------------------------------------------------------ png
def png(width, height, rows):
    raw = b''.join(b'\x00' + bytes(row) for row in rows)

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


# --------------------------------------------------------------- shapes
# All shapes are defined in a 0..1 square and scaled at draw time, so one
# description serves every icon size.

def ellipse(cx, cy, rx, ry, rotation=0.0):
    cos_r, sin_r = math.cos(-rotation), math.sin(-rotation)

    def inside(x, y):
        dx, dy = x - cx, y - cy
        u = dx * cos_r - dy * sin_r
        v = dx * sin_r + dy * cos_r
        return (u / rx) ** 2 + (v / ry) ** 2 <= 1
    return inside


def polygon(points):
    def inside(x, y):
        hit = False
        n = len(points)
        for i in range(n):
            x0, y0 = points[i]
            x1, y1 = points[(i + 1) % n]
            if (y0 > y) != (y1 > y):
                cross = x0 + (y - y0) / (y1 - y0) * (x1 - x0)
                if x < cross:
                    hit = not hit
        return hit
    return inside


def union(*shapes):
    return lambda x, y: any(s(x, y) for s in shapes)


def without(shape, *cuts):
    return lambda x, y: shape(x, y) and not any(c(x, y) for c in cuts)


# The bird, facing left, perched. Ordered back to front.
HEAD = ellipse(0.470, 0.400, 0.150, 0.142)
BODY = ellipse(0.575, 0.590, 0.175, 0.200)
BACK = union(HEAD, BODY)

TAIL = polygon([(0.680, 0.700), (0.870, 0.790), (0.830, 0.845), (0.640, 0.760)])
WING = ellipse(0.610, 0.585, 0.098, 0.150, rotation=-0.30)
BREAST = without(ellipse(0.505, 0.625, 0.125, 0.165), WING)
# Throat and neck patch. On a common kingfisher these are the two pale marks:
# one under the bill, one behind the cheek. Putting the second up on the crown
# — where an earlier version had it — reads as a smudge rather than a bird.
THROAT = ellipse(0.418, 0.472, 0.060, 0.070)
NECK_PATCH = without(ellipse(0.556, 0.452, 0.050, 0.062, rotation=0.35), WING)

# The dagger. Long, straight and level — the one feature that says kingfisher
# before anything else does.
# The tip stops short of the tile edge on purpose: scaled up to fill the icon,
# a bill starting at the very edge gets sliced off by the rounded corner.
BILL_SHAPE = polygon([(0.100, 0.434), (0.360, 0.378), (0.360, 0.482)])
BILL_LOWER = polygon([(0.112, 0.448), (0.360, 0.436), (0.360, 0.488)])

EYE_SHAPE = ellipse(0.405, 0.372, 0.030, 0.030)
GLINT = ellipse(0.396, 0.363, 0.011, 0.011)

PERCH = polygon([(0.120, 0.858), (0.900, 0.836), (0.900, 0.882), (0.120, 0.904)])
FOOT = polygon([(0.540, 0.762), (0.585, 0.762), (0.585, 0.858), (0.540, 0.858)])

LAYERS = [
    (PERCH, BRANCH),
    (FOOT, BILL),
    (BACK, BLUE),
    (ellipse(0.470, 0.352, 0.140, 0.090), BLUE_LIGHT),   # lit crown
    (BREAST, ORANGE),
    (ellipse(0.520, 0.700, 0.105, 0.090), ORANGE_DEEP),  # belly in shadow
    (WING, BLUE_DEEP),
    (ellipse(0.600, 0.530, 0.070, 0.070, rotation=-0.30), BLUE),  # wing highlight
    (TAIL, BLUE_DEEP),
    (THROAT, CREAM),
    (NECK_PATCH, CREAM),
    (BILL_SHAPE, BILL),
    (BILL_LOWER, BILL_LIGHT),
    (EYE_SHAPE, EYE),
    (GLINT, CREAM),
]


# How much of the tile the bird fills, and where it sits in it. Applied as a
# transform on the sampling coordinate rather than by rewriting every shape,
# so the drawing above stays readable. At 64 pixels an under-filled tile just
# looks like a small smudge, and the Dock is mostly where this will be seen.
BIRD_SCALE = 1.12
BIRD_LIFT = 0.030


def draw(size, samples=4):
    """One icon, at one size."""
    inset = size * 0.085
    box = size - inset * 2
    radius = box * 0.225

    def in_tile(px, py):
        x, y = px - inset, py - inset
        if x < 0 or y < 0 or x > box or y > box:
            return False
        cx = min(max(x, radius), box - radius)
        cy = min(max(y, radius), box - radius)
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2

    # Supersample: how much of this pixel falls inside a shape.
    def cover(px, py, inside, to_unit=False):
        hits = 0
        for sy in range(samples):
            for sx in range(samples):
                x = px + (sx + 0.5) / samples
                y = py + (sy + 0.5) / samples
                if to_unit:
                    x, y = (x - inset) / box, (y - inset) / box
                    # Shrinking toward the centre in shape-space makes the
                    # drawing cover more of the tile; the lift moves it up.
                    x = (x - 0.5) / BIRD_SCALE + 0.5
                    y = (y - 0.55) / BIRD_SCALE + 0.55 + BIRD_LIFT
                if inside(x, y):
                    hits += 1
        return hits / (samples * samples)

    rows = []
    for y in range(size):
        row = bytearray()
        t = y / max(1, size - 1)
        backdrop = blend(BG_TOP, BG_BOTTOM, t)
        for x in range(size):
            tile = cover(x, y, in_tile)
            if tile <= 0:
                row += bytes((0, 0, 0, 0))
                continue
            colour = backdrop
            for shape, paint in LAYERS:
                ink = cover(x, y, shape, to_unit=True)
                if ink > 0:
                    colour = blend(colour, paint, ink)
            row += bytes((*colour, round(255 * tile)))
        rows.append(row)
    return png(size, size, rows)


def icns(images):
    body = b''
    for kind, data in images:
        body += kind + struct.pack('>I', len(data) + 8) + data
    return b'icns' + struct.pack('>I', len(body) + 8) + body


if __name__ == '__main__':
    # Small sizes get more supersampling: there are fewer pixels to carry the
    # shape, so each one has to be right.
    wanted = [(b'ic11', 32, 8), (b'ic12', 64, 6), (b'ic07', 128, 4),
              (b'ic13', 256, 4), (b'ic14', 512, 3)]
    out = icns([(kind, draw(size, samples)) for kind, size, samples in wanted])
    with open('packaging/Kingfisher.icns', 'wb') as f:
        f.write(out)
    print(f'wrote packaging/Kingfisher.icns ({len(out):,} bytes, {len(wanted)} sizes)')

    for size in (512, 128, 64):
        with open(f'packaging/icon-{size}.png', 'wb') as f:
            f.write(draw(size, 4 if size > 100 else 8))
    print('wrote packaging/icon-512.png, icon-128.png, icon-64.png')
