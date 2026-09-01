#!/usr/bin/env python3
"""Regenerate src/logo-data.js from the official Kraken.io logotype.

Dev-only; run it if the brand asset ever changes:

    pip install pillow && python3 scripts/gen-logo.py

It downloads the media-kit logotype, isolates the hexagon mark, and renders it
into Unicode half-block cells (one character = two vertical pixels) plus a
colour-free silhouette for terminals without colour.
"""
import io, json, urllib.request
from PIL import Image, ImageFilter

SRC = "https://assets.kraken.io/assets/images/media-kit/logotypes/downloads/krakenio-horizontal-full.png"
MARK_BOX = (25, 32, 294, 270)   # the hexagon, left of the wordmark
ROWS = 6                        # character rows; cols follow the aspect ratio
BG = (13, 17, 23)               # blend colour for edge anti-aliasing

raw = urllib.request.urlopen(SRC).read()
mark = Image.open(io.BytesIO(raw)).convert("RGBA").crop(MARK_BOX)
rgb, alpha = mark.convert("RGB"), mark.split()[3]

# The facets are separated by fully transparent seams. Flood them with
# neighbouring colour first, so downscaling never averages in the background
# and leaves muddy dark lines across the mark.
filled = rgb.copy()
opaque = alpha.point(lambda v: 255 if v > 200 else 0)
for _ in range(5):
    filled = Image.composite(filled, filled.filter(ImageFilter.MaxFilter(3)), opaque)

# Close those same seams in the alpha channel so the silhouette is the outer
# hexagon edge only, not the facet lines.
solid = alpha.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(7))

COLS = round(ROWS * 2 * (mark.width / mark.height))
col = filled.resize((COLS, ROWS * 2), Image.LANCZOS)
sil = solid.resize((COLS, ROWS * 2), Image.LANCZOS)

# Sample every half-cell, blending the outer edge toward the terminal
# background so the hexagon silhouette stays smooth at this size.
CH = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
MAX_COLOURS = 40

sampled = []   # None for transparent, else an (r,g,b) tuple
for r in range(ROWS):
    for x in range(COLS):
        for yy in (r * 2, r * 2 + 1):
            a = sil.getpixel((x, yy)) / 255
            if a < 0.35:
                sampled.append(None)
            else:
                sampled.append(tuple(round(cc * a + bb * (1 - a))
                                     for cc, bb in zip(col.getpixel((x, yy)), BG)))

# Edge blending produces a long tail of near-duplicate colours, so collapse them
# to a small palette the data file can carry cheaply.
opaque_cells = [c for c in sampled if c]
strip = Image.new("RGB", (len(opaque_cells), 1))
strip.putdata(opaque_cells)
quantized = strip.quantize(colors=MAX_COLOURS, method=Image.MEDIANCUT).convert("RGB")

palette, lookup = [], {}
def idx(c):
    if c not in lookup:
        lookup[c] = len(palette)
        palette.append(c)
    return lookup[c]

rows_enc, k = [], 0
for r in range(ROWS):
    line = ""
    for x in range(COLS * 2):
        c = sampled[r * COLS * 2 + x]
        if c is None:
            line += "."
        else:
            line += CH[idx(quantized.getpixel((k, 0)))]
            k += 1
    rows_enc.append(line)

assert len(palette) <= len(CH), f"palette too large: {len(palette)}"

# Colour-free fallback: solid silhouette, no facets to muddy it.
mono = []
for r in range(ROWS):
    line = ""
    for x in range(COLS):
        t = sil.getpixel((x, r * 2)) / 255 >= 0.5
        b = sil.getpixel((x, r * 2 + 1)) / 255 >= 0.5
        line += "█" if t and b else "▀" if t else "▄" if b else " "
    mono.append(line.rstrip())

out = f"""// GENERATED FILE — do not edit by hand. See scripts/gen-logo.py.
//
// The Kraken.io hexagon mark, rendered as Unicode half-blocks (one character
// cell = two vertical pixels: fg paints the top half, bg the bottom).
// Source: the official media-kit logotype,
// {SRC}
//
// `rows` holds two palette indices per character cell — '.' means transparent,
// any other character indexes `palette`. `mono` is the colour-free silhouette.

export const COLS = {COLS};
export const ROWS = {ROWS};
export const palette = {json.dumps(['#%02x%02x%02x' % c for c in palette])};
export const rows = {json.dumps(rows_enc, indent=2)};
export const mono = {json.dumps(mono, indent=2)};
"""
open("src/logo-data.js", "w").write(out)
print(f"src/logo-data.js — {COLS}x{ROWS} cells, {len(palette)} colours")
