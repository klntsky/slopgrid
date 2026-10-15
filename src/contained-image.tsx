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
      />
    </div>
  );
}
