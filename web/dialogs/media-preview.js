import { state } from '../lib/state.js';
import { authHeaders } from '../lib/api.js';
import { el, iconButton, icons } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

const formats = {
  png: ['img', 'image/png'],
  jpg: ['img', 'image/jpeg'],
  jpeg: ['img', 'image/jpeg'],
  gif: ['img', 'image/gif'],
  webp: ['img', 'image/webp'],
  wav: ['audio', 'audio/wav'],
  mp3: ['audio', 'audio/mpeg'],
  flac: ['audio', 'audio/flac'],
  ogg: ['audio', 'audio/ogg'],
  m4a: ['audio', 'audio/mp4'],
  mp4: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  txt: ['pre', 'text/plain'],
  md: ['pre', 'text/plain'],
  json: ['pre', 'text/plain'],
  csv: ['pre', 'text/plain'],
  log: ['pre', 'text/plain'],
};
export const previewable = (name) =>
  Object.hasOwn(formats, name.split('.').at(-1)?.toLowerCase() ?? '');
export async function previewArtifact(context, artifact) {
  if (
    context.token !== state.token ||
    context.controller.signal.aborted ||
    !previewable(artifact.filename)
  )
    return;
  const opener = document.activeElement,
    controller = new AbortController(),
    dialog = el('dialog', undefined, 'modal wide-modal media-preview');
  const header = el('header', undefined, 'dialog-heading'),
    body = el('div', t('common.wait'), 'media-preview-content');
  header.append(
    el('h2', artifact.filename),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  dialog.append(header, body);
  document.body.append(dialog);
  dialog.showModal();
  icons();
  let url;
  const close = () => dialog.close();
  context.controller.signal.addEventListener('abort', close, { once: true });
  dialog.addEventListener(
    'close',
    () => {
      controller.abort();
      context.controller.signal.removeEventListener('abort', close);
      if (url) URL.revokeObjectURL(url);
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  try {
    const response = await fetch(`/v1/files/${encodeURIComponent(artifact.id)}/content`, {
      headers: authHeaders(context.token),
      signal: controller.signal,
    });
    if (!response.ok) throw Error(`${response.status}`);
    const bytes = await response.arrayBuffer();
    if (!dialog.open || context.token !== state.token) {
      dialog.close();
      return;
    }
    const [tag, mime] = formats[artifact.filename.split('.').at(-1).toLowerCase()];
    const viewer = el(tag);
    if (tag === 'pre')
      viewer.textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 100000);
    else {
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      viewer.src = url;
      if (tag === 'img') viewer.alt = artifact.filename;
      else {
        viewer.controls = true;
        viewer.autoplay = false;
      }
    }
    body.replaceChildren(viewer);
  } catch (error) {
    if (dialog.open) body.textContent = error.message;
  }
}
