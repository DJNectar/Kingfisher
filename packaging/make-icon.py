#!/usr/bin/env python3
"""
Turn packaging/icon-source.png into the app icon, at every size macOS asks for.

The artwork is supplied; this only resizes it and packs the results. Both ends
are written by hand because the usual route — `sips` and `iconutil` — needs
macOS, and this has to build on the Linux machine the app is developed on.
Neither format is difficult: PNG is a zlib stream of filtered scanlines, and an
.icns is a magic word, a length, then one chunk per size holding a PNG.

Resizing is a box filter over PREMULTIPLIED alpha. Averaging straight RGBA
would pull the colour of fully transparent pixels into the edges of the art,
which shows up as a dark or muddy fringe around the rounded corners — the one
place a scaled icon usually goes wrong.
"""

import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'icon-source.png'

# The sizes macOS reaches for, as the PNG-backed icns types.
# Size, and how hard to sharpen afterwards. The smaller the tile, the more of
# the original detail has been thrown away and the more the remaining edges
# have to carry, so the correction is strongest at the bottom.
ICNS_SIZES = [
    (b'ic11', 32, 1.10),    # 16pt @2x
    (b'ic12', 64, 0.85),    # 32pt @2x
    (b'ic07', 128, 0.55),
    (b'ic13', 256, 0.35),   # 128pt @2x
    (b'ic14', 512, 0.20),   # 256pt @2x
    (b'ic10', 1024, 0.0),   # 512pt @2x — near enough the source to leave alone
]


# ------------------------------------------------------------------ decode
def read_png(path):
    """Decode a non-interlaced 8-bit RGB or RGBA PNG to (width, height, rgba)."""
    raw = path.read_bytes()
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{path} is not a PNG')

    idat = bytearray()
    width = height = channels = None
    pos = 8
    while pos < len(raw):
        length = struct.unpack('>I', raw[pos:pos + 4])[0]
        kind = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            width, height, depth, colour, _, _, interlace = struct.unpack('>IIBBBBB', data)
            if depth != 8 or colour not in (2, 6) or interlace:
                raise ValueError('expected a non-interlaced 8-bit RGB or RGBA PNG')
            channels = 3 if colour == 2 else 4
        elif kind == b'IDAT':
            idat += data
        elif kind == b'IEND':
            break
        pos += 12 + length

    stream = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(width * height * 4)
    previous = bytearray(stride)
    at = 0

    for y in range(height):
        filter_type = stream[at]
        at += 1
        line = bytearray(stream[at:at + stride])
        at += stride

        # Undo the per-scanline filter. `a` is the pixel to the left, `b` the
        # one above, `c` the one above-left.
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = previous[i]
            c = previous[i - channels] if i >= channels else 0
            if filter_type == 0:
                value = line[i]
            elif filter_type == 1:
                value = line[i] + a
            elif filter_type == 2:
                value = line[i] + b
            elif filter_type == 3:
                value = line[i] + (a + b) // 2
            elif filter_type == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                value = line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)
            else:
                raise ValueError(f'unknown PNG filter {filter_type}')
            line[i] = value & 0xFF

        row = y * width * 4
        if channels == 4:
            out[row:row + width * 4] = line
        else:
            for x in range(width):
                out[row + x * 4:row + x * 4 + 3] = line[x * 3:x * 3 + 3]
                out[row + x * 4 + 3] = 255

        previous = line

    return width, height, out


# ------------------------------------------------------------------ encode
def write_png(width, height, rgba):
    rows = b''.join(
        b'\x00' + bytes(rgba[y * width * 4:(y + 1) * width * 4])
        for y in range(height)
    )

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
        + chunk(b'IEND', b'')
    )


# ------------------------------------------------------------------ resize
def resize(src_w, src_h, rgba, size):
    """Box-filter down to size x size, averaging premultiplied alpha."""
    return resize_box(src_w, src_h, rgba, size, size)


def resize_box(src_w, src_h, rgba, out_w, out_h):
    """As resize, to any width and height.

    The icon is always square, but a launch image need not be, and forcing one
    into a square would either stretch the artwork or crop it - both of which
    are decisions belonging to whoever drew it, not to this script.
    """
    out = bytearray(out_w * out_h * 4)
    for oy in range(out_h):
        y0 = oy * src_h // out_h
        y1 = max(y0 + 1, (oy + 1) * src_h // out_h)
        for ox in range(out_w):
            x0 = ox * src_w // out_w
            x1 = max(x0 + 1, (ox + 1) * src_w // out_w)

            r = g = b = a = 0
            count = 0
            for y in range(y0, y1):
                base = y * src_w * 4
                for x in range(x0, x1):
                    i = base + x * 4
                    alpha = rgba[i + 3]
                    # Premultiply: a transparent pixel's colour is meaningless
                    # and must not be allowed to tint its neighbours.
                    r += rgba[i] * alpha
                    g += rgba[i + 1] * alpha
                    b += rgba[i + 2] * alpha
                    a += alpha
                    count += 1

            o = (oy * out_w + ox) * 4
            if a == 0:
                out[o:o + 4] = b'\x00\x00\x00\x00'
            else:
                out[o] = min(255, round(r / a))
                out[o + 1] = min(255, round(g / a))
                out[o + 2] = min(255, round(b / a))
                out[o + 3] = round(a / count)
    return out


def sharpen(size, rgba, amount):
    """
    Unsharp mask, over premultiplied alpha.

    Area-averaging is the right way to shrink an image — it is what stops a
    1254px drawing aliasing into confetti — but it is inherently soft, and the
    softness is worst exactly where it hurts: at 32 and 64 pixels, where every
    edge has to do the work the detail used to do. Every icon pipeline sharpens
    after the resample for this reason.

    The amount is scaled by the caller, hardest at the smallest sizes.
    """
    if amount <= 0:
        return rgba

    # Premultiply, so the blur cannot drag transparent black into the edges.
    pm = [0.0] * (size * size * 4)
    for i in range(0, len(rgba), 4):
        a = rgba[i + 3] / 255.0
        pm[i] = rgba[i] * a
        pm[i + 1] = rgba[i + 1] * a
        pm[i + 2] = rgba[i + 2] * a
        pm[i + 3] = rgba[i + 3]

    # A 3x3 tent blur is enough: at these sizes a wider radius smears the very
    # edges it is supposed to be defining.
    KERNEL = (1, 2, 1, 2, 4, 2, 1, 2, 1)
    total = 16
    blurred = [0.0] * len(pm)
    for y in range(size):
        for x in range(size):
            for c in range(4):
                acc = 0.0
                k = 0
                for dy in (-1, 0, 1):
                    yy = min(size - 1, max(0, y + dy))
                    for dx in (-1, 0, 1):
                        xx = min(size - 1, max(0, x + dx))
                        acc += pm[(yy * size + xx) * 4 + c] * KERNEL[k]
                        k += 1
                blurred[(y * size + x) * 4 + c] = acc / total

    out = bytearray(len(rgba))
    for i in range(0, len(pm), 4):
        alpha = min(255.0, max(0.0, pm[i + 3] + (pm[i + 3] - blurred[i + 3]) * amount))
        if alpha <= 0:
            out[i:i + 4] = b'\x00\x00\x00\x00'
            continue
        for c in range(3):
            v = pm[i + c] + (pm[i + c] - blurred[i + c]) * amount
            # Un-premultiply on the way out.
            v = v / (alpha / 255.0)
            out[i + c] = int(min(255.0, max(0.0, v)))
        out[i + 3] = int(alpha)
    return out


def icns(images):
    body = b''.join(kind + struct.pack('>I', len(data) + 8) + data for kind, data in images)
    return b'icns' + struct.pack('>I', len(body) + 8) + body


def write_splash(assets, width, height, rgba):
    """The launch screen's artwork.

    Drop a `packaging/splash-source.png` beside the icon source and it is used
    verbatim - any shape, not just square - because a launch screen is a
    different canvas from a 32-pixel icon and deserves its own drawing. With no
    such file the bird stands in, so the launch screen is never empty.

    Either way the app only ever loads `assets/splash.png`, so there is no
    fallback logic in the stylesheet and no way for the page to reference a
    file that is not there.
    """
    target = assets / 'splash.png'
    LONG_EDGE = 640

    override = HERE / 'splash-source.png'
    if override.exists():
        sw, sh, srgba = read_png(override)
        if sw >= sh:
            ow = min(LONG_EDGE, sw)
            oh = max(1, round(sh * ow / sw))
        else:
            oh = min(LONG_EDGE, sh)
            ow = max(1, round(sw * oh / sh))
        data = srgba if (ow, oh) == (sw, sh) else resize_box(sw, sh, srgba, ow, oh)
        target.write_bytes(write_png(ow, oh, data))
        print(f'wrote src/ui/assets/splash.png  {ow}x{oh}  from splash-source.png')
        return

    data = sharpen(256, resize(width, height, rgba, 256), 0.35)
    target.write_bytes(write_png(256, 256, data))
    print('wrote src/ui/assets/splash.png  256x256  from the icon')


if __name__ == '__main__':
    if not SOURCE.exists():
        sys.exit(f'missing {SOURCE}')

    width, height, rgba = read_png(SOURCE)
    print(f'source {SOURCE.name}: {width}x{height}')

    chunks = []
    for kind, size, amount in ICNS_SIZES:
        # A hand-drawn version for this size wins, if one exists.
        #
        # No resampler can fix "too much information for the canvas". At 32
        # pixels there are barely a thousand of them, and the artwork has three
        # overlapping wing layers, a waveform, a reflection and a splash; all
        # an algorithm can do with that is average it. A designer solves it by
        # drawing a simpler picture — fewer shapes, heavier bill, the waveform
        # reduced to a line. Good icon sets are drawn at several sizes rather
        # than scaled from one.
        override = HERE / f'icon-source-{size}.png'
        if override.exists():
            ow, oh, orgba = read_png(override)
            if (ow, oh) != (size, size):
                orgba = resize(ow, oh, orgba, size)
            chunks.append((kind, write_png(size, size, orgba)))
            print(f'  {size:>4}px  from {override.name}')
            continue

        scaled = sharpen(size, resize(width, height, rgba, size), amount)
        chunks.append((kind, write_png(size, size, scaled)))
        print(f'  {size:>4}px  sharpen {amount:.2f}')

    out = icns(chunks)
    (HERE / 'Kingfisher.icns').write_bytes(out)
    print(f'wrote Kingfisher.icns ({len(out):,} bytes, {len(chunks)} sizes)')

    # The same bird for the web app's favicon and header mark, so the two are
    # plainly the same thing. Small on purpose: it ships inside the app.
    assets = HERE.parent / 'src' / 'ui' / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    web = sharpen(128, resize(width, height, rgba, 128), 0.55)
    (assets / 'kingfisher-128.png').write_bytes(write_png(128, 128, web))
    print('wrote src/ui/assets/kingfisher-128.png')

    write_splash(assets, width, height, rgba)

    (HERE / 'icon-512.png').write_bytes(write_png(512, 512, resize(width, height, rgba, 512)))
    print('wrote icon-512.png')
