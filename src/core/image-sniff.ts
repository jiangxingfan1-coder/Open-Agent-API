export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const IMAGE_EXT: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function sniffImage(bytes: Buffer): ImageType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    return 'image/webp';
  return undefined;
}
export function normalizeImageType(declared: string): ImageType | undefined {
  const type = declared.trim().toLowerCase();
  const canonical = type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type;
  return (IMAGE_TYPES as readonly string[]).includes(canonical)
    ? (canonical as ImageType)
    : undefined;
}
