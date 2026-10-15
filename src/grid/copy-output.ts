import { queryClient } from "../query-client";
import { textOutput } from "./text-output";

async function clipboardImage(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load output.");
  const blob = await response.blob();
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
  if (format === "image") {
    return navigator.clipboard.write([
      new ClipboardItem({ "image/png": clipboardImage(url) }),
    ]);
  }
  const content = queryClient.fetchQuery(
    textOutput(url, format === "markdown"),
  );
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": content.then(
          (text) => new Blob([text], { type: "text/plain" }),
        ),
      }),
    ]);
  } else {
    await navigator.clipboard.writeText(await content);
  }
}
