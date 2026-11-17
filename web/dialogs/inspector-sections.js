import { button, el, icon, status } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { previewArtifact, previewable } from './media-preview.js';

const STEP_ICON = {
  completed: 'check',
  uncertain: 'circle-alert',
  failed: 'circle-x',
  running: 'loader',
};
// Task details: steps and output file list (created by run-inspector.js; dependencies come in as arguments).
export function createSections({ $, bytes, download, permit, inspectStep }) {
  function renderSteps(v, data) {
    const key = JSON.stringify(data);
    if (v.stepsKey === key) return;
    v.stepsKey = key;
    const parent = $('run-steps');
    parent.replaceChildren();
    $('step-count').textContent = data.total;
    if (!data.data.length) parent.append(el('p', t('insp.sec.no_steps'), 'muted inspector-empty'));
    for (const step of data.data) {
      const row = button(
        '',
        STEP_ICON[step.status] ?? 'circle',
        () => inspectStep(v, step.id),
        'step step-open',
      );
      row.setAttribute('aria-label', t('insp.sec.view_step', { name: step.name }));
      row.dataset.status = step.status;
      const label = el('div', undefined, 'step-label');
      const name = el('strong', step.name);
      name.translate = false;
      label.append(name, el('code', step.node_id || t('insp.sec.not_dispatched')));
      if (step.reconciled)
        label.append(el('span', t('insp.sec.reconciled'), 'reconciliation-note'));
      row.append(label, status(step.status), icon('chevron-right'));
      parent.append(row);
    }
  }
  function renderArtifacts(v, data) {
    const key = JSON.stringify(data);
    if (v.artifactsKey === key) return;
    v.artifactsKey = key;
    const parent = $('run-artifacts');
    parent.replaceChildren();
    $('artifact-count').textContent = v.state.artifact_count;
    if (!data.data.length)
      parent.append(el('p', t('insp.sec.no_artifacts'), 'muted inspector-empty'));
    for (const artifact of data.data) {
      const row = el('div', undefined, 'artifact');
      row.append(
        icon('file-text'),
        el('span', artifact.filename, 'artifact-name'),
        el('span', bytes(artifact.bytes), 'muted'),
      );
      const control = button(
        '',
        'download',
        () =>
          download(v, `/v1/files/${encodeURIComponent(artifact.id)}/content`, artifact.filename),
        'icon-button',
      );
      control.title = permit('files') ? t('insp.sec.download_artifact') : t('insp.sec.files_scope');
      control.setAttribute('aria-label', control.title);
      control.disabled = !permit('files');
      row.append(control);
      if (previewable(artifact.filename)) {
        const preview = button('', 'eye', () => previewArtifact(v, artifact), 'icon-button');
        preview.title = t('media.preview');
        preview.setAttribute('aria-label', preview.title);
        preview.disabled = !permit('files');
        row.append(preview);
      }
      parent.append(row);
    }
  }
  // Image inputs of the task (docs/images.md): names and sizes; a thumbnail comes from the
  // authenticated file download, shown through a blob: URL (the console CSP allows img-src blob:).
  function renderImages(v, images = []) {
    const key = JSON.stringify(images);
    if (v.imagesKey === key) return;
    v.imagesKey = key;
    const parent = $('run-images');
    parent.replaceChildren();
    parent.hidden = !images.length;
    if (!images.length) return;
    parent.append(el('h3', t('insp.sec.images', { n: images.length })));
    for (const image of images) {
      const row = el('div', undefined, 'artifact run-image');
      if (image.kind !== 'file') {
        row.append(icon('link'), el('span', t('insp.sec.image_url', { host: image.host })));
        parent.append(row);
        continue;
      }
      const thumb = el('img', undefined, 'run-image-thumb');
      thumb.alt = image.name;
      row.append(
        thumb,
        el('span', image.name, 'artifact-name'),
        el('span', bytes(image.bytes), 'muted'),
      );
      parent.append(row);
      if (!permit('files')) continue;
      void fetch(`/v1/files/${encodeURIComponent(image.file_id)}/content`, {
        headers: { Authorization: `Bearer ${v.token}` },
        signal: v.controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const blob = new Blob([await response.arrayBuffer()], { type: image.mime });
          const url = URL.createObjectURL(blob);
          thumb.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
          thumb.src = url;
        })
        .catch(() => {});
    }
  }
  return { renderSteps, renderArtifacts, renderImages };
}
