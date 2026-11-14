// Developer platform dialogs: site setup, password reset, usage.
export const enSite = {
  'dlg.reset.code_note':
    'Send the reset code to the developer. They use it on the portal to set a new password themselves, so you never learn their password. The code is valid for 24 hours and works once; generating a new one invalidates the old one. After the developer sets a new password with it, all login sessions for this account are invalidated; API keys already created are not affected.',
  'dlg.reset.password_note':
    'Once set, all login sessions for this account are invalidated immediately and the developer must log in again with the new password; API keys already created are not affected. You will know this password: tell it to the developer and remind them to change it after logging in.',
  'dlg.reset.way_label': 'How to reset the password',
  'dlg.reset.way_code': 'One-time reset code (recommended)',
  'dlg.reset.way_password': 'Set a new password directly',
  'dlg.reset.new_password': 'New password',
  'dlg.reset.title': 'Reset password',
  'dlg.reset.desc': 'Did {email} forget the password? Pick an approach.',
  'dlg.reset.make_code': 'Generate reset code',
  'dlg.reset.working': 'Working…',
  'dlg.reset.confirm_title': 'Reset the password for {email}?',
  'dlg.reset.confirm_message':
    'All login sessions for this account are invalidated immediately. Tell the developer the new password and remind them to change it after logging in.',
  'dlg.reset.confirm_accept': 'Reset password',
  'dlg.reset.done_toast':
    'Reset the password for {email}; existing login sessions were invalidated',
  'dlg.reset.gen_title': 'Generate a reset code for {email}?',
  'dlg.reset.gen_message':
    'A new reset code invalidates any earlier unused one for this account. Once the developer sets a new password with it, all login sessions for this account are invalidated.',
  'dlg.reset.gen_toast':
    'Reset code generated. Copy it now: it will not be shown again once you close this.',
  'dlg.reset.result_desc': 'Send the reset code below to the developer.',
  'dlg.reset.result_title': 'Reset code generated for {email}',
  'dlg.reset.result_once':
    'The reset code is shown only this once. Copy it now and send it to the developer.',
  'dlg.reset.snippet_title': 'reset code',
  'dlg.reset.copied': 'Reset code copied',
  'dlg.reset.expiry':
    'Valid until {time} (24 hours after it was generated) and usable once; generating a new one invalidates this one.',
  'dlg.reset.how':
    'On the portal login page, the developer clicks “Forgot your password?”, then enters their email, the reset code and a new password of their own. You never learn their password.',
  'dlg.setup.err.managed':
    'The config file has a platform block, so this cannot be changed here. Edit config.json and restart the gateway.',
  'dlg.setup.err.owner': 'Changing this needs an owner-level admin key.',
  'dlg.setup.reg.closed': 'Only I can create accounts',
  'dlg.setup.reg.closed_hint':
    'Self-service sign-up is off; you create accounts on the Developers tab.',
  'dlg.setup.reg.invite': 'Sign up with an invite code',
  'dlg.setup.reg.invite_hint':
    'Developers must enter an invite code to sign up; generate invite codes on the Redeem codes tab.',
  'dlg.setup.reg.open': 'Anyone can sign up',
  'dlg.setup.reg.open_hint': 'The portal has a sign-up page and anyone can register on their own.',
  'dlg.setup.who_label': 'Who can sign up',
  'dlg.setup.site_name': 'Site name',
  'dlg.setup.signup_credits': 'Sign-up credits',
  'dlg.setup.open_reminder':
    'Anyone who can reach the portal can sign up on their own, including strangers if the portal is open to the internet.',
  'dlg.setup.title_edit': 'Site settings',
  'dlg.setup.title_enable': 'Enable the developer platform',
  'dlg.setup.desc':
    'Settings are saved first and take effect after the background service restarts. You can come back and change them any time.',
  'dlg.setup.save': 'Save',
  'dlg.setup.save_enable': 'Save and enable',
  'dlg.setup.saving': 'Saving…',
  'dlg.setup.err.no_name': 'No site name entered. Enter one and try again.',
  'dlg.setup.err.name_long':
    'The site name can be at most {n} characters. Shorten it and try again.',
  'dlg.setup.err.credits':
    'Sign-up credits must be a whole number, 0 or more. Fix it and try again.',
  'dlg.setup.saved_toast':
    'Settings saved. They take effect after the background service restarts.',
  'dlg.setup.site_name_hint': 'The site name shown in the developer portal.',
  'dlg.setup.signup_credits_hint': 'Credits a new account gets on sign-up. 0 means none.',
  'dlg.setup.disable_title': 'Disable the developer platform?',
  'dlg.setup.disable_message':
    'After the background service restarts, the developer portal and account keys stop working. Accounts, balances, listings and ledgers are kept and come back when you enable the platform again.',
  'dlg.setup.disable_accept': 'Disable',
  'dlg.setup.disable_toast':
    'Disable saved. It takes effect after the background service restarts.',
  'dlg.setup.cancel_toast': 'Enabling canceled',
  'dlg.setup.restart_title': 'Restart the background service?',
  'dlg.setup.restart_message':
    'Running tasks are interrupted. Tasks run by the built-in kernel can resume from their last saved progress; tasks run by external agents must be started again.',
  'dlg.setup.restart_accept': 'Restart',
  'dlg.usage.mode.runs': 'Tasks',
  'dlg.usage.mode.runs_title': 'Tasks per day',
  'dlg.usage.mode.spent': 'Spend',
  'dlg.usage.mode.spent_title': 'Credits spent per day',
  'dlg.usage.aria_runs': 'Daily tasks over the last {n} days, peak {peak}',
  'dlg.usage.aria_spent': 'Daily credits spent over the last {n} days, peak {peak}',
  'dlg.usage.day_tip': '{date} (UTC)\nTasks {runs} · Spent {spent} credits · {tokens} tokens',
  'dlg.usage.peak': 'Peak {n}',
  'dlg.usage.col.runs': 'Tasks',
  'dlg.usage.col.tokens': 'Tokens',
  'dlg.usage.col.spent': 'Spent (credits)',
  'dlg.usage.search_title': 'Search for {email} under Developers',
  'dlg.usage.measure': 'Usage measure',
  'dlg.usage.section': 'Usage',
  'dlg.usage.section_note': 'Last {n} days, counted by UTC date. Spend is measured in credits.',
  'dlg.usage.none': 'No usage data yet',
  'dlg.usage.none_failed': 'Loading failed; the notice at the top of the page gives the reason.',
  'dlg.usage.none_wait': 'Please wait.',
  'dlg.usage.total': 'Total · Tasks {runs} · Credits {spent} · Tokens {tokens}',
  'dlg.usage.empty_runs': 'No tasks in the last {n} days',
  'dlg.usage.empty_spent': 'No credits spent in the last {n} days',
  'dlg.usage.empty_runs_hint': 'Once developers call listed agents, daily task counts appear here.',
  'dlg.usage.empty_spent_hint':
    'Free agents spend nothing. Once developers’ tasks are settled, daily spend appears here.',
  'dlg.usage.by_agent': 'By agent',
  'dlg.usage.no_agent': 'No agent usage yet',
  'dlg.usage.no_agent_hint': 'Once developers make calls, usage is summed per agent here.',
  'dlg.usage.agent': 'Agent',
  'dlg.usage.by_account': 'By account',
  'dlg.usage.top_n': 'Top {n} by spend',
  'dlg.usage.no_account': 'No account usage yet',
  'dlg.usage.no_account_hint': 'Once developers make calls, usage is summed per account here.',
  'dlg.usage.email': 'Email',
};
