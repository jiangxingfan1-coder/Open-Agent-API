import { portal, session } from './api.js';
import { errorMessage, t } from './i18n.js';
import { box, busy, button, el, field, link, notice, validateForm } from './dom.js';
import { emit, go, state } from './state.js';

// `next` comes from the URL: accept only an in-app path, never another site.
export const safeNext = (value) =>
  typeof value === 'string' && /^\/[a-z]/.test(value) && !/^\/(login|signup|reset)/.test(value)
    ? value
    : '/dashboard';

function signedIn(result, next) {
  session.set(result.session.token);
  state.account = result.account;
  emit('portal:auth');
  go(safeNext(next));
}

const shell = (root, ...children) =>
  root.replaceChildren(box('div', 'wrap auth-wrap', box('div', 'auth', ...children)));

const head = (title, sub) =>
  box('div', 'auth-head', el('h1', title), sub ? el('p', sub, 'sub') : null);

// Shared form plumbing. Our own validation messages sit under their fields; a refusal from the
// server sits just above the button, where the eye already is; the button shows it is working.
function authForm(id, fields, submitLabel, send, explain = errorMessage) {
  const form = el('form', undefined, 'form');
  form.id = id;
  form.noValidate = true;
  const message = el('div', undefined, 'form-message');
  message.setAttribute('aria-live', 'polite');
  const submit = button(submitLabel, 'primary');
  submit.type = 'submit';
  form.append(...fields, message, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.replaceChildren();
    if (!validateForm(form)) return;
    busy(submit, true);
    try {
      await send();
    } catch (err) {
      message.replaceChildren(notice(explain(err), 'error'));
      busy(submit, false);
    }
  });
  return form;
}

export function login(root, ctx) {
  const email = field('email', t('auth.email'), {
    type: 'email',
    required: true,
    autocomplete: 'username',
    autofocus: true,
  });
  const password = field('password', t('auth.password'), {
    type: 'password',
    required: true,
    autocomplete: 'current-password',
  });
  const form = authForm(
    'login-form',
    [email.field, password.field],
    t('auth.login.submit'),
    async () => {
      const result = await portal.login({
        email: email.input.value.trim(),
        password: password.input.value,
      });
      signedIn(result, ctx.query.get('next'));
    },
  );
  const closed = state.site?.registration === 'closed';
  shell(
    root,
    head(t('auth.login.title'), t('auth.login.sub')),
    ctx.query.get('reset') ? notice(t('reset.done'), 'ok') : null,
    form,
    box(
      'div',
      'auth-alt',
      box('p', '', link('#/reset', t('auth.login.forgot'), 'text-link')),
      closed
        ? el('p', t('auth.login.closed'))
        : box(
            'p',
            '',
            el('span', `${t('auth.login.no_account')} `),
            link('#/signup', t('auth.signup.title'), 'text-link'),
          ),
    ),
  );
}

// The operator hands out a one-time reset code; it replaces the old password. Public page.
export function resetPassword(root) {
  const email = field('email', t('auth.email'), {
    type: 'email',
    required: true,
    autocomplete: 'username',
    autofocus: true,
  });
  const code = field('reset-code', t('reset.code'), {
    type: 'text',
    required: true,
    autocomplete: 'one-time-code',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const password = field(
    'new-password',
    t('reset.new'),
    {
      type: 'password',
      required: true,
      autocomplete: 'new-password',
      minlength: 8,
      maxlength: 200,
    },
    t('auth.password_hint'),
  );
  const form = authForm(
    'reset-form',
    [email.field, code.field, password.field],
    t('reset.submit'),
    async () => {
      await portal.resetPassword({
        email: email.input.value.trim(),
        code: code.input.value.trim(),
        new_password: password.input.value,
      });
      go('/login?reset=1');
    },
    // Wrong, expired and used codes (and unknown emails) all look the same on purpose.
    (err) => (err.code === 'invalid_code' ? t('reset.invalid') : errorMessage(err)),
  );
  shell(
    root,
    head(t('reset.title'), t('reset.sub')),
    form,
    box(
      'div',
      'auth-alt',
      el('p', t('reset.note'), 'muted'),
      box(
        'p',
        '',
        el('span', `${t('reset.remembered')} `),
        link('#/login', t('auth.login.submit'), 'text-link'),
      ),
    ),
  );
}

export function signup(root, ctx) {
  const registration = state.site?.registration ?? 'closed';
  if (registration === 'closed') {
    shell(
      root,
      head(t('auth.signup.title'), t('auth.closed.text')),
      notice(t('auth.closed.notice')),
      box('div', 'actions', link('#/login', t('auth.login.submit'), 'link-button primary')),
    );
    return;
  }
  const email = field('email', t('auth.email'), {
    type: 'email',
    required: true,
    autocomplete: 'username',
    autofocus: true,
  });
  const name = field('name', t('auth.name'), { type: 'text', autocomplete: 'name', maxlength: 80 });
  const password = field(
    'password',
    t('auth.password'),
    {
      type: 'password',
      required: true,
      autocomplete: 'new-password',
      minlength: 8,
      maxlength: 200,
    },
    t('auth.password_hint'),
  );
  const invite = field('invite', t('auth.invite'), {
    type: 'text',
    required: registration === 'invite',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const fields = [email.field, name.field, password.field];
  if (registration === 'invite') fields.push(invite.field);
  const form = authForm('signup-form', fields, t('auth.signup.submit'), async () => {
    const body = {
      email: email.input.value.trim(),
      password: password.input.value,
    };
    if (name.input.value.trim()) body.name = name.input.value.trim();
    if (registration === 'invite') body.invite_code = invite.input.value.trim();
    signedIn(await portal.signup(body), ctx.query.get('next'));
  });
  shell(
    root,
    head(
      t('auth.signup.title'),
      t(registration === 'invite' ? 'auth.signup.sub_invite' : 'auth.signup.sub'),
    ),
    form,
    box(
      'div',
      'auth-alt',
      box(
        'p',
        '',
        el('span', `${t('auth.signup.have_account')} `),
        link('#/login', t('auth.login.submit'), 'text-link'),
      ),
    ),
  );
}
