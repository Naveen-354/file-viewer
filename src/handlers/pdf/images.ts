import { readBytes } from "../../utils/file";

export const PDF_IMAGE_LIMIT = 16 * 1024 * 1024;

export interface LoadedImage {
  format: "png" | "jpeg";
  dataBase64: string;
  width: number;
  height: number;
}

const DIRECT: Record<string, "png" | "jpeg"> = { png: "png", jpg: "jpeg", jpeg: "jpeg" };

/**
 * PDF only takes PNG and JPEG, so anything else the WebView can decode is
 * re-encoded to PNG first. Formats it cannot decode are reported so the caller
 * can point at the image viewer's converter instead of failing silently.
 */
export async function loadImageForPdf(
  path: string,
  extension: string | null,
  mimeType: string | null,
): Promise<LoadedImage> {
  const bytes = await readBytes(path, PDF_IMAGE_LIMIT);
  if (bytes.byteLength >= PDF_IMAGE_LIMIT) {
    throw new Error("Images added to a PDF are limited to 16 MiB.");
  }
  const direct = DIRECT[(extension ?? "").toLowerCase()];
  const blob = new Blob([bytes as BlobPart], { type: mimeType ?? "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await decode(url, extension);
    if (direct) {
      return { format: direct, dataBase64: await toBase64(blob), width: image.width, height: image.height };
    }
    const canvas = window.document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image for embedding.");
    context.drawImage(image, 0, 0);
    return {
      format: "png",
      dataBase64: canvas.toDataURL("image/png").replace(/^data:.*?;base64,/, ""),
      width: image.width,
      height: image.height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decode(url: string, extension: string | null): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.width || !image.height) {
        reject(new Error(`This ${extension ?? "image"} has no intrinsic size. Convert it to PNG first.`));
        return;
      }
      resolve(image);
    };
    image.onerror = () =>
      reject(
        new Error(
          `This app cannot decode ${extension ? `.${extension}` : "that"} images directly. Open it in the image viewer and use Convert to make a PNG first.`,
        ),
      );
    image.src = url;
  });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.onload = () => resolve(String(reader.result).replace(/^data:.*?;base64,/, ""));
    reader.readAsDataURL(blob);
  });
}

/** Fits an image inside the page without upscaling it. */
export function initialPlacement(
  image: LoadedImage,
  pageWidth: number,
  pageHeight: number,
): { width: number; height: number } {
  const maxWidth = pageWidth * 0.5;
  const maxHeight = pageHeight * 0.5;
  const ratio = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  return { width: Math.round(image.width * ratio), height: Math.round(image.height * ratio) };
}
