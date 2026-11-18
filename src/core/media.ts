import { Fault } from './util.js';
import { sniffImage } from './image-sniff.js';

export const MEDIA_FORMATS = {
  image: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' },
  document: {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    md: 'text/markdown',
    txt: 'text/plain',
  },
  audio: {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
  },
  video: { mp4: 'video/mp4', webm: 'video/webm' },
} as const;
export type MediaKind = keyof typeof MEDIA_FORMATS;
export type MediaPolicy = { kind: MediaKind; format: string; mime: string };
export function mediaPolicy(metadata: Record<string, string>): MediaPolicy | undefined {
  const kind = metadata['oaa.output_kind'];
  if (!kind) return undefined;
  if (!Object.hasOwn(MEDIA_FORMATS, kind))
    throw new Fault('invalid_request', 'Unsupported media output kind.');
  const formats = MEDIA_FORMATS[kind as MediaKind] as Record<string, string>;
  const format = metadata['oaa.output_format'] ?? Object.keys(formats)[0]!;
  if (!Object.hasOwn(formats, format))
    throw new Fault('invalid_request', 'Unsupported output format for this media kind.');
  return { kind: kind as MediaKind, format, mime: formats[format]! };
}
export function mediaInstruction(policy?: MediaPolicy, maxBytes = 64 * 1024 * 1024): string {
  const limitMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
  return policy
    ? `\n\nRequired downloadable deliverable: a real ${policy.kind} file in ${policy.format} format. Use the runtime's downloadable outputs directory and name the file result.${policy.format}. Use only tools already available to this agent; if the required capability is unavailable, report that limitation instead of fabricating a file or embedding base64 in the answer. Keep exported files within the gateway's ${limitMb}MB total artifact limit. Format signatures are checked; creative quality and full codec/container validity require independent review.`
    : '';
}
/** Conservative signatures only, not a decoder or a document/codec correctness claim. */
export function artifactMedia(
  name: string,
  bytes: Buffer,
): { kind: MediaKind; mime: string } | undefined {
  const image = sniffImage(bytes);
  if (image) return { kind: 'image', mime: image };
  const head = bytes.subarray(0, 32).toString('latin1'),
    ext = name.split('.').at(-1)?.toLowerCase();
  if (head.startsWith('%PDF-')) return { kind: 'document', mime: MEDIA_FORMATS.document.pdf };
  if (
    head.startsWith('PK\x03\x04') &&
    ext === 'docx' &&
    bytes.includes(Buffer.from('word/document.xml'))
  )
    return { kind: 'document', mime: MEDIA_FORMATS.document.docx };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE')
    return { kind: 'audio', mime: MEDIA_FORMATS.audio.wav };
  if (head.startsWith('fLaC')) return { kind: 'audio', mime: MEDIA_FORMATS.audio.flac };
  if (head.startsWith('OggS')) return { kind: 'audio', mime: MEDIA_FORMATS.audio.ogg };
  if (
    head.startsWith('ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  )
    return { kind: 'audio', mime: MEDIA_FORMATS.audio.mp3 };
  if (head.slice(4, 8) === 'ftyp')
    return ext === 'm4a'
      ? { kind: 'audio', mime: MEDIA_FORMATS.audio.m4a }
      : { kind: 'video', mime: MEDIA_FORMATS.video.mp4 };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return { kind: 'video', mime: MEDIA_FORMATS.video.webm };
  if (ext === 'md' || ext === 'txt') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text && !text.includes('\0'))
        return {
          kind: 'document',
          mime: ext === 'md' ? MEDIA_FORMATS.document.md : MEDIA_FORMATS.document.txt,
        };
    } catch {
      /* Invalid UTF-8 is not a text document. */
    }
  }
  return undefined;
}
