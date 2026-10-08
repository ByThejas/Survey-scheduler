'use strict';
// Demo requests for a fresh database, created through the real workflow so every screen shows consistent data.
const wf = require('./workflow');
const { addDaysISO, todayISO } = require('./security');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const file = (name) => ({ name, data: PDF });

function seedDemo(db, cfg) {
  const user = (u) => db.prepare('SELECT * FROM users WHERE username=?').get(u);
  const day = (n) => addDaysISO(todayISO(), n);
  const create = (b) => wf.createRequest(db, user('coord1'), { files: [file('line-clearance-form.pdf'), file('single-line-diagram.pdf')], ...b });
  const go = (u, id, action, body = {}) => wf.act(db, cfg, user(u), id, action, body);
  // the document loop for one substation: EE, AEE, AE (approve + documents), AEE, EE
  const loop = (id, { ee, aee, ae }, upTo = 5) => {
    const steps = [() => go(ee, id, 'approve', { remarks: 'Permission given for the division.' }), () => go(aee, id, 'approve', { remarks: 'Coordinated with the substation.' }),
      () => { go(ae, id, 'approve_lc'); return go(ae, id, 'approve', { files: [file('substation-layout.pdf'), file('shutdown-plan.pdf')], remarks: 'All clearances and the layout are attached.' }); },
      () => go(aee, id, 'approve', { remarks: 'Documents reviewed.' }), () => go(ee, id, 'approve', { remarks: 'Documents verified.' })];
    steps.slice(0, upTo).forEach((f) => f());
  };
  const N1 = { ee: 'ee_n', aee: 'aee_n', ae: 'ae_n1' }, N2 = { ee: 'ee_n', aee: 'aee_n2', ae: 'ae_n2' };
  const S1 = { ee: 'ee_s', aee: 'aee_s', ae: 'ae_s1' }, S2 = { ee: 'ee_s', aee: 'aee_s2', ae: 'ae_s2' };

  create({ substation_id: 1, title: 'Survey for 220 kV line inspection', survey_date: day(22), priority: 'High', survey_type: 'Line inspection', remarks: 'Inspection ahead of the monsoon. Shutdown window is two days.' });
  const b = create({ substation_id: 2, title: 'Condition assessment of 100 MVA transformer T2', survey_date: day(25), priority: 'Medium', survey_type: 'Equipment inspection', remarks: 'Oil sampling to be done on the survey day.' });
  go('ee_n', b.id, 'approve', { remarks: 'Permission given for North Division.' });
  const c = create({ substation_id: 3, title: 'Thermography survey of 66 kV bus', survey_date: day(18), priority: 'Critical', survey_type: 'Thermography survey', remarks: 'Hot-spot reported on bus section B.' });
  loop(c.id, S1, 2);
  const d = create({ substation_id: 1, title: 'Protection and control panel condition survey', survey_date: day(30), priority: 'Medium' });
  loop(d.id, N1, 3);
  const e = create({ substation_id: 4, title: 'Inspection of 66 kV feeder bays', survey_date: day(28), priority: 'Low', survey_type: 'Line inspection' });
  loop(e.id, S2, 5);
  const f = create({ substation_id: 3, title: 'Inspection of 220 kV circuit breakers', survey_date: day(12), priority: 'High', survey_type: 'Equipment inspection' });
  loop(f.id, S1, 5); go('chief1', f.id, 'start_review'); go('chief1', f.id, 'approve', { remarks: 'Verified. Proceed with the survey.' });
  go('coord1', f.id, 'assign', { surveyor_id: user('sur2').id, remarks: 'Nearest surveyor was busy; assigned manually.' });
  const g = create({ substation_id: 1, title: 'Thermography survey of transformer yard', survey_date: day(9), priority: 'Medium', survey_type: 'Thermography survey' });
  loop(g.id, N1, 5); go('chief1', g.id, 'start_review'); go('chief1', g.id, 'approve', { remarks: 'Approved.' });
  go('coord1', g.id, 'assign', { surveyor_id: user('sur1').id });
  go('sur1', g.id, 'submit_report', { report: 'Thermography completed. No critical hot spots; two minor hot spots on the 66 kV side noted for follow-up.' });
  go('pm1', g.id, 'complete', { remarks: 'Report accepted.' });
  db.prepare('UPDATE requests SET survey_date=? WHERE id=?').run(day(-3), g.id); // the survey has taken place
  const h = create({ substation_id: 2, title: 'Line inspection: 220 kV Hebbal to Yelahanka', survey_date: day(20), priority: 'Medium', survey_type: 'Line inspection' });
  go('ee_n', h.id, 'reject', { reason: 'The required technical documents are missing. Please attach the line outage plan.' });
}

module.exports = { seedDemo };
