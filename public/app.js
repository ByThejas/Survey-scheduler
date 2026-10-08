(() => {
  'use strict';
  /* No innerHTML anywhere: all text goes into the page as text nodes (see ui.js).
     Every screen answers four questions: what is this, who has it, what action is required, where does it go next. */
  const { h, icon, pylon, avatar, toast } = window.SurveyUI;
  const ROLE = { SEIT: 'SEIT', CHIEF: 'Chief', EE: 'Executive Engineer', AEE: 'Asst. Executive Engineer', AE: 'Assistant Engineer', ADMIN: 'Admin', PM: 'Project Manager', COORD: 'Project Coordinator', SURVEYOR: 'Surveyor', PUBLIC: 'Public requester' };
  const VIEWERS = ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE', 'COORD', 'PM']; // roles that see the request lists, the calendar and the reports
  const GROUPS = { review: 'In Review', scheduled: 'Scheduled', completed: 'Completed', rejected: 'Rejected' };
  const CATS = { action: 'Action Required', approval: 'Approvals', schedule: 'Schedule Changes', assignment: 'Assignments', system: 'System' };
  const PAGE = {
    dashboard: ['Dashboard', 'home'], req_all: ['All Requests', 'list'], req_action: ['Pending My Action', 'alert'], req_review: ['In Review', 'eye'], req_scheduled: ['Scheduled', 'calendar'],
    req_completed: ['Completed', 'check'], req_rejected: ['Rejected', 'x'], detail: ['Request', 'file'], new: ['New Survey Request', 'plus'], calendar: ['Calendar', 'calendar'],
    reports: ['Reports', 'clipboard'], notes: ['Notifications', 'bell'], offers: ['Job offers', 'inbox'], mycal: ['My calendar', 'calendar'], users: ['Users & access', 'users'], audit: ['Audit log', 'shieldCheck'],
  };
  const REQ_TABS = ['req_all', 'req_action', 'req_review', 'req_scheduled', 'req_completed', 'req_rejected'];
  const state = { user: null, tab: 'dashboard', selectedId: null, requests: [], notes: [], activity: [], navOpen: false, collapsed: false, reqOpen: true, noteCat: 'all', repTab: 'approved', cal: null, f: freshFilter() };
  const app = document.getElementById('app');

  function freshFilter() { return { q: '', zone: '', division: '', nodal_centre: '', substation: '', status: '', priority: '', from: '', to: '' }; }

  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'poc-client' }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch { /* empty */ }
    if (r.status === 401 && !url.endsWith('/login')) { state.user = null; render(); throw new Error('Please sign in again.'); }
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'bad'); } };

  /* ---------- formatting ---------- */
  const IST = { timeZone: 'Asia/Kolkata' };
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'Not available');
  const fmtDate = (d, none = 'Not scheduled') => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : none);
  const fmtLong = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtAgo = (ts) => {
    if (!ts) return 'Not available';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} h ago`;
    return new Date(ts).toLocaleDateString('en-IN', { ...IST, day: 'numeric', month: 'short' });
  };
  const fmtSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const na = (v, t = 'Not available') => (v === null || v === undefined || v === '' ? t : v);
  const daysUntil = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(SurveyCal.istToday() + 'T00:00:00Z')) / 864e5);

  /* ---------- small building blocks ---------- */
  const PRI = { Low: 'plain', Medium: 'blue', High: 'amber', Critical: 'red' };
  const priBadge = (p) => h('span', { class: 'pill pri ' + (PRI[p] || 'blue') }, p || 'Medium');
  const stageColor = (r) => (r.group === 'completed' ? 'green' : r.group === 'rejected' ? 'red' : r.stage === 'CLOSED' ? '' : r.allowed_actions && r.allowed_actions.length ? 'amber' : r.group === 'scheduled' ? 'teal' : r.stage === 'PM_COMPLETION' ? 'violet' : 'blue');
  const stageBadge = (r) => h('span', { class: 'pill ' + stageColor(r) }, r.stage_label);
  const cardHead = (ic, title, sub, end) => h('div', { class: 'card-h' }, h('span', { class: 'ibox' }, icon(ic)), h('div', null, h('h2', null, title), sub ? h('div', { class: 'sub' }, sub) : null), end ? h('div', { class: 'end' }, end) : null);
  const empty = (ic, text, btn) => h('div', { class: 'empty' }, h('span', { class: 'ibox' }, icon(ic)), h('div', null, text), btn || null);
  const chipFact = (ic, text) => h('span', { class: 'cf' }, icon(ic), text);
  const slaText = (dl) => (dl.overdue ? `Overdue by ${plural(-dl.days_left, 'day')}` : dl.days_left === 0 ? 'Due today' : `${plural(dl.days_left, 'day')} left`);
  const slaChip = (r, long) => (r.deadline ? h('span', { class: 'sla ' + r.deadline.state, title: `Due ${fmtDate(r.deadline.due)} (allowed ${plural(r.deadline.max_days, 'day')} at this stage)` },
    icon('clock'), long ? `Due ${fmtDate(r.deadline.due)} · ${slaText(r.deadline)}` : slaText(r.deadline)) : null);
  const dateLabel = (r) => (r.group === 'completed' ? 'Surveyed' : r.group === 'scheduled' ? 'Scheduled for' : r.group === 'rejected' && !r.date_proposed ? 'Not scheduled' : 'Requested');
  const dateCell = (r) => (r.group === 'rejected' && !r.date_proposed ? h('span', { class: 'muted' }, 'Not scheduled')
    : h('div', null, h('span', { class: 'datecell' }, icon('calendar'), fmtDate(r.survey_date)), h('div', { class: 'cell-sub' }, dateLabel(r))));
  const ownerText = (r) => na(r.owner_label, r.group === 'completed' ? 'None (completed)' : r.stage === 'CLOSED' ? 'None (closed)' : 'Not assigned');

  /* ---------- mail and phone buttons ---------- */
  // Links are built only from values that pass these checks, then prefixed with mailto: / tel:, so nothing else can ever become a link target.
  const safeMail = (e) => /^[^\s@<>"']+@[^\s@<>"']+$/.test(e || '');
  const safeTel = (p) => /^\+?[0-9][0-9 ]{6,16}$/.test(p || '');
  function contactBtns(p, compact) {
    return h('span', { class: 'cbtns' },
      safeMail(p.email) ? h('a', { class: 'cbtn', href: 'mailto:' + p.email, title: `Email ${p.name} (${p.email})`, 'aria-label': `Email ${p.name}` }, icon('mail'), compact ? null : 'Mail') : null,
      safeTel(p.phone) ? h('a', { class: 'cbtn', href: 'tel:' + p.phone.replace(/[^+\d]/g, ''), title: `Call ${p.name} (${p.phone})`, 'aria-label': `Call ${p.name}` }, icon('phone'), compact ? null : 'Call') : null);
  }
  const personRow = (p, tag) => h('div', { class: 'contact' + (tag === 'Current owner' ? ' now' : '') }, avatar(p.name),
    h('div', { class: 'cinfo' }, tag ? h('small', null, tag) : null, h('b', null, p.name), h('span', null, [p.title || ROLE[p.role] || p.role, p.scope].filter(Boolean).join(' · ')), h('span', null, na(p.phone, 'No phone on file'))),
    contactBtns(p, true));

  /* ---------- navigation (hash based, so Back works and links can be shared) ---------- */
  function navFor(role) {
    if (role === 'ADMIN') return [['users'], ['audit'], ['notes']];
    if (role === 'SURVEYOR') return [['dashboard', 'My surveys'], ['offers'], ['mycal'], ['notes']];
    const n = [['dashboard'], ['requests'], role === 'COORD' ? ['new', 'New Request'] : null, ['calendar'], ['reports'], ['notes']].filter(Boolean);
    return n;
  }
  const reqChildren = () => REQ_TABS.filter((k) => !(k === 'req_action' && state.user.role === 'SEIT'));
  const allowedTabs = () => navFor(state.user.role).flatMap(([k]) => (k === 'requests' ? [...reqChildren(), 'detail'] : [k, ...(k === 'dashboard' ? ['detail'] : [])]));
  function parseHash() {
    const m = (location.hash || '').replace(/^#\/?/, '').split('/');
    if (m[0] === 'request' && Number(m[1])) { state.tab = 'detail'; state.selectedId = Number(m[1]); } else { state.tab = m[0] || 'dashboard'; state.selectedId = null; }
    if (state.user && !allowedTabs().includes(state.tab)) state.tab = navFor(state.user.role)[0][0];
  }
  function go(tab, id) {
    if (tab !== state.tab || tab === 'detail') state.f = freshFilter();
    state.tab = tab; state.selectedId = id || null; state.navOpen = false;
    const hash = tab === 'detail' ? `#/request/${id}` : `#/${tab}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
    render(); window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', () => { if (state.user) { parseHash(); render(); } });

  /* ---------- modal + date picker + file picker ---------- */
  function modal(title, body, { reject = false, ic = 'file', wide = false } = {}) {
    const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) close(); } },
      h('div', { class: 'modal' + (reject ? ' reject' : '') + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-h' }, h('span', { class: 'ibox' }, icon(reject ? 'alert' : ic)), h('h2', null, title),
          h('button', { class: 'iconbtn x', 'aria-label': 'Close', onclick: close }, icon('x'))),
        h('div', { class: 'modal-b' }, body)));
    document.body.append(ov);
    return close;
  }
  const selChip = (text) => h('div', { class: 'selchip' }, icon('calendar'), h('span', null, text));
  // Calendar that marks days when NO surveyor is free (fetched from the server).
  function picker({ initial, onChange }) {
    const today = SurveyCal.istToday();
    let sel = initial && initial > today ? initial : null;
    const seed = sel || today;
    let y = Number(seed.slice(0, 4)), m = Number(seed.slice(5, 7)) - 1;
    const box = h('div');
    const draw = guard(async () => {
      const av = await api('GET', `/api/availability?month=${y}-${String(m + 1).padStart(2, '0')}`);
      const marked = {}; av.fully_booked.forEach((d) => { marked[d] = 'full'; });
      box.replaceChildren(SurveyCal.calendar({
        year: y, month: m, selected: sel, minDate: today, marked,
        legend: [['full', 'No surveyor free'], ['selected', 'Chosen date']],
        onSelect: (d) => { sel = d; onChange(d); draw(); }, onMonth: (ny, nm) => { y = ny; m = nm; draw(); },
      }));
    });
    draw();
    return box;
  }
  // File picker: up to 4 files, 2 MB each (the server checks again, including the real file type).
  function fileBox({ label = 'Attach files', max = 4 } = {}) {
    const picked = [];
    const list = h('ul', { class: 'filelist' });
    const input = h('input', { type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.docx,.xlsx', style: 'display:none', 'aria-label': label });
    const draw = () => list.replaceChildren(...picked.map((f, i) => h('li', null, icon('file'), h('span', { class: 'fname' }, f.name), h('span', { class: 'muted small' }, fmtSize(f.size)),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': `Remove ${f.name}`, onclick: () => { picked.splice(i, 1); draw(); } }, icon('x')))));
    input.addEventListener('change', () => {
      for (const f of input.files) {
        if (picked.length >= max) { toast(`Up to ${max} files at a time.`, 'bad'); break; }
        if (f.size > 2 * 1024 * 1024) { toast(`${f.name} is larger than 2 MB.`, 'bad'); continue; }
        picked.push(f);
      }
      input.value = ''; draw();
    });
    const read = (f) => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res({ name: f.name, data: String(r.result).split(',')[1] || '' });
      r.onerror = () => rej(new Error(`Could not read ${f.name}.`));
      r.readAsDataURL(f);
    });
    return {
      el: h('div', { class: 'filebox' }, h('button', { type: 'button', class: 'secondary', onclick: () => input.click() }, icon('paperclip'), label), input,
        h('div', { class: 'hint' }, 'PDF, PNG, JPG, DOCX or XLSX · up to 4 files · 2 MB each'), list),
      count: () => picked.length, files: () => Promise.all(picked.map(read)),
    };
  }

  /* ---------- actions on a request: every one opens a confirmation dialog ---------- */
  const LABEL = { upload_documents: 'Upload Documents', approve_lc: 'Approve Request', start_review: 'Receive & Send to Review', backtrack: 'Backtrack to AE', reject: 'Reject Request', reschedule: 'Reschedule Survey',
    accept_intake: 'Accept Public Request', decline_intake: 'Decline Request', resubmit: 'Submit Revised Request', assign: 'Assign Surveyor', submit_report: 'Submit Report', return_report: 'Return for Correction', complete: 'Approve Report' };
  const ICON = { approve: 'fwd', approve_lc: 'check', start_review: 'eye', backtrack: 'undo', upload_documents: 'upload', reject: 'x', reschedule: 'calendar', accept_intake: 'check', decline_intake: 'x', resubmit: 'send', assign: 'user', submit_report: 'file', return_report: 'undo', complete: 'check' };
  const DANGER = ['reject', 'decline_intake'];
  const actionLabel = (a, r) => {
    if (a === 'approve') return r.stage === 'CHIEF_MONITOR' ? 'Verify & Send to Surveyor' : `Approve & Forward to ${r.forward_to}`;
    if (a === 'submit_report' && r.return_note) return 'Resubmit Report';
    return LABEL[a];
  };
  const aeDocs = (d) => d.documents.filter((x) => x.kind === 'AE_DOCS' && x.current);

  // A comment box with a clear "required" / "optional" label.
  function commentBox({ required, label = 'Comment', placeholder = '', min = 5, rows = 3 }) {
    const ta = h('textarea', { rows, maxlength: 500, 'aria-label': label, placeholder });
    return {
      el: [h('label', null, label, ' ', h('span', required ? { class: 'req' } : { class: 'opt' }, required ? '(required)' : '(optional)')), ta],
      value: () => ta.value.trim(),
      check: () => (required && ta.value.trim().length < min ? `${label} is required (at least ${min} characters).` : null),
    };
  }
  /* The one confirmation dialog. submit() returns { error } to stay open, or { toast } after calling the API. */
  function confirmDialog({ req, title, ic, danger, notice, blocks = [], label, cls, submit }) {
    const err = h('div', { class: 'err', role: 'alert' });
    let busy = false;
    const btn = h('button', { class: cls || (danger ? 'danger solid' : ''), onclick: async () => {
      if (busy) return;
      err.textContent = ''; busy = true; btn.disabled = true;
      try {
        const out = await submit();
        if (out && out.error) err.textContent = out.error;
        else { close(); toast((out && out.toast) || 'Done.'); await reloadAll(); }
      } catch (e) { err.textContent = e.message; }
      busy = false; btn.disabled = false;
    } }, icon(ic || 'check'), label);
    const close = modal(title, h('div', null,
      req ? h('div', { class: 'dlg-ctx' }, h('b', null, req.display_code), ' · ', req.title, h('div', { class: 'cell-sub' }, `${req.substation} · ${req.stage_label}`)) : null,
      notice ? h('div', { class: 'notice ' + (notice.tone || 'blue') }, icon(notice.icon || 'alert'), h('span', null, notice.text)) : null,
      blocks, err,
      h('div', { class: 'actions' }, btn, h('button', { class: 'secondary', onclick: () => close() }, 'Cancel'))), { reject: !!danger, ic });
    return close;
  }
  const post = (req, action, body) => api('POST', `/api/requests/${req.id}/${action}`, body);

  const actions = {
    approve: (req, d) => {
      const isAE = req.stage === 'AE_SUBSTATION', chief = req.stage === 'CHIEF_MONITOR';
      const cm = commentBox({ required: false, placeholder: chief ? 'Optional note' : `Optional note for the ${req.forward_to}` });
      const files = isAE ? fileBox({ label: 'Add documents' }) : null;
      const have = isAE ? aeDocs(d).length : 0;
      confirmDialog({ req, title: actionLabel('approve', req), ic: chief ? 'check' : 'fwd', cls: chief ? 'green' : '', label: actionLabel('approve', req),
        notice: chief ? { icon: 'pin', text: 'After this, the nearest free surveyor is offered the job. SEIT can see every step but approves nothing.' }
          : isAE ? { icon: 'paperclip', tone: have ? 'blue' : 'amber', text: have ? `${plural(have, 'document')} already saved. You can add more before forwarding.` : 'Attach the substation documents. At least one is needed before this can go to the AEE.' }
            : { icon: 'fwd', text: `This sends the request to ${req.next_label || req.forward_to}.` },
        blocks: [isAE ? files.el : null, cm.el],
        submit: async () => {
          if (isAE && !have && !files.count()) return { error: 'Please attach at least one document.' };
          const body = { remarks: cm.value() || undefined };
          if (isAE) body.files = await files.files();
          await post(req, 'approve', body);
          return { toast: chief ? 'Approved. A nearby surveyor is being offered the job.' : `Forwarded to ${req.forward_to}.` };
        } });
    },
    upload_documents: (req, d) => {
      const files = fileBox({ label: 'Choose documents' });
      const have = aeDocs(d);
      confirmDialog({ req, title: 'Upload Documents', ic: 'upload', label: 'Save documents',
        notice: { icon: 'clock', text: `Save documents as you prepare them. Nobody else sees them until you forward to the AEE. Due ${fmtDate(req.deadline && req.deadline.due, 'soon')}.` },
        blocks: [have.length ? h('ul', { class: 'filelist' }, have.map((x) => h('li', null, icon('file'), h('span', { class: 'fname' }, x.name), h('span', { class: 'muted small' }, fmtSize(x.size))))) : null, files.el],
        submit: async () => { if (!files.count()) return { error: 'Please choose at least one file.' }; await post(req, 'upload_documents', { files: await files.files() }); return { toast: 'Documents saved.' }; } });
    },
    approve_lc: (req) => {
      const cm = commentBox({ required: false, placeholder: 'Optional note' });
      confirmDialog({ req, title: 'Approve Request', ic: 'check', label: 'Approve Request',
        notice: { tone: 'amber', text: 'Once you approve, the request can no longer be rejected or rescheduled. You then prepare the substation documents (4 days) and forward them to the AEE.' },
        blocks: [cm.el], submit: async () => { await post(req, 'approve_lc', { remarks: cm.value() || undefined }); return { toast: 'Request approved. Now prepare the documents.' }; } });
    },
    start_review: (req) => {
      const cm = commentBox({ required: false, placeholder: 'Optional note' });
      confirmDialog({ req, title: 'Receive & Send to Review', ic: 'eye', label: 'Receive & Send to Review',
        notice: { text: 'You confirm the request has reached you. You then review it and verify it for the survey.' },
        blocks: [cm.el], submit: async () => { await post(req, 'start_review', { remarks: cm.value() || undefined }); return { toast: 'Received and sent to review.' }; } });
    },
    backtrack: (req) => {
      const cm = commentBox({ required: true, label: 'What must the AE correct?' });
      confirmDialog({ req, title: 'Backtrack to AE', ic: 'undo', label: 'Send back to AE',
        notice: { text: req.stage === 'EE_REVISIT' ? 'It goes straight to the AE, skipping the AEE. The AEE is notified. The AE has 4 days to correct and forward it again.' : 'It goes back to the AE, who has 4 days to correct and forward it again. The EE is notified.' },
        blocks: [cm.el], submit: async () => { const e = cm.check(); if (e) return { error: e }; await post(req, 'backtrack', { reason: cm.value() }); return { toast: 'Sent back to the AE.' }; } });
    },
    reject: (req) => {
      const cm = commentBox({ required: true, label: 'Reason for rejection', placeholder: 'e.g. Drawings are incomplete' });
      confirmDialog({ req, title: 'Reject Request', ic: 'x', danger: true, label: 'Reject Request',
        notice: { tone: 'red', icon: 'alert', text: 'The request goes back to the Project Coordinator, who prepares a revised request. The reason is shared with every authority in the chain. To change only the survey date, use Reschedule Survey instead.' },
        blocks: [cm.el], submit: async () => { const e = cm.check(); if (e) return { error: e }; await post(req, 'reject', { reason: cm.value() }); return { toast: 'Rejected. The chain has been notified.' }; } });
    },
    reschedule: (req) => {
      let date = null;
      const cm = commentBox({ required: true, label: 'Reason for rescheduling', placeholder: 'e.g. Line shutdown not possible that week' });
      const chosen = selChip(`Current date: ${fmtDate(req.survey_date)}. No new date chosen yet.`);
      confirmDialog({ req, title: 'Reschedule Survey', ic: 'calendar', label: 'Reschedule Survey',
        notice: { text: 'The request stays at its current stage. Only the survey date changes, and everyone in the chain is told.' },
        blocks: [h('label', null, 'New survey date ', h('span', { class: 'req' }, '(required)')), picker({ onChange: (x) => { date = x; chosen.lastChild.textContent = `New date: ${fmtDate(x)} (was ${fmtDate(req.survey_date)})`; } }), chosen, cm.el],
        submit: async () => { if (!date) return { error: 'Please pick the new survey date.' }; const e = cm.check(); if (e) return { error: e }; await post(req, 'reschedule', { reason: cm.value(), new_date: date }); return { toast: `Survey moved to ${fmtDate(date)}.` }; } });
    },
    accept_intake: (req) => {
      const cm = commentBox({ required: false });
      confirmDialog({ req, title: 'Accept Public Request', ic: 'check', label: 'Accept Public Request', notice: { text: 'The request enters the approval chain, starting with the Executive Engineer.' },
        blocks: [cm.el], submit: async () => { await post(req, 'accept_intake', { remarks: cm.value() || undefined }); return { toast: 'Accepted. The approval chain starts.' }; } });
    },
    decline_intake: (req) => {
      const cm = commentBox({ required: true, label: 'Reason' });
      confirmDialog({ req, title: 'Decline Public Request', ic: 'x', danger: true, label: 'Decline Request', blocks: [cm.el],
        submit: async () => { const e = cm.check(); if (e) return { error: e }; await post(req, 'decline_intake', { reason: cm.value() }); return { toast: 'Request declined.' }; } });
    },
    resubmit: (req) => {
      let date = req.date_proposed ? req.survey_date : null;
      const chosen = selChip(date ? `Date: ${fmtDate(date)}` : 'No date chosen yet');
      const cm = commentBox({ required: false, label: 'What changed in the revised request?' });
      const files = fileBox({ label: 'Attach supporting documents' });
      confirmDialog({ req, title: 'Submit Revised Request', ic: 'send', label: 'Submit Revised Request',
        notice: { tone: 'red', text: `Rejected at "${req.rejected_stage}" by ${req.rejected_by}: ${String(req.rejection_reason || '').replace(/[.\s]+$/, '')}.` },
        blocks: [h('label', null, 'Survey date ', h('span', { class: 'req' }, '(required)')), picker({ initial: date, onChange: (x) => { date = x; chosen.lastChild.textContent = `Date: ${fmtDate(x)}`; } }), chosen, cm.el,
          h('label', null, 'Supporting documents ', h('span', { class: 'req' }, '(required)')), files.el],
        submit: async () => {
          if (!date) return { error: 'Please choose a date.' };
          if (!files.count()) return { error: 'Please attach the supporting documents.' };
          await post(req, 'resubmit', { survey_date: date, remarks: cm.value() || undefined, files: await files.files() });
          return { toast: 'Revised request submitted.' };
        } });
    },
    assign: guard(async (req) => {
      const { surveyors } = await api('GET', `/api/surveyors?date=${req.survey_date}`);
      const sel = h('select', { 'aria-label': 'Surveyor' }, surveyors.map((s) => h('option', { value: s.id, disabled: !s.free }, `${s.name}${s.free ? '' : ' - already booked that day'}${s.online ? '' : ' (offline)'}`)));
      const cm = commentBox({ required: false });
      confirmDialog({ req, title: 'Assign Surveyor', ic: 'user', label: 'Assign Surveyor', notice: { text: `Survey date ${fmtDate(req.survey_date)}. Use this when no nearby surveyor accepted.` },
        blocks: [h('label', null, 'Surveyor'), sel, cm.el], submit: async () => { await post(req, 'assign', { surveyor_id: Number(sel.value), remarks: cm.value() || undefined }); return { toast: 'Surveyor assigned.' }; } });
    }),
    submit_report: (req) => {
      const ta = h('textarea', { rows: 5, maxlength: 2000, 'aria-label': 'Report summary' });
      confirmDialog({ req, title: req.return_note ? 'Resubmit Report' : 'Submit Report', ic: 'file', label: req.return_note ? 'Resubmit Report' : 'Submit Report',
        notice: req.return_note ? { tone: 'red', text: `Returned for correction: ${req.return_note}` } : null,
        blocks: [h('label', null, 'Report summary ', h('span', { class: 'req' }, '(required)')), ta],
        submit: async () => { if (ta.value.trim().length < 10) return { error: 'Please write at least 10 characters.' }; await post(req, 'submit_report', { report: ta.value.trim() }); return { toast: 'Report submitted to the Project Manager.' }; } });
    },
    return_report: (req) => {
      const cm = commentBox({ required: true, label: 'What needs correcting?' });
      confirmDialog({ req, title: 'Return for Correction', ic: 'undo', label: 'Return for Correction', notice: { text: 'The report goes back to the surveyor, who corrects it and submits it again.' },
        blocks: [cm.el], submit: async () => { const e = cm.check(); if (e) return { error: e }; await post(req, 'return_report', { reason: cm.value() }); return { toast: 'Returned to the surveyor.' }; } });
    },
    complete: (req) => {
      const cm = commentBox({ required: false });
      confirmDialog({ req, title: 'Approve Report', ic: 'check', cls: 'green', label: 'Approve Report', notice: { text: 'The request is marked completed and closed with its report.' },
        blocks: [cm.el], submit: async () => { await post(req, 'complete', { remarks: cm.value() || undefined }); return { toast: 'Report approved. Request completed.' }; } });
    },
  };

  /* ---------- sign-in ---------- */
  function loginView() {
    const u = h('input', { id: 'u', autocomplete: 'username', 'aria-label': 'Username', placeholder: 'e.g. ee_n' });
    const p = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const err = h('div', { class: 'err', role: 'alert' });
    const go2 = async () => {
      try { await api('POST', '/api/login', { username: u.value, password: p.value }); await start(); }
      catch (e) { err.textContent = e.message; }
    };
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') go2(); });
    const chip = (name) => h('button', { type: 'button', onclick: () => { u.value = name; p.value = 'Demo@12345!'; p.focus(); } }, name);
    const feature = (ic, t, s) => h('div', { class: 'feature' }, h('span', { class: 'ibox' }, icon(ic)), h('div', null, h('b', null, t), h('span', null, s)));
    return h('div', { class: 'auth' },
      h('section', { class: 'auth-hero' },
        h('div', { class: 'brandmark' }, h('span', { class: 'logo' }, icon('zap')), h('div', null, h('b', null, 'KPTCL CMS'), h('span', null, 'Survey Management'))),
        h('h1', null, 'Substation Survey Management & Scheduling'),
        h('p', { class: 'lead' }, 'Request, approve, schedule and close substation surveys in one place, with a clear owner and a clear next step at every stage.'),
        h('div', { class: 'features' },
          feature('layers', 'Follows the KPTCL hierarchy', 'Chief by zone, Executive Engineer by division, Assistant Executive Engineer by nodal centre, Assistant Engineer by substation.'),
          feature('clock', 'Deadlines you can see', 'Every stage shows who has the request, what they must do and how many days are left.'),
          feature('calendar', 'Calendar and reports', 'Every survey by date, with approved, scheduled and rejected reports.'),
          feature('shieldCheck', 'Role-based and recorded', 'Each person sees only their own work. Every action is logged.')),
        pylon()),
      h('section', { class: 'auth-form' }, h('div', { class: 'auth-card' },
        h('h2', null, 'Sign in'), h('p', { class: 'muted' }, 'Use your CMS account. Your role decides what you see.'),
        h('label', { for: 'u' }, 'Username'), u, h('label', { for: 'p' }, 'Password'), p, err,
        h('button', { class: 'wide', onclick: go2 }, 'Sign in', icon('arrow')),
        h('div', { class: 'demo' },
          h('h4', null, 'Demo accounts · KPTCL'), h('div', { class: 'chips' }, ['ee_n', 'aee_n', 'ae_n1', 'chief1', 'seit1'].map(chip)),
          h('h4', null, 'Demo accounts · Office'), h('div', { class: 'chips' }, ['coord1', 'sur1', 'sur2', 'sur3', 'pm1', 'admin1'].map(chip)),
          h('p', { class: 'small muted' }, 'Demo data only. Public users request surveys at ', h('a', { href: '/portal' }, '/portal'), '.')))));
  }

  /* ---------- app shell ---------- */
  const scopeLines = (u) => [u.division, u.nodal_centre && u.role !== 'EE' && u.role !== 'CHIEF' ? u.nodal_centre : null, u.substation, u.zone].filter(Boolean);
  const unreadCount = () => state.notes.filter((n) => !n.is_read).length;
  const pendingCount = () => state.requests.filter((r) => r.allowed_actions.length).length;

  function shell() {
    const role = state.user.role;
    const body = h('main', { id: 'main' });
    const views = { dashboard: role === 'SURVEYOR' ? surveyorDashboard : dashboardView, detail: detailView, new: newView, calendar: calendarPage, reports: reportsView, notes: notesView, offers: offersView, mycal: myCalendarView, users: usersView, audit: auditView };
    (REQ_TABS.includes(state.tab) ? (r) => requestsView(r, state.tab) : views[state.tab])(body);
    const ctx = scopeLines(state.user);
    const today = new Date().toLocaleDateString('en-IN', { ...IST, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const badge = (n) => (n ? h('span', { class: 'count' }, n) : null);
    const item = (k, label, sub) => h('button', { class: (state.tab === k || (k === 'dashboard' && state.tab === 'detail' && role === 'SURVEYOR') ? 'on' : '') + (sub ? ' sub' : ''), 'data-tab': k, title: label, onclick: () => go(k) },
      icon(PAGE[k][1]), h('span', { class: 'lbl' }, label), k === 'notes' ? badge(unreadCount()) : k === 'req_action' ? badge(pendingCount()) : null);
    const onReq = REQ_TABS.includes(state.tab) || state.tab === 'detail';
    const nav = navFor(role).map(([k, label]) => {
      if (k !== 'requests') return item(k, label || PAGE[k][0]);
      return [h('button', { class: 'nav-parent' + (onReq ? ' on-parent' : ''), 'aria-expanded': String(state.reqOpen || onReq), title: 'Requests', onclick: () => { state.reqOpen = !state.reqOpen; render(); } },
        icon('layers'), h('span', { class: 'lbl' }, 'Requests'), h('span', { class: 'chev' + (state.reqOpen || onReq ? ' open' : '') }, icon('chevron'))),
      state.reqOpen || onReq ? h('div', { class: 'subnav' }, reqChildren().map((c) => item(c, PAGE[c][0], true))) : null];
    });
    const title = state.tab === 'dashboard' && role === 'SURVEYOR' ? 'My surveys' : PAGE[state.tab][0];
    return h('div', { class: 'layout' + (state.collapsed ? ' collapsed' : '') + (state.navOpen ? ' navopen' : '') },
      h('aside', { class: 'sidebar', 'aria-label': 'Main navigation' },
        h('div', { class: 'brandmark' }, h('span', { class: 'logo' }, icon('zap')), h('div', { class: 'bt' }, h('b', null, 'KPTCL CMS'), h('span', null, 'Survey Management')),
          h('button', { class: 'iconbtn collapse', 'aria-label': 'Collapse or expand the menu', title: 'Collapse menu', onclick: () => { state.collapsed = !state.collapsed; render(); } }, icon('list'))),
        h('nav', { class: 'nav' }, nav),
        h('div', { class: 'spacer' }),
        h('div', { class: 'usercard' }, avatar(state.user.name),
          h('div', { class: 'who' }, h('b', null, state.user.name), h('span', { class: 'role' }, ROLE[role]), ctx.map((c) => h('span', null, c))),
          h('button', { class: 'iconbtn', title: 'Sign out', 'aria-label': 'Sign out', onclick: guard(async () => { await api('POST', '/api/logout'); state.user = null; render(); }) }, icon('logout')))),
      h('div', { class: 'scrim', onclick: () => { state.navOpen = false; render(); } }),
      h('div', { class: 'content' },
        h('header', { class: 'topbar' },
          h('button', { class: 'iconbtn menu', 'aria-label': 'Open the menu', onclick: () => { state.navOpen = true; render(); } }, icon('list')),
          h('div', { class: 'tb-title' }, h('div', { class: 'crumb' }, 'KPTCL CMS', h('span', null, '›'), 'Survey Management'), h('h1', null, title)),
          h('div', { class: 'right' }, h('span', { class: 'chip' }, icon('calendar'), today), role === 'ADMIN' ? h('span', { class: 'chip poc' }, 'DEMO ENVIRONMENT') : null,
            h('button', { class: 'iconbtn bell', 'aria-label': `Notifications, ${unreadCount()} unread`, title: 'Notifications', onclick: () => go('notes') }, icon('bell'), unreadCount() ? h('span', { class: 'bdot' }, unreadCount()) : null))),
        body));
  }

  /* ---------- request lists: one set of numbers everywhere ---------- */
  const inKey = {
    req_all: () => true,
    req_action: (r) => r.allowed_actions.length > 0,
    req_review: (r) => r.group === 'review',
    req_scheduled: (r) => r.group === 'scheduled',
    req_completed: (r) => r.group === 'completed',
    req_rejected: (r) => r.group === 'rejected',
  };
  const byKey = (k) => state.requests.filter(inKey[k]);
  const urgency = (r) => (r.deadline ? r.deadline.days_left : 99);
  const recent = (a, b) => b.updated_at - a.updated_at;

  function dataTable(cols, rows, { onRow, cls } = {}) {
    return h('div', { class: 'tw' }, h('table', { class: 'rtable ' + (cls || '') },
      h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.cls || '' }, c.h)))),
      h('tbody', null, rows.map((r) => h('tr', { class: 'row' + (r.todo ? ' todo' : ''), 'data-id': r.id, tabindex: 0, title: 'Open this request', onclick: () => onRow(r), onkeydown: (e) => { if (e.key === 'Enter') onRow(r); } },
        r.cells.map((c, i) => h('td', { 'data-label': cols[i].h, class: cols[i].cls || '' }, c)))))));
  }
  const reqCell = (r) => h('div', null, h('div', { class: 'code' }, r.display_code, r.source === 'portal' ? [' ', h('span', { class: 'tag portal' }, 'Public')] : null, r.revision ? [' ', h('span', { class: 'tag' }, 'Revised')] : null), h('div', { class: 'cell-title' }, r.title), h('div', { class: 'cell-sub' }, r.survey_type));
  const stageCell = (r) => h('div', null, stageBadge(r), r.deadline ? h('div', { style: 'margin-top:4px' }, slaChip(r)) : null);
  const reqRow = (r) => ({ id: r.id, todo: r.allowed_actions.length > 0, cells: [reqCell(r), stageCell(r), ownerText(r), r.substation, dateCell(r), priBadge(r.priority), h('span', { title: fmtTime(r.updated_at) }, fmtAgo(r.updated_at))] });
  const REQ_COLS = [{ h: 'Request', cls: 'c-req' }, { h: 'Stage' }, { h: 'Current Owner' }, { h: 'Substation' }, { h: 'Survey Date' }, { h: 'Priority' }, { h: 'Last Updated' }];
  const openReq = (r) => go('detail', r.id);

  /* ----- hierarchy filters: locked to the officer's own place in KPTCL ----- */
  const HIER = [['zone', 'Zone'], ['division', 'Division'], ['nodal_centre', 'Nodal Centre'], ['substation', 'Substation']];
  const LOCKED = { CHIEF: ['zone'], EE: ['zone', 'division'], AEE: ['zone', 'division', 'nodal_centre'], AE: ['zone', 'division', 'nodal_centre', 'substation'] };
  const lockedValue = (k) => (state.user[k] || (k === 'nodal_centre' ? null : null));

  function requestsView(root, key) {
    const f = state.f, role = state.user.role;
    const base = byKey(key);
    const locks = LOCKED[role] || [];
    const tableBox = h('div'), filterBox = h('div', { class: 'filters' }), countEl = h('span', { class: 'muted' });
    const desc = { req_all: 'Every request you are allowed to see.', req_action: 'Requests waiting for your decision. Oldest deadline first.', req_review: 'Requests moving through the approval chain.',
      req_scheduled: 'Approved requests waiting for a surveyor or with a survey date.', req_completed: 'Surveys finished and closed with a report.', req_rejected: 'Rejected requests waiting for a revised submission.' }[key];
    const match = (r) => {
      const q = f.q.trim().toLowerCase();
      if (q && ![r.display_code, r.code, r.title, r.substation, r.nodal_centre, r.division, r.survey_type, r.owner_label].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      for (const [k] of HIER) if (f[k] && !locks.includes(k) && (r[k] || 'Not assigned') !== f[k]) return false;
      if (f.status && r.group !== f.status) return false;
      if (f.priority && r.priority !== f.priority) return false;
      if (f.from && r.survey_date < f.from) return false;
      if (f.to && r.survey_date > f.to) return false;
      return true;
    };
    const anyFilter = () => f.q || f.status || f.priority || f.from || f.to || HIER.some(([k]) => f[k] && !locks.includes(k));
    const clear = () => { Object.assign(f, freshFilter()); drawFilters(); paint(); };
    function paint() {
      const rows = base.filter(match).sort(key === 'req_action' ? (a, b) => urgency(a) - urgency(b) || recent(a, b) : recent);
      countEl.textContent = rows.length === base.length ? plural(rows.length, 'request') : `${rows.length} of ${plural(base.length, 'request')}`;
      tableBox.replaceChildren(rows.length ? dataTable(REQ_COLS, rows.map(reqRow), { onRow: openReq, cls: 'reqtable' })
        : empty('inbox', anyFilter() ? 'No requests match these filters.' : { req_action: 'Nothing is waiting for you right now.', req_rejected: 'No request has been rejected.', req_completed: 'No survey has been completed yet.', req_scheduled: 'No survey is scheduled yet.' }[key] || 'No requests to show.',
          anyFilter() ? h('button', { class: 'secondary', onclick: clear }, icon('x'), 'Clear filters') : null));
    }
    function drawFilters() {
      const search = h('div', { class: 'searchbox' }, icon('search'), h('input', { type: 'search', placeholder: 'Search by ID, title, substation, nodal centre or survey type', 'aria-label': 'Search requests', value: f.q,
        oninput: (e) => { f.q = e.target.value; paint(); } }));
      const sel = (label, k, opts, locked, extra) => {
        const s = h('select', { 'aria-label': label, 'data-f': k, disabled: locked, onchange: (e) => { f[k] = e.target.value; if (extra) extra(); drawFilters(); paint(); } },
          locked ? h('option', null, na(lockedValue(k), 'Not assigned')) : [h('option', { value: '' }, `All`), opts.map(([v, t]) => h('option', { value: v, selected: f[k] === v }, t || v))]);
        return h('label', { class: 'fsel' + (locked ? ' locked' : '') }, h('span', null, label, locked ? [' ', icon('lock')] : null), s);
      };
      const hier = HIER.map(([k, name], i) => {
        const locked = locks.includes(k);
        const parents = HIER.slice(0, i).map((x) => x[0]).filter((pk) => !locks.includes(pk));
        const vals = [...new Set(base.filter((r) => parents.every((pk) => !f[pk] || (r[pk] || 'Not assigned') === f[pk])).map((r) => r[k] || 'Not assigned'))].sort();
        if (f[k] && !locked && !vals.includes(f[k])) f[k] = '';
        return sel(name, k, vals.map((v) => [v]), locked, () => HIER.slice(i + 1).forEach(([c]) => { f[c] = ''; }));
      });
      const status = key === 'req_all' ? sel('Status', 'status', Object.entries(GROUPS), false) : null;
      const pri = sel('Priority', 'priority', ['Low', 'Medium', 'High', 'Critical'].map((v) => [v]), false);
      const date = (label, k) => h('label', { class: 'fsel' }, h('span', null, label), h('input', { type: 'date', 'aria-label': label, value: f[k], onchange: (e) => { f[k] = e.target.value; paint(); } }));
      filterBox.replaceChildren(search, h('div', { class: 'frow' }, hier, status, pri, date('Survey date from', 'from'), date('to', 'to'),
        anyFilter() ? h('button', { class: 'secondary small', onclick: clear }, icon('x'), 'Clear filters') : null));
    }
    drawFilters(); paint();
    root.append(h('div', { class: 'page-intro' }, h('p', { class: 'muted' }, desc), countEl),
      h('div', { class: 'card filtercard' }, filterBox), h('div', { class: 'card flush' }, tableBox));
  }

  /* ---------- dashboard ---------- */
  function actionOf(r) { return r.allowed_actions.length ? actionLabel(r.allowed_actions[0], r) : null; }
  function dashboardView(root) {
    const role = state.user.role, all = state.requests;
    const todo = byKey('req_action').sort((a, b) => urgency(a) - urgency(b) || recent(a, b));
    const cnt = (k) => byKey(k).length;
    const tile = (k, ic, tone, label) => h('button', { type: 'button', class: 'kpi clickable', 'data-kpi': k, title: `Open: ${label}`, onclick: () => go(k) },
      h('span', { class: 'ibox ' + tone }, icon(ic)), h('div', null, h('b', null, cnt(k)), h('span', null, label)));
    const kpis = h('div', { class: 'kpis' },
      role === 'SEIT' ? tile('req_all', 'list', 't-blue', 'All Requests') : tile('req_action', 'alert', 't-amber', 'Action Required'),
      tile('req_review', 'eye', 't-blue', 'In Review'), tile('req_scheduled', 'calendar', 't-teal', 'Scheduled'), tile('req_completed', 'check', 't-green', 'Completed'), tile('req_rejected', 'x', 't-red', 'Rejected'));

    const intro = h('div', { class: 'welcome' }, h('div', null, h('h2', null, `Welcome, ${state.user.name}`),
      h('p', { class: 'muted' }, [ROLE[role], ...scopeLines(state.user)].join(' · '))),
      role === 'COORD' ? h('button', { onclick: () => go('new') }, icon('plus'), 'New Survey Request') : null);

    const needs = role === 'SEIT' ? h('div', { class: 'idle' }, icon('eye'), 'SEIT watches every request and approves nothing.')
      : todo.length ? h('section', { class: 'card action-required', 'aria-label': 'Action required' },
        cardHead('alert', 'Action Required', `${plural(todo.length, 'request')} waiting for your decision`, todo.length > 4 ? h('button', { class: 'secondary', onclick: () => go('req_action') }, `View all ${todo.length}`, icon('arrow')) : null),
        h('div', { class: 'ar-cards' }, todo.slice(0, 4).map((r) => h('article', { class: 'ar-card ' + (r.deadline ? r.deadline.state : '') , 'data-id': r.id },
          h('div', { class: 'ar-top' }, h('b', null, r.display_code), priBadge(r.priority)),
          h('div', { class: 'cell-title' }, r.title), h('div', { class: 'cell-sub' }, r.substation),
          h('div', { class: 'ar-row' }, stageBadge(r), slaChip(r)),
          h('div', { class: 'ar-act' }, icon('flag'), actionOf(r)),
          h('button', { onclick: () => openReq(r) }, 'Review', icon('arrow'))))))
        : h('div', { class: 'idle' }, icon('check'), role === 'ADMIN' ? 'Nothing needs you.' : 'Nothing is waiting for you right now.');

    const recentRows = [...all].sort(recent).slice(0, 5);
    const rc = h('div', { class: 'card flush' }, h('div', { class: 'padh' }, cardHead('list', 'Recent Requests', 'Latest changes', h('button', { class: 'secondary', onclick: () => go('req_all') }, 'View all', icon('arrow')))),
      recentRows.length ? dataTable([{ h: 'Request', cls: 'c-req' }, { h: 'Stage' }, { h: 'Updated' }],
        recentRows.map((r) => ({ id: r.id, todo: r.allowed_actions.length > 0, cells: [reqCell(r), h('div', null, stageBadge(r), h('div', { class: 'cell-sub' }, ownerText(r))), fmtAgo(r.updated_at)] })), { onRow: openReq, cls: 'mini' }) : empty('inbox', 'No requests yet.'));

    const today = SurveyCal.istToday();
    const upcoming = all.filter((r) => r.group === 'scheduled' && r.survey_date >= today).sort((a, b) => a.survey_date.localeCompare(b.survey_date)).slice(0, 5);
    const uc = h('div', { class: 'card' }, cardHead('calendar', 'Upcoming Surveys', 'Next scheduled dates'),
      upcoming.length ? h('ul', { class: 'upl' }, upcoming.map((r) => h('li', { tabindex: 0, onclick: () => openReq(r), onkeydown: (e) => { if (e.key === 'Enter') openReq(r); } },
        h('div', { class: 'ud' }, h('b', null, new Date(r.survey_date + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric' })), h('span', null, new Date(r.survey_date + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'short' }))),
        h('div', { class: 'ui' }, h('b', null, r.display_code, ' · ', r.title), h('span', null, r.substation), h('span', null, r.surveyor ? `Surveyor: ${r.surveyor}` : 'Surveyor: Not assigned')), stageBadge(r))))
        : empty('calendar', 'No upcoming surveys.', h('button', { class: 'secondary', onclick: () => go('req_scheduled') }, 'View all scheduled surveys')));

    const miniCal = h('div', { class: 'card' }, cardHead('calendar', 'Calendar', 'Click a date to see its surveys'), miniCalendar());
    const act = h('div', { class: 'card' }, cardHead('activity', 'Recent Activity', 'What changed across your requests'), h('div', { id: 'activity' }, state.activity.length ? activityList(state.activity.slice(0, 6), true) : empty('activity', 'No activity yet.')));
    root.append(intro, kpis, needs, h('div', { class: 'grid cols-even dash2' }, rc, uc), h('div', { class: 'grid cols-even dash2' }, miniCal, act));
  }
  const activityList = (events, withReq) => h('ul', { class: 'timeline act' }, events.map((e) => h('li', { class: /reject|return|backtrack|deadline/i.test(e.action) ? 'reject' : /complete|approved|accepted|scheduled/i.test(e.action) ? 'good' : '' },
    h('div', { class: 'when' }, fmtTime(e.ts), withReq && e.display_code ? [' · ', h('a', { href: `#/request/${e.request_id}`, onclick: (ev) => { ev.preventDefault(); go('detail', e.request_id); } }, e.display_code)] : null),
    h('b', null, e.text), e.result ? h('div', { class: 'res' }, e.result) : null,
    e.comment ? h('div', { class: 'say' }, e.comment) : null)));

  /* ---------- calendar (one data source: the request list) ---------- */
  const calCat = (r) => (r.group === 'review' ? 'approval' : r.group === 'scheduled' ? 'scheduled' : r.group === 'completed' ? 'done' : null);
  const CAL_LEGEND = [['approval', 'Pending'], ['scheduled', 'Scheduled'], ['done', 'Completed'], ['today', 'Today']];
  function calState() { const t = SurveyCal.istToday(); return state.cal || (state.cal = { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) - 1, sel: t }); }
  function calMarks(y, m) {
    const marked = {}, counts = {}, month = `${y}-${String(m + 1).padStart(2, '0')}-`;
    const rank = { approval: 3, scheduled: 2, done: 1 };
    state.requests.forEach((r) => {
      const c = calCat(r);
      if (!c || !r.survey_date.startsWith(month)) return;
      counts[r.survey_date] = (counts[r.survey_date] || 0) + 1;
      if (!marked[r.survey_date] || rank[c] > rank[marked[r.survey_date]]) marked[r.survey_date] = c;
    });
    return { marked, counts };
  }
  function miniCalendar() {
    const cs = calState(), box = h('div');
    const draw = () => { const { marked, counts } = calMarks(cs.y, cs.m);
      box.replaceChildren(SurveyCal.calendar({ year: cs.y, month: cs.m, selected: cs.sel, marked, counts, legend: CAL_LEGEND, onSelect: (d) => { cs.sel = d; go('calendar'); }, onMonth: (y, m) => { cs.y = y; cs.m = m; draw(); } })); };
    draw();
    return box;
  }
  function calendarPage(root) {
    const cs = calState();
    const calBox = h('div', { class: 'card' }), dayBox = h('div', { class: 'card' });
    const dayItem = (r) => h('article', { class: 'dayitem ' + calCat(r) },
      h('div', { class: 'di-top' }, h('div', null, h('div', { class: 'code' }, r.display_code), h('div', { class: 'cell-title' }, r.title)), stageBadge(r)),
      h('div', { class: 'di-facts' }, chipFact('zap', r.substation), chipFact('user', `Owner: ${ownerText(r)}`), chipFact('user', `Surveyor: ${na(r.surveyor, 'Not assigned')}`), priBadge(r.priority), slaChip(r)),
      h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'secondary', onclick: () => openReq(r) }, icon('file'), 'Open request')));
    const paint = () => {
      const { marked, counts } = calMarks(cs.y, cs.m);
      calBox.replaceChildren(cardHead('calendar', 'Survey calendar', 'Every survey by date. Click a day to see the details.'),
        SurveyCal.calendar({ year: cs.y, month: cs.m, selected: cs.sel, marked, counts, legend: CAL_LEGEND, onSelect: (d) => { cs.sel = d; paint(); }, onMonth: (y, m) => { cs.y = y; cs.m = m; paint(); } }));
      const items = state.requests.filter((r) => calCat(r) && r.survey_date === cs.sel);
      dayBox.replaceChildren(cardHead('list', fmtDay(cs.sel), items.length ? `${plural(items.length, 'survey')} on this date` : 'Nothing planned on this date'),
        items.length ? h('div', { class: 'daylist' }, items.map(dayItem))
          : empty('calendar', `No surveys scheduled for ${fmtLong(cs.sel)}.`, h('button', { class: 'secondary', onclick: () => go('req_scheduled') }, 'View all scheduled surveys')));
    };
    paint();
    root.append(h('div', { class: 'grid cols-even sched' }, calBox, dayBox));
  }

  /* ---------- request detail: a full page ---------- */
  const TRACK_ICON = { done: 'check', rejected: 'x', current: null, upcoming: null };
  function workflowTracker(tracker) {
    return h('ol', { class: 'wtrack', 'aria-label': 'Workflow' }, tracker.map((s) => h('li', { class: 'ws ' + s.status },
      h('span', { class: 'wdot' }, TRACK_ICON[s.status] ? icon(TRACK_ICON[s.status]) : null),
      h('div', { class: 'wt' }, h('b', null, s.title), s.authority ? h('span', null, s.authority) : null,
        s.status === 'done' ? h('em', null, s.date ? fmtTime(s.date) : 'Done') : s.status === 'current' ? h('em', null, s.sub ? s.sub.label : 'In progress') : s.status === 'rejected' ? h('em', null, 'Rejected here') : h('em', null, 'Upcoming')))));
  }
  function authorityChain(chain) {
    return h('ol', { class: 'achain', 'aria-label': 'Authority chain' }, chain.map((a) => h('li', { class: a.state },
      h('div', { class: 'ar' }, h('b', null, a.short), h('span', null, a.title)),
      h('div', { class: 'as' }, a.scope ? h('div', null, a.scope) : null, h('div', { class: 'cell-sub' }, a.name)),
      a.state ? h('span', { class: 'pill ' + (a.state === 'current' ? 'amber' : 'blue') }, a.state === 'current' ? 'Has it now' : 'Next') : null)));
  }
  const docUrl = (x, inline) => `/api/documents/${x.id}${inline ? '?inline=1' : ''}`;
  const viewable = (x) => /\.(pdf|png|jpe?g)$/i.test(x.name);
  const KIND = { LC: 'Supporting document', AE_DOCS: 'Substation document' };
  function docsBlock(d, r) {
    const cur = d.documents.filter((x) => x.current), old = d.documents.filter((x) => !x.current);
    const row = (x) => h('div', { class: 'doc' }, icon('file'), h('div', { class: 'dinfo' }, h('b', null, x.name), h('small', null, `${KIND[x.kind] || 'Document'} · ${fmtSize(x.size)} · ${x.uploaded_by} · ${fmtTime(x.uploaded_at)}`)),
      h('div', { class: 'dbtn' }, viewable(x) ? h('a', { class: 'cbtn', href: docUrl(x, true), target: '_blank', rel: 'noopener' }, icon('eye'), 'View') : null,
        h('a', { class: 'cbtn', href: docUrl(x), download: x.name }, icon('download'), 'Download')));
    const aeBusy = r.stage === 'AE_SUBSTATION' && state.user.role !== 'AE';
    return [cur.length ? h('div', { class: 'docs' }, cur.map(row)) : h('p', { class: 'muted small' }, aeBusy ? 'The AE is preparing the substation documents. They are shared when forwarded.' : 'No documents are available to you yet.'),
      old.length ? [h('div', { class: 'section-t' }, 'Earlier versions'), h('div', { class: 'docs old' }, old.map(row))] : null];
  }
  function downloadReport(r) {
    const text = `Survey report ${r.display_code}\n${r.title}\nSubstation: ${r.substation}\nSurvey date: ${fmtDate(r.survey_date)}\nSurveyor: ${na(r.surveyor, 'Not assigned')}\n\n${r.report}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = h('a', { href: url, download: `${r.display_code}-report.txt` }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const requiredAction = (r, d) => {
    if (r.group === 'completed') return 'None. The request is completed.';
    if (r.stage === 'CLOSED') return 'None. The request was declined.';
    if (r.stage === 'LC_REJECTED') return 'Project Coordinator to submit a revised request with supporting documents.';
    if (r.stage === 'SCHEDULED' && r.return_note) return 'Surveyor to correct the report and submit it again.';
    const cur = d.tracker.find((s) => s.status === 'current');
    return cur ? (cur.sub ? cur.sub.label : cur.action) : 'None';
  };

  function actionButtons(r, d) {
    const hasReport = !!r.report;
    const bar = r.allowed_actions.map((a, i) => h('button', { 'data-action': a, class: DANGER.includes(a) ? 'danger' : a === 'complete' || (a === 'approve' && r.stage === 'CHIEF_MONITOR') ? 'green' : i === 0 ? '' : 'secondary', onclick: () => actions[a](r, d) }, icon(ICON[a]), actionLabel(a, r)));
    if (hasReport && state.user.role !== 'SURVEYOR') {
      const toReport = () => { const el = document.getElementById('report-section'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      if (r.stage === 'PM_COMPLETION') bar.unshift(h('button', { class: 'secondary', onclick: toReport }, icon('eye'), 'Review Report'));
      if (r.stage === 'COMPLETED') bar.push(h('button', { class: 'secondary', onclick: toReport }, icon('eye'), 'View Report'), h('button', { class: 'secondary', onclick: () => downloadReport(r) }, icon('download'), 'Download Report'));
    }
    return bar;
  }

  async function detailView(root) {
    const id = state.selectedId;
    const box = h('div', { class: 'detail-page' }, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading the request…')));
    root.append(h('div', { class: 'backrow' }, h('button', { class: 'secondary back', onclick: () => (history.length > 1 ? history.back() : go('req_all')) }, icon('undo'), 'Back')), box);
    try {
      const d = await api('GET', `/api/requests/${id}`);
      if (!box.isConnected) return;
      box.replaceChildren(...(state.user.role === 'SURVEYOR' ? surveyorDetail(d) : fullDetail(d)));
    } catch (e) {
      box.replaceChildren(h('div', { class: 'card' }, empty('search', e.message === 'Request not found.' ? 'This request does not exist, or you are not allowed to see it.' : e.message,
        h('button', { class: 'secondary', onclick: () => go('req_all') }, 'Go to All Requests'))));
    }
  }
  const kv = (label, value) => h('div', { class: 'kv' }, h('small', null, label), h('b', null, value));

  function fullDetail(d) {
    const r = d.request, p = d.people, mine = r.allowed_actions.length > 0, buttons = actionButtons(r, d);
    const dateName = r.group === 'completed' ? 'Survey date' : r.group === 'scheduled' ? 'Scheduled date' : 'Requested date';
    const head = h('section', { class: 'card dhead' },
      h('div', { class: 'dh-top' }, h('div', null, h('div', { class: 'dh-id' }, h('b', null, r.display_code), r.revision ? h('span', { class: 'tag' }, 'Revised') : null, r.source === 'portal' ? h('span', { class: 'tag portal' }, 'Public') : null), h('h2', null, r.title),
        h('div', { class: 'cell-sub' }, `${r.survey_type} · ${r.substation}`)),
      h('div', { class: 'dh-badges' }, stageBadge(r), priBadge(r.priority), slaChip(r, true))),
      h('div', { class: 'where' },
        h('div', { class: 'wcell' }, h('small', null, 'Current stage'), h('b', null, r.stage_label), r.substage ? h('span', null, r.substage.label) : null),
        h('div', { class: 'wcell now' }, h('small', null, 'Current owner'), h('b', null, ownerText(r)), h('span', null, p.owner ? p.owner.name : 'Not assigned')),
        h('div', { class: 'wcell' }, h('small', null, 'Previous stage'), h('b', null, na(r.previous_stage, 'Not applicable')), null),
        h('div', { class: 'wcell' }, h('small', null, 'Next authority'), h('b', null, na(r.next_label, 'Not applicable')), h('span', null, na(r.next_stage, 'None')))),
      h('div', { class: 'reqact ' + (mine ? 'mine' : '') }, icon(mine ? 'alert' : 'clock'),
        h('div', null, h('small', null, mine ? 'Action required from you' : 'Required action'), h('b', null, requiredAction(r, d)), mine ? null : h('span', null, r.group === 'review' || r.group === 'scheduled' ? `Waiting on ${ownerText(r)}` : ' '))),
      buttons.length ? h('div', { class: 'actions' }, buttons) : state.user.role === 'SEIT' ? h('div', { class: 'cell-sub', style: 'margin-top:12px' }, 'SEIT watches every request and approves nothing.') : null,
      r.backtrack && r.stage === 'AE_SUBSTATION' ? h('div', { class: 'notice red' }, icon('undo'), h('span', null, `Sent back by ${r.backtrack.by} (from "${r.backtrack.from}"). Reason: ${String(r.backtrack.reason).replace(/[.\s]+$/, '')}. Correct the documents and forward again.`)) : null,
      r.stage === 'LC_REJECTED' ? h('div', { class: 'notice red' }, icon('alert'), h('span', null, `Rejected at "${r.rejected_stage}" by ${r.rejected_by}. Reason: ${String(r.rejection_reason).replace(/[.\s]+$/, '')}. ${r.date_proposed ? `Proposed date: ${fmtDate(r.survey_date)}.` : 'No new date has been proposed yet.'}`)) : null,
      r.stage === 'SCHEDULED' && r.return_note ? h('div', { class: 'notice red' }, icon('undo'), h('span', null, `Report returned for correction: ${r.return_note}`)) : null,
      r.stage === 'INTAKE_REVIEW' ? h('div', { class: 'notice blue' }, icon('globe'), h('span', null, 'Public request: the Coordinator screens it before the approval chain starts.')) : null,
      r.matching_exhausted && r.stage === 'SURVEYOR_ASSIGNMENT' ? h('div', { class: 'notice' }, icon('alert'), h('span', null, 'No nearby surveyor accepted. The Project Coordinator assigns one.')) : null);

    const details = h('section', { class: 'card' }, cardHead('clipboard', 'Request details'),
      h('div', { class: 'kvgrid' }, kv('Survey type', na(r.survey_type)), kv('Priority', na(r.priority)), kv(dateName, r.group === 'rejected' && !r.date_proposed ? 'Not scheduled' : fmtDate(r.survey_date)),
        kv('Substation', na(r.substation)), kv('Division', na(r.division)), kv('Nodal centre', na(r.nodal_centre)), kv('Zone', na(r.zone)),
        kv('Requested by', p.requester ? `${p.requester.name} (${ROLE[p.requester.role] || p.requester.role})` : 'Not available'), kv('Assigned surveyor', na(r.surveyor, 'Not assigned')),
        kv('Created', fmtTime(r.created_at)), kv('Last updated', `${fmtTime(r.updated_at)}`), kv('Source', r.source === 'portal' ? 'Public portal' : 'Internal (CMS)')),
      h('div', { class: 'section-t' }, 'Remarks'), h('div', { class: 'remark' }, na(r.remarks, 'No remarks added.')));

    const report = r.report ? h('section', { class: 'card', id: 'report-section' }, cardHead('file', 'Survey report', r.stage === 'PM_COMPLETION' ? 'Waiting for the Project Manager to review' : r.group === 'completed' ? 'Approved' : null),
      h('div', { class: 'remark' }, r.report)) : null;

    const timeline = h('section', { class: 'card' }, cardHead('activity', 'Activity timeline', 'Every action on this request, newest first'),
      d.activity.length ? h('ul', { class: 'timeline act full' }, [...d.activity].reverse().map((e) => h('li', { class: /reject|return|backtrack|deadline/i.test(e.action) ? 'reject' : /complet|approv|accept|scheduled|created/i.test(e.action) ? 'good' : '' },
        h('div', { class: 'when' }, fmtTime(e.ts)),
        h('b', null, e.text), ' ', e.decision ? h('span', { class: 'pill plain ' + (e.decision === 'Approved' ? 'green' : e.decision === 'Rejected' ? 'red' : 'amber') }, e.decision) : null,
        h('div', { class: 'who2' }, `${e.actor_name} · ${ROLE[e.actor_role] || e.actor_role}`),
        e.result ? h('div', { class: 'res' }, `Result: ${e.result}`) : null, e.comment ? h('div', { class: 'say' }, e.comment) : null))) : empty('activity', 'No activity yet.'));

    const keyRows = [[p.owner, 'Current owner'], [p.next, 'Next authority'], [p.requester, 'Requester'], [p.surveyor, 'Assigned surveyor']].filter(([x]) => x);
    const contacts = h('section', { class: 'card' }, cardHead('users', 'Key contacts'),
      keyRows.length ? h('div', { class: 'contacts' }, keyRows.map(([x, t]) => personRow(x, t))) : h('p', { class: 'muted small' }, 'No contacts available yet.'),
      h('button', { class: 'secondary wide-btn', onclick: () => modal('All contacts', h('div', { class: 'contacts' }, d.contacts.map((c) => personRow(c))), { ic: 'users' }) }, icon('users'), 'View all contacts'));

    const main = h('div', { class: 'dmain' },
      h('section', { class: 'card' }, cardHead('layers', 'Workflow', 'Where the request is in its lifecycle'), workflowTracker(d.tracker)),
      details, report,
      h('section', { class: 'card' }, cardHead('paperclip', `Documents (${d.documents.length})`), docsBlock(d, r)), timeline);
    const side = h('div', { class: 'dside' },
      h('section', { class: 'card' }, cardHead('shield', 'Authority chain', 'Who holds each seat. This is the hierarchy, not the workflow.'), authorityChain(d.chain)), contacts);
    return [head, h('div', { class: 'dgrid' }, main, side)];
  }

  function countdownBig(r) {
    if (!r.survey_date || r.group === 'completed' || r.stage === 'PM_COMPLETION') return null;
    const n = daysUntil(r.survey_date);
    return h('div', { class: 'cd-big' + (n <= 1 ? ' soon' : '') }, h('b', null, n > 0 ? n : n === 0 ? 'Today' : -n), h('span', null, n > 1 ? 'days until the survey' : n === 1 ? 'day until the survey' : n === 0 ? 'Survey day' : `day${n === -1 ? '' : 's'} since the survey date`), h('small', null, fmtDay(r.survey_date)));
  }
  // The surveyor sees the job, the date and a countdown. Nothing about the approval process.
  function surveyorDetail(d) {
    const r = d.request;
    const btns = r.allowed_actions.map((a) => h('button', { onclick: () => actions[a](r, d) }, icon(ICON[a]), actionLabel(a, r)));
    return [h('section', { class: 'card sv-detail' },
      h('div', { class: 'dh-top' }, h('div', null, h('div', { class: 'dh-id' }, h('b', null, r.display_code)), h('h2', null, r.title), h('div', { class: 'cell-sub' }, r.survey_type)), h('div', { class: 'dh-badges' }, priBadge(r.priority))),
      countdownBig(r),
      r.return_note ? h('div', { class: 'notice red' }, icon('undo'), h('span', null, `Your report was returned for correction: ${r.return_note}`)) : null,
      h('div', { class: 'kvgrid' }, kv('Substation', `${r.substation} (${na(r.division)})`), kv('Survey date', fmtDate(r.survey_date)), kv('Survey type', na(r.survey_type))),
      r.remarks ? [h('div', { class: 'section-t' }, 'Remarks'), h('div', { class: 'remark' }, r.remarks)] : null,
      r.report ? [h('div', { class: 'section-t' }, 'Your report'), h('div', { class: 'remark' }, r.report)] : null,
      btns.length ? h('div', { class: 'actions' }, btns) : null,
      h('div', { class: 'section-t' }, `Documents (${d.documents.length})`), docsBlock(d, r),
      h('div', { class: 'section-t' }, 'Contact'), h('div', { class: 'contacts' }, d.contacts.map((c) => personRow(c))))];
  }

  /* ---------- surveyor dashboard ---------- */
  function surveyorDashboard(root) {
    const R = [...state.requests].sort((a, b) => a.survey_date.localeCompare(b.survey_date));
    const up = R.filter((r) => r.stage === 'SCHEDULED' && !r.return_note), ret = R.filter((r) => r.stage === 'SCHEDULED' && r.return_note), done = R.filter((r) => ['PM_COMPLETION', 'COMPLETED'].includes(r.stage));
    const tile = (ic, tone, n, label) => h('div', { class: 'kpi' }, h('span', { class: 'ibox ' + tone }, icon(ic)), h('div', null, h('b', null, n), h('span', null, label)));
    const card = (r) => h('article', { class: 'ar-card sv', tabindex: 0, 'data-id': r.id, onclick: () => openReq(r), onkeydown: (e) => { if (e.key === 'Enter') openReq(r); } },
      h('div', { class: 'ar-top' }, h('b', null, r.display_code), r.return_note ? h('span', { class: 'pill red' }, 'Report returned') : r.stage === 'SCHEDULED' ? countdownChip(r) : h('span', { class: 'pill ' + (r.group === 'completed' ? 'green' : 'violet') }, r.group === 'completed' ? 'Completed' : 'Report sent')),
      h('div', { class: 'cell-title' }, r.title), h('div', { class: 'cell-sub' }, r.substation),
      h('div', { class: 'ar-row' }, h('span', { class: 'datecell' }, icon('calendar'), fmtDate(r.survey_date)), priBadge(r.priority)));
    root.append(h('div', { class: 'kpis' }, tile('calendar', 't-teal', up.length, 'Upcoming surveys'), tile('undo', 't-amber', ret.length, 'Reports to correct'), tile('check', 't-green', done.length, 'Submitted or completed')),
      h('div', { class: 'card' }, cardHead('list', 'My surveys', 'Your jobs, by survey date'), R.length ? h('div', { class: 'ar-cards' }, R.map(card)) : empty('inbox', 'No surveys yet. When you accept a job offer it appears here.', h('button', { class: 'secondary', onclick: () => go('offers') }, 'See job offers'))));
  }
  function countdownChip(r) {
    const n = daysUntil(r.survey_date);
    return h('span', { class: 'countdown' + (n <= 1 ? ' soon' : '') }, n > 1 ? `${n} days to go` : n === 1 ? 'Tomorrow' : n === 0 ? 'Today' : `${-n} day${n === -1 ? '' : 's'} ago`);
  }

  /* ---------- new request (Coordinator) ---------- */
  async function newView(root) {
    let date = null;
    const subs = h('select', { 'aria-label': 'Substation' });
    const hier = h('div', { class: 'hint' });
    const pri = h('select', { 'aria-label': 'Priority' }), type = h('select', { 'aria-label': 'Survey type' });
    let list = [];
    api('GET', '/api/substations').then((d) => {
      list = d.substations;
      d.substations.forEach((s) => subs.append(h('option', { value: s.id }, s.name)));
      d.priorities.forEach((p) => pri.append(h('option', { value: p, selected: p === 'Medium' }, p)));
      d.survey_types.forEach((t) => type.append(h('option', { value: t }, t)));
      showHier();
    });
    const showHier = () => { const s = list.find((x) => x.id === Number(subs.value)); hier.textContent = s ? `Goes to: ${s.zone} › ${s.division} › ${s.nodal_centre || 'Not assigned'}` : ''; };
    subs.addEventListener('change', showHier);
    const title = h('input', { maxlength: 120, 'aria-label': 'Title', placeholder: 'e.g. Thermography survey of transformer yard' });
    const remarks = h('textarea', { rows: 3, maxlength: 500, 'aria-label': 'Remarks', placeholder: 'Anything the approving officers should know (optional)' });
    const files = fileBox({ label: 'Attach supporting documents' });
    const chosen = selChip('No date chosen');
    const step = (t, s) => h('li', null, h('b', null, t), h('div', { class: 'when' }, s));
    root.append(h('div', { class: 'grid cols2' },
      h('div', { class: 'card' }, cardHead('plus', 'New Survey Request', 'Fill in the details. The request goes to the Executive Engineer of the division.'),
        h('label', null, 'Title ', h('span', { class: 'req' }, '(required)')), title,
        h('div', { class: 'field-row' }, h('div', null, h('label', null, 'Survey type'), type), h('div', null, h('label', null, 'Priority'), pri)),
        h('label', null, 'Substation'), subs, hier,
        h('label', null, 'Requested survey date ', h('span', { class: 'req' }, '(required)')), picker({ onChange: (d) => { date = d; chosen.lastChild.textContent = `Date: ${fmtDate(d)}`; } }), chosen,
        h('label', null, 'Remarks ', h('span', { class: 'opt' }, '(optional)')), remarks,
        h('label', null, 'Supporting documents ', h('span', { class: 'req' }, '(required)')), files.el,
        h('div', { class: 'actions' }, h('button', { onclick: guard(async () => {
          if (!date) throw new Error('Please pick a date.');
          if (!files.count()) throw new Error('Please attach at least one supporting document.');
          const r = await api('POST', '/api/requests', { substation_id: Number(subs.value), survey_date: date, title: title.value, priority: pri.value, survey_type: type.value, remarks: remarks.value.trim() || undefined, files: await files.files() });
          toast(`${r.request.display_code} created and sent to the Executive Engineer.`); await reloadAll(); go('detail', r.request.id);
        }) }, icon('send'), 'Submit Request'))),
      h('div', { class: 'card' }, cardHead('layers', 'What happens next', 'The journey of a request'),
        h('ul', { class: 'timeline' },
          step('Executive Engineer reviews', 'Division permission (2 days)'), step('Assistant Executive Engineer reviews', 'Coordinates with the substation (2 days)'),
          step('Assistant Engineer acts', 'Approves the request, then uploads substation documents and forwards them (4 days)'), step('AEE and EE check the documents', 'Review, then verify (2 days each)'),
          step('Chief approves', 'Receives, reviews and sends it to a surveyor (2 days)'), step('Surveyor is assigned', 'The nearest free surveyor is offered the job'), step('Survey, report and completion', 'The Project Manager approves the report')),
        h('div', { class: 'notice blue' }, icon('eye'), h('span', null, 'SEIT watches every step and approves nothing.')),
        h('div', { class: 'notice' }, icon('alert'), h('span', null, 'If the request is rejected before the Assistant Engineer approves it, you submit a revised request. The number stays the same and is shown as "Revised".')))));
  }

  /* ---------- reports ---------- */
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  function downloadCsv(name, header, rows) {
    const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fmtStamp = (ts) => (ts ? new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10) : null);
  function reportPage(box, { title, sub, ic, kpis, header, rows, csv, emptyText }) {
    box.replaceChildren(h('div', { class: 'kpis' }, kpis.map(([k, tone, n, label]) => h('div', { class: 'kpi' }, h('span', { class: 'ibox ' + tone }, icon(k)), h('div', null, h('b', null, n), h('span', null, label))))),
      h('div', { class: 'card flush' }, h('div', { class: 'padh' }, cardHead(ic, title, sub, rows.length ? h('button', { class: 'secondary', onclick: () => downloadCsv(csv, header.map((x) => x.h), rows.map((r) => r.text)) }, icon('download'), 'Download CSV') : null)),
        rows.length ? dataTable(header, rows, { onRow: (r) => go('detail', r.id), cls: 'rep' }) : empty(ic, emptyText)));
  }
  const repReq = (r) => h('div', null, h('div', { class: 'code' }, r.display_code), h('div', { class: 'cell-title' }, r.title));
  function reportsView(root) {
    const tabs = [['approved', 'Approved'], ['scheduled', 'Scheduled'], ['rejected', 'Rejected']];
    const body = h('div');
    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', { role: 'tab', class: 'tab' + (state.repTab === k ? ' on' : ''), 'aria-selected': String(state.repTab === k), onclick: () => { state.repTab = k; render(); } }, label)));
    root.append(tabBar, body);
    const R = state.requests;
    if (state.repTab === 'approved') {
      const L = R.filter((r) => ['SURVEYOR_ASSIGNMENT', 'SCHEDULED', 'PM_COMPLETION', 'COMPLETED'].includes(r.stage)).sort((a, b) => (b.approved_at || 0) - (a.approved_at || 0));
      reportPage(body, { title: 'Approved requests', sub: 'Requests approved by the Chief, newest first', ic: 'check', csv: 'approved-requests.csv', emptyText: 'No request has been approved yet.',
        kpis: [['check', 't-green', L.length, 'Approved'], ['calendar', 't-teal', L.filter((r) => r.stage === 'SURVEYOR_ASSIGNMENT').length, 'Waiting for a surveyor'], ['flag', 't-blue', L.filter((r) => r.group === 'completed').length, 'Completed']],
        header: [{ h: 'Request', cls: 'c-req' }, { h: 'Substation' }, { h: 'Approved on' }, { h: 'Survey date' }, { h: 'Status' }, { h: 'Surveyor' }],
        rows: L.map((r) => ({ id: r.id, cells: [repReq(r), r.substation, fmtDate(fmtStamp(r.approved_at), 'Not available'), fmtDate(r.survey_date), stageBadge(r), na(r.surveyor, 'Not assigned')], text: [r.display_code, r.substation, fmtStamp(r.approved_at), r.survey_date, r.stage_label, r.surveyor || ''] })) });
    } else if (state.repTab === 'scheduled') {
      const L = R.filter((r) => ['SCHEDULED', 'PM_COMPLETION', 'COMPLETED'].includes(r.stage)).sort((a, b) => a.survey_date.localeCompare(b.survey_date));
      reportPage(body, { title: 'Scheduled surveys', sub: 'Surveys with an assigned surveyor, by survey date', ic: 'calendar', csv: 'scheduled-surveys.csv', emptyText: 'No survey is scheduled yet.',
        kpis: [['calendar', 't-teal', L.filter((r) => r.stage === 'SCHEDULED').length, 'Upcoming'], ['file', 't-violet', L.filter((r) => r.stage === 'PM_COMPLETION').length, 'Report submitted'], ['check', 't-green', L.filter((r) => r.group === 'completed').length, 'Completed']],
        header: [{ h: 'Request', cls: 'c-req' }, { h: 'Substation' }, { h: 'Survey date' }, { h: 'Surveyor' }, { h: 'Status' }],
        rows: L.map((r) => ({ id: r.id, cells: [repReq(r), r.substation, fmtDate(r.survey_date), na(r.surveyor, 'Not assigned'), stageBadge(r)], text: [r.display_code, r.substation, r.survey_date, r.surveyor || '', r.stage_label] })) });
    } else {
      body.append(h('p', { class: 'muted' }, 'Loading…'));
      api('GET', '/api/reports/rejected').then(({ rejections: L }) => {
        if (!body.isConnected) return;
        const kind = (x) => (x.kind === 'RESCHEDULE_REJECT' ? 'Rejected & rescheduled' : 'Rejected');
        reportPage(body, { title: 'Rejected requests', sub: 'Every rejection: who, where, why, and what happened next', ic: 'x', csv: 'rejected-requests.csv', emptyText: 'No request has been rejected.',
          kpis: [['x', 't-red', L.length, 'Rejections'], ['alert', 't-amber', L.filter((x) => x.current_stage === 'LC_REJECTED').length, 'Waiting for a revised request'], ['calendar', 't-blue', L.filter((x) => x.tentative_date).length, 'With a new date proposed']],
          header: [{ h: 'Request', cls: 'c-req' }, { h: 'Substation' }, { h: 'Rejected at' }, { h: 'By' }, { h: 'Reason' }, { h: 'Now' }],
          rows: L.map((x) => ({ id: x.request_id, cells: [h('div', null, h('div', { class: 'code' }, x.display_code), h('div', { class: 'cell-title' }, x.title)), x.substation, h('div', null, x.stage, h('div', { class: 'cell-sub' }, fmtTime(x.rejected_at))), x.rejected_by, h('span', { class: 'reason' }, x.reason), x.now],
            text: [x.display_code, x.substation, x.stage, x.rejected_by, x.reason, kind(x), x.now] })) });
      }).catch((e) => toast(e.message, 'bad'));
    }
  }

  /* ---------- notifications ---------- */
  function notesView(root) {
    const cat = state.noteCat;
    const counts = Object.fromEntries(Object.keys(CATS).map((k) => [k, state.notes.filter((n) => n.category === k && !n.is_read).length]));
    const list = state.notes.filter((n) => cat === 'all' || n.category === cat);
    const tab = (k, label, n) => h('button', { role: 'tab', class: 'tab' + (cat === k ? ' on' : ''), 'aria-selected': String(cat === k), 'data-cat': k, onclick: () => { state.noteCat = k; render(); } }, label, n ? h('span', { class: 'count' }, n) : null);
    const item = (n) => h('li', { class: 'note ' + (n.is_read ? '' : 'unread ') + n.category },
      h('span', { class: 'ndot', 'aria-label': n.is_read ? 'Read' : 'Unread' }),
      h('div', { class: 'nbody' }, h('div', { class: 'nmsg' }, n.message),
        h('div', { class: 'nmeta' }, h('span', { class: 'pill plain ' + ({ action: 'amber', approval: 'green', schedule: 'blue', assignment: 'teal' }[n.category] || '') }, CATS[n.category] || 'System'), h('span', { class: 'muted' }, fmtTime(n.ts)))),
      h('div', { class: 'nact' }, n.request_id ? h('button', { class: 'secondary small', onclick: () => go('detail', n.request_id) }, 'View request', icon('arrow')) : null,
        n.is_read ? null : h('button', { class: 'btn-ghost', onclick: guard(async () => { await api('POST', `/api/notifications/${n.id}/read`); await loadNotes(); render(); }) }, icon('check'), 'Mark as read')));
    root.append(h('div', { class: 'card notes-card' },
      cardHead('bell', 'Notifications', `${unreadCount()} unread. Opening this page does not mark anything as read.`,
        unreadCount() ? h('button', { class: 'secondary', onclick: guard(async () => { await api('POST', '/api/notifications/read'); await loadNotes(); render(); }) }, icon('check'), 'Mark all as read') : null),
      h('div', { class: 'tabs', role: 'tablist' }, tab('all', 'All', unreadCount()), Object.entries(CATS).map(([k, label]) => tab(k, label, counts[k]))),
      list.length ? h('ul', { class: 'notelist' }, list.map(item)) : empty('bell', cat === 'all' ? 'No notifications yet.' : `No ${CATS[cat].toLowerCase()} notifications.`)));
  }

  /* ---------- surveyor: offers and calendar ---------- */
  function offersView(root) {
    const status = h('div', { class: 'card' });
    const lat = h('input', { value: '13.0300', 'aria-label': 'Latitude' }), lon = h('input', { value: '77.5800', 'aria-label': 'Longitude' });
    status.append(cardHead('power', 'Availability'),
      state.available
        ? h('div', null, h('div', { class: 'status-big on' }, h('span', { class: 'ibox' }, icon('pin')), h('div', null, h('b', null, 'You are online'), h('span', null, 'You can receive nearby job offers.'))),
          h('button', { class: 'secondary', onclick: guard(async () => { await api('POST', '/api/surveyor/status', { available: false }); state.available = false; toast('Offline - your stored location was erased.'); render(); }) }, icon('power'), 'Go offline (erases my location)'))
        : h('div', null, h('div', { class: 'status-big off' }, h('span', { class: 'ibox' }, icon('power')), h('div', null, h('b', null, 'You are offline'), h('span', null, 'You will not be offered jobs.'))),
          h('p', { class: 'hint' }, 'Going online shares your location only to match nearby jobs. Going offline erases it.'),
          h('div', { class: 'field-row' }, h('div', null, h('label', null, 'Latitude'), lat), h('div', null, h('label', null, 'Longitude'), lon)),
          h('div', { class: 'actions' }, h('button', { class: 'green', onclick: guard(async () => { await api('POST', '/api/surveyor/status', { available: true, lat: Number(lat.value), lon: Number(lon.value) }); state.available = true; toast('You are online.'); render(); }) }, icon('check'), 'I consent - go online'))));
    const list = h('div', { class: 'card' }, cardHead('inbox', 'Job offers'), h('p', { class: 'muted' }, 'Loading…'));
    root.append(h('div', { class: 'grid cols2' }, list, status));
    loadOffers(list);
  }
  async function loadOffers(list) {
    const { offers } = await api('GET', '/api/offers');
    const respond = (o, accept, msg) => guard(async () => { await api('POST', `/api/offers/${o.id}/respond`, { accept }); toast(msg); await loadOffers(list); await reloadAll(); });
    const item = (o) => {
      const open = o.status === 'OFFERED';
      return h('div', { class: 'offer' + (open ? ' open' : '') },
        h('div', { class: 'distance' }, h('b', null, o.distance_km.toFixed(1)), h('span', null, 'km away')),
        h('div', { class: 'meta' }, h('div', { class: 'code' }, `${o.display_code} · ${o.title}`),
          h('div', { class: 'row2' }, h('span', null, icon('zap'), o.substation), h('span', null, icon('calendar'), fmtDate(o.survey_date)), open ? h('span', null, icon('clock'), `answer by ${fmtTime(o.expires_at)}`) : null)),
        h('div', { class: 'act' }, open
          ? h('div', { class: 'actions', style: 'margin:0' }, h('button', { class: 'green', onclick: respond(o, true, 'Accepted - survey scheduled.') }, icon('check'), 'Accept'), h('button', { class: 'danger', onclick: respond(o, false, 'Declined - offered to the next surveyor.') }, icon('x'), 'Decline'))
          : h('span', { class: 'pill ' + (o.status === 'ACCEPTED' ? 'green' : '') }, o.status.toLowerCase())));
    };
    list.replaceChildren(cardHead('inbox', 'Job offers', 'Nearest surveyor is offered first'), offers.length ? h('div', null, offers.map(item)) : empty('inbox', 'No offers yet. When a request near you is approved, it appears here.'));
  }
  function myCalendarView(root) {
    const t = SurveyCal.istToday();
    let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7)) - 1;
    const box = h('div', { class: 'card' });
    let first = true;
    const draw = guard(async () => {
      const { bookings, next_booking: nb } = await api('GET', `/api/calendar?month=${y}-${String(m + 1).padStart(2, '0')}`);
      if (first && nb && !bookings.length) { first = false; y = Number(nb.slice(0, 4)); m = Number(nb.slice(5, 7)) - 1; return draw(); }
      first = false;
      const marked = {}; bookings.forEach((b) => { marked[b.date] = 'booked'; });
      box.replaceChildren(cardHead('calendar', 'My schedule', 'Booked dates are not available for other surveys'),
        SurveyCal.calendar({ year: y, month: m, marked, legend: [['booked', 'Booked'], ['today', 'Today']], onMonth: (ny, nm) => { y = ny; m = nm; draw(); } }),
        bookings.length ? h('ul', { class: 'booklist' }, bookings.map((b) => h('li', null, icon('calendar'), h('b', null, fmtDate(b.date)), h('span', { class: 'muted' }, b.code)))) : null);
    });
    root.append(h('div', { class: 'grid cols2' }, box,
      h('div', { class: 'card' }, cardHead('shield', 'How scheduling works'), h('ul', { class: 'timeline' },
        h('li', null, h('b', null, 'One survey per day'), h('div', { class: 'when' }, 'The system refuses a second booking on the same date.')),
        h('li', null, h('b', null, 'Date only'), h('div', { class: 'when' }, 'Surveys are planned by date. Time of day is not used.')),
        h('li', null, h('b', null, 'Nearest first'), h('div', { class: 'when' }, 'Offers go to the closest free surveyor who is online.'))))));
    draw();
  }

  /* ---------- admin ---------- */
  async function usersView(root) {
    const [{ users }, { substations }] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/substations')]);
    const divisions = [...new Set(substations.map((s) => s.division))];
    const centres = [...new Set(substations.map((s) => s.nodal_centre).filter(Boolean))];
    const f = { username: h('input', { 'aria-label': 'Username' }), name: h('input', { 'aria-label': 'Full name' }), password: h('input', { type: 'password', 'aria-label': 'Initial password' }),
      email: h('input', { type: 'email', 'aria-label': 'Email', placeholder: 'name@kptcl.example' }), phone: h('input', { type: 'tel', 'aria-label': 'Phone', placeholder: '+91 98xxx xxxxx' }),
      role: h('select', { 'aria-label': 'Role' }, Object.keys(ROLE).filter((r) => r !== 'PUBLIC').map((r) => h('option', { value: r }, `${ROLE[r]} (${r})`))),
      division: h('select', { 'aria-label': 'Division' }, divisions.map((d) => h('option', null, d))),
      centre: h('select', { 'aria-label': 'Nodal centre' }, centres.map((d) => h('option', null, d))),
      sub: h('select', { 'aria-label': 'Substation' }, substations.map((s) => h('option', { value: s.id }, s.name))) };
    const KP = ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE'];
    root.append(h('div', { class: 'grid cols2' },
      h('div', { class: 'card flush' }, h('div', { class: 'padh' }, cardHead('users', 'Users', 'KPTCL and Office hierarchies')), h('div', { class: 'tw' }, h('table', { class: 'rtable' }, h('thead', null, h('tr', null, ['User', 'Role', 'Scope', ''].map((x) => h('th', null, x)))),
        h('tbody', null, users.map((u) => h('tr', { style: u.active ? '' : 'opacity:.55' },
          h('td', { 'data-label': 'User' }, h('div', { style: 'display:flex;align-items:center;gap:10px' }, avatar(u.name), h('div', null, h('div', { class: 'code' }, u.username), h('div', { class: 'cell-sub' }, u.name), h('div', { class: 'cell-sub' }, [u.email, u.phone].filter(Boolean).join(' · '))))),
          h('td', { 'data-label': 'Role' }, h('span', { class: 'pill plain ' + (KP.includes(u.role) ? 'blue' : 'teal') }, u.role)),
          h('td', { class: 'small', 'data-label': 'Scope' }, [u.division, u.nodal_centre, u.substation].filter(Boolean).join(' · ') || 'Not assigned'),
          h('td', null, h('div', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'secondary', onclick: guard(async () => { await api('PATCH', `/api/admin/users/${u.id}`, { active: !u.active }); toast(u.active ? 'Disabled.' : 'Enabled.'); render(); }) }, u.active ? 'Disable' : 'Enable'),
            h('button', { class: 'secondary', onclick: guard(async () => { const r = await api('POST', `/api/admin/users/${u.id}/reset-password`); modal('Temporary password', h('div', null, h('p', null, `For ${u.username} (shown once):`), h('p', null, h('code', null, r.temporary_password))), { ic: 'lock' }); }) }, 'Reset password'))))))))),
      h('div', { class: 'stack' }, h('div', { class: 'card' }, cardHead('plus', 'Create user'),
        h('div', { class: 'field-row' }, h('div', null, h('label', null, 'Username'), f.username), h('div', null, h('label', null, 'Full name'), f.name)),
        h('div', { class: 'field-row' }, h('div', null, h('label', null, 'Email'), f.email), h('div', null, h('label', null, 'Phone'), f.phone)),
        h('label', null, 'Role'), f.role,
        h('div', { class: 'field-row' }, h('div', null, h('label', null, 'Division (EE / AEE / AE)'), f.division), h('div', null, h('label', null, 'Nodal centre (AEE)'), f.centre)),
        h('label', null, 'Substation (AE only)'), f.sub,
        h('label', null, 'Initial password'), f.password, h('div', { class: 'hint' }, 'At least 10 characters, with upper case, lower case and a digit.'),
        h('div', { class: 'actions' }, h('button', { onclick: guard(async () => {
          const body = { username: f.username.value, name: f.name.value, role: f.role.value, password: f.password.value, division: f.division.value, nodal_centre: f.centre.value, substation_id: Number(f.sub.value), email: f.email.value.trim() || undefined, phone: f.phone.value.trim() || undefined };
          if (!['EE', 'AEE', 'AE'].includes(body.role)) { delete body.division; delete body.substation_id; delete body.nodal_centre; } else if (body.role === 'EE') { delete body.substation_id; delete body.nodal_centre; } else if (body.role === 'AEE') delete body.substation_id; else delete body.nodal_centre;
          await api('POST', '/api/admin/users', body); toast('User created.'); render();
        }) }, icon('plus'), 'Create user'))),
        h('div', { class: 'notice blue', style: 'margin:0' }, icon('shield'), h('span', null, 'Admin manages who has access. Admin cannot see, approve or move survey requests - those stay with the KPTCL and project roles that own them.')))));
  }
  async function auditView(root) {
    const { entries } = await api('GET', '/api/admin/audit');
    const result = h('div');
    root.append(h('div', { class: 'card flush' }, h('div', { class: 'padh' },
      cardHead('shieldCheck', 'Audit log', 'Append-only and hash-chained: editing or deleting any past entry breaks the chain.',
        h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, result, h('button', { onclick: guard(async () => { const v = await api('GET', '/api/admin/audit/verify'); result.replaceChildren(h('span', { class: 'pill ' + (v.ok ? 'green' : 'red') }, v.ok ? `Chain intact · ${v.checked} entries checked` : `Tampering detected at entry #${v.brokenAtId}`)); }) }, icon('shieldCheck'), 'Verify chain')))),
      h('div', { class: 'tw' }, h('table', { class: 'rtable' }, h('thead', null, h('tr', null, ['#', 'When', 'Who', 'Action', 'Request'].map((x) => h('th', null, x)))),
        h('tbody', null, entries.map((e) => h('tr', null, h('td', { class: 'muted', 'data-label': '#' }, e.id), h('td', { class: 'small', 'data-label': 'When' }, fmtTime(e.ts)), h('td', { 'data-label': 'Who' }, h('b', null, e.actor), h('span', { class: 'muted' }, ` (${e.role})`)),
          h('td', { 'data-label': 'Action' }, h('span', { class: 'tag' }, e.action.replace(/_/g, ' '))), h('td', { 'data-label': 'Request' }, e.request_id ?? 'Not applicable'))))))));
  }

  /* ---------- data + render ---------- */
  async function loadNotes() { state.notes = (await api('GET', '/api/notifications')).notifications; }
  async function reloadAll() {
    if (!state.user) return;
    if (state.user.role !== 'ADMIN') {
      const [rq, ac] = await Promise.all([api('GET', '/api/requests'), state.user.role === 'SURVEYOR' ? { events: [] } : api('GET', '/api/activity')]);
      state.requests = rq.requests; state.activity = ac.events;
    }
    await loadNotes(); render();
  }
  function render() {
    const y = window.scrollY;
    app.replaceChildren();
    if (!state.user) { app.append(loginView()); return; }
    app.append(shell());
    window.scrollTo(0, y);
  }
  async function start() {
    const me = await api('GET', '/api/me');
    state.user = me.user; state.available = me.available;
    parseHash();
    await reloadAll();
  }
  // Quiet refresh: not while a dialog is open or the person is typing.
  setInterval(() => {
    const a = document.activeElement;
    if (!state.user || document.querySelector('.overlay') || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || ['users', 'audit', 'new', 'reports'].includes(state.tab)) return;
    reloadAll().catch(() => {});
  }, 8000);
  api('GET', '/api/me').then(start).catch(() => render());
})();
