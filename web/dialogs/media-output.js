import { sessionApi } from '../lib/api.js';
import { state } from '../lib/state.js';
import { $ } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

let formats = {};
const names = () => ({
  image: t('media.image'),
  document: t('media.document'),
  audio: t('media.audio'),
  video: t('media.video'),
});
export function resetMediaOutput(sequence) {
  $('task-output-kind').replaceChildren(new Option(t('media.text'), ''));
  $('task-output-format-field').hidden = true;
  const token = state.token;
  void sessionApi(token)('GET', '/v1/media/formats')
    .then((value) => {
      if (sequence !== state.agentDialogSequence || token !== state.token) return;
      formats = value.formats;
      for (const kind of Object.keys(formats))
        $('task-output-kind').add(new Option(names()[kind], kind));
    })
    .catch(() => {});
}
$('task-output-kind').onchange = () => {
  const kind = $('task-output-kind').value;
  $('task-output-format-field').hidden = !kind;
  $('task-output-format').replaceChildren(
    ...Object.keys(formats[kind] ?? {}).map((format) => new Option(format.toUpperCase(), format)),
  );
};
export const mediaMetadata = () =>
  $('task-output-kind').value
    ? {
        'oaa.output_kind': $('task-output-kind').value,
        'oaa.output_format': $('task-output-format').value,
      }
    : {};
