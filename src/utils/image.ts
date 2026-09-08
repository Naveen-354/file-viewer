/**
 * Swaps a file name's extension for the conversion target's, so "photo.png"
 * offers "photo.jpg" instead of "photo.png.jpg".
 */
export function suggestedName(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${extension}`;
}
