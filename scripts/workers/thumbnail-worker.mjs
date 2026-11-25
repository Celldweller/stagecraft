/**
 * Thumbnail worker (module worker). Loads an original, scales it down and encodes it, off the main thread.
 * Decoding and encoding a large image takes well over 250 ms, which would block the UI.
 *
 * Message in:  {id, url, width, quality}
 * Message out: {id, ok: true, blob, type, ext, width, height, sourceBytes} | {id, ok: false, error}
 *
 * The worker never uploads anything; that stays on the main thread with Foundry's FilePicker.
 */
import { THUMB_FORMATS, thumbnailSize } from "../lib/thumb-key.mjs";

self.addEventListener("message", async event => {
  const {id, url, width, quality} = event.data ?? {};
  try {
    const result = await createThumbnail(url, width, quality);
    self.postMessage({id, ok: true, ...result});
  } catch ( err ) {
    self.postMessage({id, ok: false, error: String(err?.message ?? err)});
  }
});

/**
 * @param {string} url       Absolute URL of the original.
 * @param {number} maxWidth
 * @param {number} quality   0–1.
 */
async function createThumbnail(url, maxWidth, quality) {
  if ( typeof url !== "string" ) throw new TypeError("No URL given");
  const response = await fetch(url, {credentials: "same-origin"});
  if ( !response.ok ) throw new Error(`HTTP ${response.status}`);
  const source = await response.blob();

  const bitmap = await createImageBitmap(source);
  let size;
  try {
    size = thumbnailSize(bitmap.width, bitmap.height, maxWidth);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    // convertToBlob silently falls back to PNG for unsupported types, so check what came out.
    for ( const format of THUMB_FORMATS ) {
      const blob = await canvas.convertToBlob({type: format.type, quality});
      if ( blob.type === format.type ) {
        return {blob, type: format.type, ext: format.ext, ...size, sourceBytes: source.size};
      }
    }
    throw new Error("The browser can encode neither WebP nor JPEG");
  } finally {
    bitmap.close();
  }
}
