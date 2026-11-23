# Straighten

Perspective correction for interior photos. Mark the four corners of a wall or window and the shot is rebuilt as if the camera had been square to that surface. The rest of the room stays in frame. Everything runs in the browser. Photos are not uploaded.

## Use it

1. Open the site and drop a JPEG, PNG, or WebP (HEIC when the browser can decode it). Large phone photos are fine. EXIF orientation is respected.
2. Click the corners in order: **top left, top right, bottom left, bottom right**. The list beside the photo shows which corner is next. Drag any point to nudge it; a magnifier follows the pointer. Reset clears the corners, Undo steps back.
3. The corrected preview updates as you drag. **Whole frame** is the default: the warped photo is translated and scaled uniformly so the entire frame fits, empty corners included. **Max crop** takes the largest axis-aligned rectangle that sits inside the warped photo, so the export has no empty corners. **Crop to selection** keeps only the surface you marked. Correction strength runs from a gentle nudge at 0% to a fully frontal view at 100%.
4. The proportion starts from the average of the opposite edges. If you know the real size (a wall that is 3.2 by 2.4, in any unit), enter both numbers to lock the ratio.
5. Optional adjustments apply to the preview and the download. **Pick white** samples a small patch on the result and balances the channels. **Clarity** is a light unsharp mask from 0 to 30.
6. Download a JPEG (white fill in the empty corners, with a quality slider) or a PNG (those corners stay transparent). **Download ZIP** packs `straightened.jpg`, `mask.png` (white is photo, black is empty), and `straightened_alpha.png` when the frame has empty corners. The export is full resolution, up to what the browser can encode.

Mouse and touch both work, including on an iPad.

## Run locally

No install and no build. From this directory:

```bash
python3 -m http.server 47821
```

Open `http://127.0.0.1:47821`. ES modules do not load from a `file://` URL, so use any static server.

## Tests

```bash
node --test
```

The tests cover the homography (normalized DLT, inverse, a skewed quad mapped back to a rectangle) and the CPU warp. There are no npm dependencies.

Regenerate the built-in sample wall with:

```bash
node scripts/make-sample.mjs
```

## Deploy on Netlify

The site is the repository itself: `index.html`, the ES modules, `styles.css`, and `samples/`.

`netlify.toml` sets:

- **Publish directory:** `.` (the repository root)
- **Build command:** `echo No build step` (a no-op)

Connect the repo in Netlify, or drag this folder onto [Netlify Drop](https://app.netlify.com/drop). No environment variables are required.

## How the correction works

Four point pairs fix an 8-degree-of-freedom homography. `homography.js` normalizes the points, builds the Direct Linear Transform matrix, and solves for its nullspace. The preview and the export then walk the output backwards: each pixel is sent through the inverse homography and sampled from the photo. In whole-photo mode the four corners of the source are mapped through that homography, the bounding box is translated to the origin, and it is scaled uniformly so the entire photo fits. A corner that falls on or behind the horizon is held at a finite distance instead of blowing the canvas up.

`warp.js` does that sampling in a WebGL fragment shader (bilinear). If the photo is larger than the GPU’s texture limit, the export is tiled and each tile uploads only the source region it needs. If WebGL is unavailable, the same mapping runs on the CPU.

## Browser notes

- Safari can decode HEIC. Chrome and Firefox generally cannot; export a JPEG from the camera roll in that case.
- Very large exports may be capped (about 16,000 pixels on a side, or 64 megapixels) so the browser can still encode the file. The status line says when that happens.
- The live preview is scaled to the window. Download is the full-resolution pass.
