export async function copyImage(url: string) {
  const png = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Could not load image");
    const blob = await response.blob();
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("Could not copy image")),
        "image/png",
      ),
    );
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
