# Straighten

Perspective correction for interior photos. Mark a wall, let Qwen turn the camera toward it, then square that wall if you want a true rectangle.

## Use it

1. Open the site and drop a JPEG, PNG, or WebP (HEIC when the browser can decode it). Large phone photos are fine. EXIF orientation is respected.
2. Click the wall in order: **top left, top right, bottom right, bottom left**. The page shows only a direction, such as «Направление: влево, вверх», with no angles.
3. **Выпрямить стену (AI)** sends the original photo (max 1536 px JPEG) and a prompt for that direction. The result is the frontal photo. **Скачать** saves the PNG. **Повторить** sends the original again. **Новое фото** starts over.

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

## Qwen camera

The four clicks are mapped to a unit rectangle. With a 60° horizontal focal length and the principal point at the image center, that homography yields the wall normal. `rotate_degrees` is the negation of `atan2(nx, nz)`: a wall facing to the camera’s right is a right turn, and Qwen treats positive as rotate left. `vertical_tilt` is `-pitch / 45°` (`-1` top-down, `+1` low angle). Above 3° the turn is “left” or “right”; above 0.1 the tilt is “up” or “down”. Otherwise that axis is none. The request itself sends `rotate_degrees` 0 and `vertical_tilt` 0. The prompt names the direction, for example “Rotate the camera to the left and look up until the wall is perfectly frontal…”. A prompt longer than 500 characters is rejected. Polling, health, and error stages match the inpaint function.

## AI fill

**Достроить углы (AI)** sends the whole-frame result and a mask to [Replicate LaMa](https://replicate.com/allenhooo/lama) (`allenhooo/lama`, version `cdac78a1bec5b23c07fd29692fb70baa513ea403a39e643c48ec5edadb15fe72`, inputs `image` and `mask`) through `POST /.netlify/functions/inpaint`, and only when the frame has empty pixels. The page polls `GET /.netlify/functions/inpaint?id=…`. The function reads `process.env.REPLICATE_API_TOKEN`. `GET ?health=1` returns `{ "tokenPresent": true }` or `false` and does not call Replicate. A failure shows a banner, including `Replicate 402: insufficient credit`. The error JSON includes a `stage` of `validate`, `create`, `poll`, or `fetch-output`.

## Deploy on Netlify

The site is the repository itself: `index.html`, the ES modules, `styles.css`, and `samples/`.

`netlify.toml` sets:

- **Publish directory:** `.` (the repository root)
- **Build command:** `echo No build step` (a no-op)

Connect the repo in Netlify, or drag this folder onto [Netlify Drop](https://app.netlify.com/drop). No environment variables are required.

Box room and the one-point marker flow are not in the page. Their modules remain in the repository.

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
