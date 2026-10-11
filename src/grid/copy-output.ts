async function loadOutput(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load output.");
  return response.blob();
}

async function clipboardImage(url: string): Promise<Blob> {
  const blob = await loadOutput(url);
  if (blob.type === "image/png") return blob;
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not copy image.");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error("Could not copy image."));
      }, "image/png");
    });
  } finally {
    image.close();
  }
}

export async function copyOutput(
  url: string,
  format: "image" | "svg" | "markdown",
) {
  const source = new URL(url, location.origin);
  if (format === "markdown") source.searchParams.set("raw", "1");
  if (format === "image") {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": clipboardImage(source.href) }),
    ]);
  } else if (
    typeof ClipboardItem !== "undefined" &&
    navigator.clipboard.write
  ) {
    const content = loadOutput(source.href).then(
      async (blob) => new Blob([await blob.text()], { type: "text/plain" }),
    );
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": content }),
    ]);
  } else {
    const blob = await loadOutput(source.href);
    await navigator.clipboard.writeText(await blob.text());
  }
}
