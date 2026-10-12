export function ContainedImage({
  src,
  alt,
  loading,
}: {
  src: string | undefined;
  alt: string;
  loading?: "lazy";
}) {
  return (
    <div className="image-preview">
      <img
        className="generated-image"
        src={src}
        alt={alt}
        loading={loading}
        onLoad={({ currentTarget: image }) => {
          // Fit the element itself so letterboxing belongs to the grid.
          const ratio = image.naturalWidth / image.naturalHeight;
          if (Number.isFinite(ratio) && ratio > 0)
            image.style.width = `min(100cqw, ${ratio * 100}cqh)`;
        }}
      />
    </div>
  );
}
