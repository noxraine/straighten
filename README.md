# Straighten

Perspective correction for interior photos. Mark the four corners of a wall or window and the shot is rebuilt as if the camera had been square to that surface. The rest of the room stays in frame. Everything runs in the browser. Photos are not uploaded.

## Use it

1. Open the site and drop a JPEG, PNG, or WebP (HEIC when the browser can decode it). Large phone photos are fine. EXIF orientation is respected. **AI Frontal (Qwen)** is the default. Click the wall that should face the camera, then **Сделать фронтальной (AI)**. Qwen returns a new photo; mark its four corners and the ordinary correction runs. **4 points** and **Box room** stay available.
2. In 4 points, click the corners in order: **top left, top right, bottom left, bottom right**. The list beside the photo shows which corner is next. Drag any point to nudge it; a magnifier follows the pointer. Reset clears the corners, Undo steps back one point. **Box room** replaces that flow with eight clicks: the same four back-wall corners, then the near ceiling-left, ceiling-right, floor-left, and floor-right. A small diagram marks the next corner. Near corners may sit on the padded margin just outside the photo, and a click anywhere on a depth edge is accepted. The gold wire on the photo is the snapped box.
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

The tests cover the homography (normalized DLT, inverse, a skewed quad mapped back to a rectangle), the CPU warp, the box-room solver, and AI fill. `test/room3d.test.js` builds synthetic cuboids, including off-center cameras, noise, and near points slid along their edges. The frontal back wall must be an axis-aligned rectangle within `1e-6` px, the floor axis must be vertical within `1e-6`, the floor and ceiling bands must match, and the back-face homography must match four-point mode up to scale and translation. `test/ai-fill.test.js` checks the request body and the error text, including a 402. `test/qwen-frontal-logic.test.js` checks the rotation hint, the Qwen input, and error text. There are no npm dependencies.

Regenerate the built-in sample wall with:

```bash
node scripts/make-sample.mjs
```

## AI Frontal (Qwen)

The default mode sends the photo to Replicate’s `qwen/qwen-edit-multiangle` through `netlify/functions/qwen-frontal.js`. The browser draws a red circle (radius 2% of the short side, `#ff0000`, thin white outline) on a JPEG no longer than 1536 pixels and posts it with `rotate_degrees` and `multiple_angles_strength`. The rotation hint is `round(clamp(-(markerX / width - 0.5) * 90, -45, 45))`: a marker on the left is a positive “rotate left”. Advanced can override that from -90° to 90°, and the angle strength from 0 to 2. The function calls `POST https://api.replicate.com/v1/models/qwen/qwen-edit-multiangle/predictions` with `Prefer: wait=8`, `vertical_tilt` 0, and `output_format` png. The page polls `GET /.netlify/functions/qwen-frontal?id=…` the same way as inpaint. Status text is «Отправка в Qwen…», «Обработка…», and «Готово». `GET ?health=1` returns `{ "tokenPresent": true }` without calling Replicate. Errors keep the status code and a `stage`. **Повторить** runs it again. **Использовать оригинал** restores the upload. After the result is the working image, four clicks use the same homography as 4-point mode. **Достроить углы (AI)** sends empty corners to the existing LaMa fill when the frame still has them.

## AI fill

AI fill is optional. Choosing **AI fill** sends the whole-frame result and a mask to [Replicate LaMa](https://replicate.com/twn39/lama) (`twn39/lama`, version `bb9dd3362d559d0953b1d57ec9817f222c162e90047039b1b4af45c47b0b9af9`, inputs `image` and `mask`) through `POST /.netlify/functions/inpaint`. The page then polls `GET /.netlify/functions/inpaint?id=…`. Status text reads “Sending to Replicate…”, “Processing…”, and “Done”. The function reads `process.env.REPLICATE_API_TOKEN` for both the Netlify v1 handler and the v2 default export. `GET /.netlify/functions/inpaint?health=1` returns `{ "tokenPresent": true }` or `false` and does not call Replicate. A failure shows a banner with the HTTP status and the function’s error text, including `Replicate 402: insufficient credit` when the account cannot pay for the prediction. The error JSON includes a `stage` of `validate`, `create`, `poll`, or `fetch-output`. Replicate keeps an uploaded file for about a day and a prediction output for a limited time; the function deletes the uploaded inputs when the run finishes or is cancelled. If the fill fails, the preview stays on the scale-to-fit result.

## Deploy on Netlify

The site is the repository itself: `index.html`, the ES modules, `styles.css`, and `samples/`.

`netlify.toml` sets:

- **Publish directory:** `.` (the repository root)
- **Build command:** `echo No build step` (a no-op)

Connect the repo in Netlify, or drag this folder onto [Netlify Drop](https://app.netlify.com/drop). No environment variables are required.

## Box room

Box room assumes a rectangular cuboid, every angle 90°. The four back-wall edges give the horizontal and vertical vanishing points, and the four depth edges (back corner to near corner) give the depth vanishing point, each by a least-squares fit in homogeneous coordinates so a nearly parallel pair can sit at infinity. The principal point is the image center and pixels are square. When two finite vanishing points are orthogonal, the focal length is `f² = -(v1 - c) · (v2 - c)`. A one-point view has no finite pair, so the lens falls back to a 60° horizontal field of view. The **Lens / FOV** slider does not move the back wall. It only scales how far the near corners sit beyond it.

The camera rotation is the wall’s axes expressed in the camera frame. Width, height, and depth are recovered up to scale. A near click only has to lie on its depth edge: each click is dropped onto the line from its back corner through the depth vanishing point, the four near corners are forced to one shared depth so they stay a rectangle parallel to the back wall, and a few Levenberg-Marquardt iterations reduce the reprojection error. Back corners use point-to-point distance. Near clicks use point-to-line distance, so an edge click is a valid measurement. If that pass does not clearly beat the closed form, the closed form is kept.

The picture is not one homography for the whole room. The back wall is the exception: it uses the same edge-length rectangle and the same homography as 4-point mode on the four back clicks, so that wall looks the same in both modes, including when you type a real width and height. The layout vanishing point sits at the center of that rectangle, both across and down. The near opening is a uniform scale of the same rectangle about that center, so the floor and ceiling bands are the same thickness and the left and right walls are the same width. There is no eye-height shift. The other four faces are quad homographies from those corners plus the snapped near corners. Shared corners are the same points, so the seams meet. Past the near corners the adjacent face’s homography keeps going; samples that miss the photo stay transparent, which is what Whole frame, Max crop, and AI fill already understand. **Lens / FOV** changes only the depth factor `distance / (distance − depth)`. **Wireframe on the result** draws this layout. Crop to selection keeps the back rectangle.

## How the correction works

Four point pairs fix an 8-degree-of-freedom homography. `homography.js` normalizes the points, builds the Direct Linear Transform matrix, and solves for its nullspace. The preview and the export then walk the output backwards: each pixel is sent through the inverse homography and sampled from the photo. In whole-photo mode the four corners of the source are mapped through that homography, the bounding box is translated to the origin, and it is scaled uniformly so the entire photo fits. A corner that falls on or behind the horizon is held at a finite distance instead of blowing the canvas up.

`warp.js` does that sampling in a WebGL fragment shader (bilinear). If the photo is larger than the GPU’s texture limit, the export is tiled and each tile uploads only the source region it needs. If WebGL is unavailable, the same mapping runs on the CPU. Box room uses a second shader that chooses one of the five face homographies for each pixel, with the same CPU fallback.

## Browser notes

- Safari can decode HEIC. Chrome and Firefox generally cannot; export a JPEG from the camera roll in that case.
- Very large exports may be capped (about 16,000 pixels on a side, or 64 megapixels) so the browser can still encode the file. The status line says when that happens.
- The live preview is scaled to the window. Download is the full-resolution pass.
