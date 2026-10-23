export const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

// Real 7×3 images, encoded without metadata. JPEG orientation is added below.
export const referencePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAcAAAADAQMAAABlDYeGAAAAA1BMVEUyZLRNCNUSAAAAC0lEQVQI12NgAAEAAAYAAWb0yWwAAAAASUVORK5CYII=",
  "base64",
);
export const referenceJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAcDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ACRQAqf/2Q==",
  "base64",
);
export const referenceWebp = Buffer.from(
  "UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoHAAMAAgA0JaACdLoAA5gA/u4KZ/5Z/5/fF3qc/7jsDdcvgAA=",
  "base64",
);

export function orientedReferenceJpeg(orientation: number) {
  const exif = Buffer.from(
    "45786966000049492a0008000000010012010300010000000100000000000000",
    "hex",
  );
  exif.writeUInt16LE(orientation, 24);
  const header = Buffer.from([0xff, 0xe1, 0, exif.length + 2]);
  return Buffer.concat([
    referenceJpeg.subarray(0, 2),
    header,
    exif,
    referenceJpeg.subarray(2),
  ]);
}
