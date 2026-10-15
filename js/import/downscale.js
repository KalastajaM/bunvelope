// js/import/downscale.js — turn a picked file into a Messages API content
// block.
//
// Phone photos of receipts are routinely 4000px wide and several megabytes.
// Sending them at full size costs tokens for detail the model does not use and
// risks the request-size limit, so images are drawn down to a bounded long
// edge first. PDFs go up as-is: re-encoding a document block would lose the
// text layer that makes a statement cheap to read.

/** Long edge, in pixels, that an image is scaled down to before upload. */
export const MAX_IMAGE_EDGE = 1568;

/** Hard ceiling on the base64 payload for one document, in bytes. */
export const MAX_DOC_BYTES = 9 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isImageFile(file) {
  return !!file && IMAGE_TYPES.has(file.type);
}

export function isPdfFile(file) {
  return !!file && file.type === 'application/pdf';
}

/**
 * Scale dimensions down so the long edge is at most `maxEdge`, preserving
 * aspect ratio. Never scales up — a small receipt photo stays small.
 *
 * Pure, so it can be tested without a canvas.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge
 * @returns {{width: number, height: number, scaled: boolean}}
 */
export function fitDimensions(width, height, maxEdge = MAX_IMAGE_EDGE) {
  const w = Math.max(1, Math.round(width || 0));
  const h = Math.max(1, Math.round(height || 0));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      // Strip the `data:<type>;base64,` prefix — the API wants raw base64.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = source;
  });
}

/**
 * Build the content block for a picked file.
 *
 * @param {File} file
 * @returns {Promise<object>} an `image` or `document` content block
 * @throws {Error} with `code = 'unsupported_file'` or `'file_too_large'`
 */
export async function fileToContentBlock(file) {
  if (isPdfFile(file)) {
    if (file.size > MAX_DOC_BYTES) {
      const err = new Error('PDF too large');
      err.code = 'file_too_large';
      throw err;
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: await blobToBase64(file) },
    };
  }

  if (!isImageFile(file)) {
    const err = new Error(`Unsupported file type: ${file?.type || 'unknown'}`);
    err.code = 'unsupported_file';
    throw err;
  }

  // The cloud CSP allows data: images but not blob: URLs. Read once and
  // reuse the payload when no resizing is needed.
  const data = await blobToBase64(file);
  const img = await loadImage(`data:${file.type};base64,${data}`);
  const { width, height, scaled } = fitDimensions(img.naturalWidth, img.naturalHeight);

  // A small image that is already a supported type needs no round-trip
  // through canvas — re-encoding would only lose quality.
  if (!scaled && file.type !== 'image/gif') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: file.type, data },
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('canvas encode failed');

  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(blob) },
  };
}
