/* Small month-calendar widget shared by the CMS and the portal.
   Dates are plain YYYY-MM-DD strings (IST). No innerHTML: everything is built with DOM calls. */
(function () {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /* opts: { year, month (0-11), selected, minDate, marked: {date: 'booked'|'full'|'approval'|...}, counts: {date: n}, legend: [..], onSelect(date), onMonth(year, month) } */
  function calendar(opts) {
    const root = document.createElement('div');
    root.className = 'cal';
    const head = document.createElement('div');
    head.className = 'cal-head';
    const prev = document.createElement('button'); prev.type = 'button'; prev.textContent = '‹'; prev.className = 'btn-ghost'; prev.setAttribute('aria-label', 'Previous month');
    const next = document.createElement('button'); next.type = 'button'; next.textContent = '›'; next.className = 'btn-ghost'; next.setAttribute('aria-label', 'Next month');
    const title = document.createElement('strong'); title.textContent = `${MONTHS[opts.month]} ${opts.year}`;
    const go = (delta) => { const d = new Date(Date.UTC(opts.year, opts.month + delta, 1)); opts.onMonth && opts.onMonth(d.getUTCFullYear(), d.getUTCMonth()); };
    prev.addEventListener('click', () => go(-1)); next.addEventListener('click', () => go(1));
    head.append(prev, title, next);
    root.append(head);

    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) => { const c = document.createElement('div'); c.className = 'cal-dow'; c.textContent = d; grid.append(c); });
    const first = new Date(Date.UTC(opts.year, opts.month, 1));
    const lead = (first.getUTCDay() + 6) % 7; // Monday-first
    for (let i = 0; i < lead; i++) grid.append(document.createElement('div'));
    const days = new Date(Date.UTC(opts.year, opts.month + 1, 0)).getUTCDate();
    const today = istToday();
    for (let d = 1; d <= days; d++) {
      const date = iso(opts.year, opts.month, d);
      const mark = opts.marked && opts.marked[date];
      const disabled = (opts.minDate && date < opts.minDate) || mark === 'full';
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.append(document.createTextNode(String(d)));
      const n = opts.counts && opts.counts[date];
      if (n) { const b = document.createElement('span'); b.className = 'cal-n'; b.textContent = String(n); cell.append(b); }
      cell.className = 'cal-day' + (mark ? ' ' + mark : '') + (date === opts.selected ? ' selected' : '') + (date === today ? ' today' : '');
      cell.disabled = !!disabled && !!opts.onSelect;
      if (mark === 'full') cell.title = 'No surveyor is free on this date';
      if (mark === 'booked') cell.title = 'Booked';
      if (opts.onSelect && !cell.disabled) cell.addEventListener('click', () => opts.onSelect(date));
      grid.append(cell);
    }
    root.append(grid);
    if (opts.legend) {
      const lg = document.createElement('div'); lg.className = 'cal-legend';
      opts.legend.forEach(([cls, text]) => { const s = document.createElement('span'); const dot = document.createElement('i'); dot.className = 'dot ' + cls; s.append(dot, ' ' + text); lg.append(s); });
      root.append(lg);
    }
    return root;
  }
  window.SurveyCal = { calendar, istToday, MONTHS };
})();
