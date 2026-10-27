import { imageSize } from "image-size";

export type Dimensions = { width: number; height: number };

export function imageDimensions(bytes: Uint8Array): Dimensions | undefined {
  try {
    const { width, height, type, orientation } = imageSize(bytes);
    if (
      !["png", "jpg", "webp"].includes(type ?? "") ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    )
      return;
    return orientation && orientation >= 5 && orientation <= 8
      ? { width: height, height: width }
      : { width, height };
  } catch {
    return;
  }
}
