(() => {
  'use strict';
  const { h, icon, pylon, avatar, toast } = window.SurveyUI;
  const app = document.getElementById('app');
  const state = { user: null, mode: 'login', requests: [] };

  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'poc-client' }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'bad'); } };
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '-');
  const statusClass = (s) => (s === 'Completed' ? 'green' : s === 'Survey scheduled' ? 'teal' : s === 'Not accepted' ? 'red' : s === 'Being rescheduled' ? 'amber' : s.startsWith('Received') ? 'violet' : 'blue');
  // Simple five-step tracker for the public user.
  const TRACK = ['Received', 'Approval', 'Surveyor', 'Survey', 'Completed'];
  function tracker(status) {
    const pos = { 'Received - being reviewed': 0, 'In approval': 1, 'Being rescheduled': 1, 'Finding a surveyor': 2, 'Survey scheduled': 3, 'Survey done - report in review': 4, 'Completed': 5, 'Not accepted': 0 }[status] ?? 1;
    const stop = status === 'Not accepted' ? 0 : status === 'Being rescheduled' ? 1 : -1;
    return h('div', { class: 'track' }, TRACK.map((t, i) => {
      const cls = i === stop ? 'stop' : i < pos ? 'done' : i === pos ? 'now' : '';
      return h('div', { class: 'step ' + cls }, h('span', { class: 'dot' }, cls === 'done' ? icon('check') : cls === 'stop' ? icon('x') : String(i + 1)), t);
    }));
  }
  const brand = () => h('div', { class: 'brandmark' }, h('span', { class: 'logo' }, icon('zap')), h('div', null, h('b', null, 'Substation Survey'), h('span', null, 'Public request portal')));

  function authView() {
    const login = state.mode === 'login';
    const f = { name: h('input', { 'aria-label': 'Full name', autocomplete: 'name' }), email: h('input', { type: 'email', 'aria-label': 'Email', autocomplete: 'email', placeholder: 'you@example.com' }), pw: h('input', { type: 'password', 'aria-label': 'Password', autocomplete: login ? 'current-password' : 'new-password' }) };
    const err = h('div', { class: 'err', role: 'alert' });
    const go = async () => {
      try {
        if (!login) { await api('POST', '/portal/api/register', { name: f.name.value, email: f.email.value, password: f.pw.value }); toast('Account created.'); }
        await api('POST', '/portal/api/login', { email: f.email.value, password: f.pw.value }); await start();
      } catch (e) { err.textContent = e.message; }
    };
    f.pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const feature = (ic, t, s) => h('div', { class: 'feature' }, h('span', { class: 'ibox' }, icon(ic)), h('div', null, h('b', null, t), h('span', null, s)));
    return h('div', { class: 'auth' },
      h('section', { class: 'auth-hero' }, brand(),
        h('h1', null, 'Request a substation survey online'),
        h('p', { class: 'lead' }, 'Create an account, choose the substation and a preferred date, and follow your request until the survey is done.'),
        h('div', { class: 'features' },
          feature('send', 'Send a request in minutes', 'No office visit or paperwork.'),
          feature('activity', 'Track every step', 'See when it is reviewed, approved and scheduled.'),
          feature('lock', 'Your data stays private', 'You only ever see your own requests.')),
        pylon()),
      h('section', { class: 'auth-form' }, h('div', { class: 'auth-card' },
        h('h2', null, login ? 'Sign in' : 'Create your account'), h('p', { class: 'muted' }, login ? 'Welcome back.' : 'It takes less than a minute.'),
        login ? null : [h('label', null, 'Full name'), f.name], h('label', null, 'Email'), f.email,
        h('label', null, 'Password'), f.pw, login ? null : h('div', { class: 'hint' }, 'At least 10 characters, with upper case, lower case and a digit.'), err,
        h('button', { class: 'wide', onclick: go }, login ? 'Sign in' : 'Create account', icon('arrow')),
        h('div', { class: 'demo' }, h('button', { class: 'secondary', style: 'width:100%', onclick: () => { state.mode = login ? 'register' : 'login'; render(); } }, login ? 'New here? Create an account' : 'I already have an account'),
          h('p', { class: 'small muted' }, 'This portal only sends your request in and shows its status. You never sign in to the KPTCL system.')))));
  }

  function homeView() {
    let date = null;
    const subs = h('select', { 'aria-label': 'Substation' });
    api('GET', '/portal/api/substations').then((d) => d.substations.forEach((s) => subs.append(h('option', { value: s.id }, s.name))));
    const title = h('input', { maxlength: 120, 'aria-label': 'What do you need surveyed?', placeholder: 'e.g. Survey near my plot boundary' });
    const chosen = h('div', { class: 'selchip' }, icon('calendar'), h('span', null, 'No date chosen'));
    const today = SurveyCal.istToday();
    let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
    const calBox = h('div');
    const drawCal = () => calBox.replaceChildren(SurveyCal.calendar({ year: y, month: m, selected: date, minDate: today, legend: [['selected', 'Preferred date']],
      onSelect: (d) => { date = d; chosen.lastChild.textContent = `Preferred date: ${fmtDate(d)}`; drawCal(); }, onMonth: (ny, nm) => { y = ny; m = nm; drawCal(); } }));
    drawCal();
    const how = (n, t, s) => h('div', { class: 's' }, h('span', { class: 'n' }, n), h('div', null, h('b', null, t), h('span', null, s)));
    const cardHead = (ic, t, s) => h('div', { class: 'card-h' }, h('span', { class: 'ibox' }, icon(ic)), h('div', null, h('h2', null, t), s ? h('div', { class: 'sub' }, s) : null));
    return h('div', null,
      h('section', { class: 'phero' }, h('div', { class: 'inner' }, h('h1', null, `Hello, ${state.user.name.split(' ')[0]}`), h('p', null, 'Send a new survey request or check how your earlier requests are moving.')), pylon()),
      h('div', { class: 'pmain' },
        h('div', { class: 'howto' }, how(1, 'Send request', 'Pick substation and date'), how(2, 'Review', 'KPTCL checks your request'), how(3, 'Approval', 'Officers approve the LC'), how(4, 'Survey', 'A surveyor is scheduled')),
        h('div', { class: 'grid cols2' },
          h('div', { class: 'card' }, cardHead('send', 'New survey request'),
            h('label', null, 'Substation'), subs, h('label', null, 'What do you need surveyed?'), title, h('label', null, 'Preferred date'), calBox, chosen,
            h('p', { class: 'hint' }, 'Your date is a request. It is confirmed after review and approval.'),
            h('div', { class: 'actions' }, h('button', { onclick: guard(async () => {
              if (!date) throw new Error('Please pick a preferred date.');
              const r = await api('POST', '/portal/api/requests', { substation_id: Number(subs.value), survey_date: date, title: title.value });
              toast(`Request ${r.request.code} received.`); title.value = ''; await load();
            }) }, icon('send'), 'Send request'))),
          h('div', { class: 'card' }, cardHead('activity', 'My requests', `${state.requests.length} in total`),
            state.requests.length ? h('div', null, state.requests.map((r) => h('div', { class: 'preq' },
              h('div', { class: 'top' }, h('div', null, h('div', { class: 'code' }, r.code), h('div', { class: 'cell-sub' }, `${r.title} · ${r.substation} · ${fmtDate(r.survey_date)}`)),
                h('span', { class: 'pill ' + statusClass(r.status), style: 'margin-left:auto' }, r.status)),
              tracker(r.status))))
              : h('div', { class: 'empty' }, h('span', { class: 'ibox' }, icon('inbox')), h('div', null, 'No requests yet. Your requests will appear here.'))))));
  }

  async function load() { state.requests = (await api('GET', '/portal/api/requests')).requests; render(); }
  function render() {
    app.replaceChildren();
    if (!state.user) { app.append(authView()); return; }
    app.append(h('header', { class: 'ptop' }, brand(),
      h('div', { class: 'right' }, avatar(state.user.name), h('div', null, h('b', null, state.user.name), h('span', null, state.user.email)),
        h('button', { class: 'secondary', onclick: guard(async () => { await api('POST', '/portal/api/logout'); state.user = null; state.mode = 'login'; render(); }) }, icon('logout'), 'Sign out'))), homeView());
  }
  async function start() { state.user = (await api('GET', '/portal/api/me')).user; await load(); }
  api('GET', '/portal/api/me').then(start).catch(() => render());
})();
