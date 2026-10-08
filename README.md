# Substation Survey Management & Scheduling (KPTCL CMS module)

A working prototype of the **Survey module of the KPTCL CMS**, plus the **separate public portal** that feeds requests into it.
It exists to prove the risky ideas early, not to be the production system.

- No dependencies. Needs **Node.js 22.13 or newer**. Data is in memory, so every restart is a clean slate.
- 43 automated tests try to break the rules. All pass.

## Run it

```bash
npm start                      # http://localhost:3000   (CMS)   and   /portal   (public)
npm test                       # 47 tests
```

Optional: `PORT=3100`, `OFFER_TTL_MS=20000` (seconds a surveyor has to answer an offer; default 120 s), `SEED_PASSWORD=...`, `SECURE_COOKIES=1` (behind HTTPS).

**Demo logins** (password `Demo@12345!`, demo data only): `coord1` (Project Coordinator), `ee_n`, `aee_n`, `ae_n1`, `chief1`, `seit1` (watches only), `sur1`, `sur2`, `sur3` (Surveyors), `pm1`, `admin1`. A second division exists: `ee_s`, `aee_s`, `ae_s1`, plus `ae_n2`.

## What it proves

| Idea from the concept | Where it lives | How it is proven |
|---|---|---|
| One workflow, one owner at each stage (EE → AEE → AE → AEE → EE → Chief → surveyor → report → PM). SEIT watches every step and approves nothing; there is no QC step | `lib/workflow.js` (single `STAGES` table) | Happy-path test walks every stage; wrong-role tests |
| Role-based dashboards, enforced on the **server** | `visibleWhere()` + `allowedActions()` | Permission-matrix test: AE, AEE, Coordinator, Chief, SEIT, other division, other substation, Surveyor, Admin all refused |
| Admin manages access but cannot approve or even see requests | `ADMIN` has no visibility and no actions | Admin tests |
| LC rejection window: reason + new tentative date, shared with the whole chain, then a new LC | `reject` / `resubmit` actions; UI modal with calendar | Rejection tests (EE, AEE and AE each tested); SEIT, Chief, EE, AEE, AE and Coordinator are notified; other divisions are not |
| No double-booking of a surveyor | Database `UNIQUE(surveyor_id, date)` + application check | Manual-assign clash returns 409 and rolls back; direct database insert also fails |
| Nearest-surveyor matching (ride-booking style) | `lib/matching.js` | Nearest first; decline → next; no answer in time → next; nobody left → coordinator notified, manual assign |
| Surveyor location only with consent, erased when offline | `/api/surveyor/status` | Test checks location columns are empty after going offline |
| Public portal separate from the CMS | `/portal/api/*`, own accounts, own cookie | Portal session useless on CMS API and vice versa; requests land in **Intake review**; customers see only their own requests |
| Tamper-evident history | `lib/audit.js` (hash chain) | Editing a past row directly in the database is detected |

Web hardening that is tested: login lockout after 5 failures, no user enumeration, per-IP rate limit, HttpOnly + SameSite=Strict cookies, CSRF header + origin check, JSON only, request size limit, security headers (CSP, nosniff, frame denial), no stack traces to users, parameterised queries, no `innerHTML` in the front end.

## A 10-minute demo script

1. Sign in as `coord1` → **New request** → pick a substation and a date → **Create**. (Dashboard shows SR-1001 awaiting the EE.)
2. New window: `ee_n` → open SR-1001 → **Reject LC…** → write a reason, pick a new date on the calendar → **Submit rejection**.
3. `seit1` (or `chief1`, `aee_n`, `ae_n1`) → **Notifications**: the reason and new tentative date are there. `ee_s` (other division) sees nothing.
4. `coord1` → SR-1001 → **Submit new LC…** → confirm the date. The request goes back to the EE.
5. Approve in turn: `ee_n`, `aee_n`, `ae_n1`, `aee_n`, `ee_n`, `chief1`, `seit1`. Try approving as the wrong person: the button is not shown, and the server refuses it if forced.
6. `sur1` → **My offers** → the nearest surveyor is offered the job (distance shown) → **Accept**. Their **My calendar** now shows the booked date.
7. Try to double-book: create a second request for the same date, finish its approvals, then as `coord1` assign `sur1` manually: *"This surveyor is already assigned on the selected date."*
8. Let an offer time out (set `OFFER_TTL_MS=15000`) or **Decline**: it moves to the next nearest surveyor.
9. `admin1` → **Users & access** (create a KPTCL user) and **Audit log** → **Verify chain**. Admin sees no requests.
10. `/portal` → create an account → send a request → `coord1` sees it in **Intake review** → **Accept public request** starts the approval chain.

## Latest changes (15 requested updates)

- **Forms**: the coordinator adds *remarks* and *LC documents* when requesting (and again with a revised LC).
- **Buttons**: "Forward to AEE / AE / EE / Chief" instead of "approve"; the Chief's is "Approve & send to surveyor". Two reject buttons: **Reject** (reason only) and **Reschedule & reject** (reason + new date). Rejected LCs show as **SR-1003 (Revised)**.
- **Loop 1**: the AE has 4 days to upload documents (can save in steps, must attach at least one to forward); the AEE has 2 days to review. Documents are visible to the AEE/EE once forwarded and to every authority after the EE verifies. Missed deadlines notify the people above, once.
- **SEIT** only watches. After the Chief approves, the nearest free surveyor is offered the job. **QC is removed**: the report goes to the PM.
- **Contact**: Mail and Call buttons for every authority; once a surveyor is assigned, all authorities see their name and phone.
- **Look**: a light glass theme in white and blue (frosted panels, floating sidebar, rounded calendar tiles).
- **Calendar** now lives on the dashboard (no separate menu item) for EE, AEE, AE, Chief, SEIT, Coordinator and PM: counts per day, click a day for every survey with status, surveyor, who has it now, and a **Full report** (printable).
- **Reports** is one expandable item in the sidebar with three pages inside: All approved LCs, LC rejected, LC scheduled (click a row for the full report; CSV download).

## What this PoC deliberately does NOT do

These are the gaps between a prototype and something that could be hosted on KPTCL infrastructure:

- **Real integration with the CMS**: it is standalone, with its own users and database. The real work is mapping onto the CMS's sign-in, roles and database (see "Open questions").
- **Real sign-in**: demo passwords, in-memory sessions, no multi-factor for officials, no OTP / email verification / CAPTCHA for public users.
- **Production data layer**: in-memory SQLite, no migrations, no encrypted backups, no recovery plan.
- **Network design**: the portal and CMS run in one process. In production they must be separate zones with a narrow, authenticated interface between them.
- **Rate limiting, logging and monitoring** are in-process only; production needs a gateway, central logs, alerting.
- **Notifications** are in-app only (no SMS / email / WhatsApp).
- **File storage**: uploads (PDF, PNG, JPG, DOCX, XLSX; 4 files, 2 MB each) are type-checked and kept in the database. Production needs an object store, malware scanning and retention rules.
- **Real map or distance routing**: matching uses straight-line distance from coordinates the surveyor enters.
- **Accessibility, load and penetration testing, CERT-In audit, DPDP notices and consent screens**: not done. A security audit is a separate, mandatory step.
- Demo substations are fictional, and the same demo password is shared by all seeded users.

## Assumptions to confirm (they are written into the code)

1. A rejection can happen at EE, AEE and AE stages only. After the Coordinator submits the new LC, the request restarts at the EE.
2. Public requests are screened by the Coordinator (**Intake review**) before the approval chain starts; this is an anti-abuse gate.
3. Matching starts after the SEIT's approval. Only one surveyor is offered at a time, and the Coordinator can override at any point.
4. QC sees a request only from report review onward; Admin sees no requests; the Coordinator and PM see all.
5. EE and AEE are limited to their division, and AE to their substation.
6. One booking per surveyor per date (date-based, as agreed).

## Open questions for the CMS team

What stack, database and hosting does the CMS use? How do users sign in and who manages roles? When was it last security-audited, and how are changes released? Is public registration permitted anywhere near the CMS, or must the portal be isolated as designed here?

## Layout

```
server.js            HTTP server, routes, sessions, hardening
lib/workflow.js      stages, ownership, permissions, rejection, resubmission
lib/matching.js      nearest-surveyor offers, expiry, booking
lib/audit.js         hash-chained audit log
lib/security.js      password hashing, validation, rate limiter
lib/db.js            schema, demo data
public/              CMS front end, public portal, shared UI (icons, layout), calendar widget
test/poc.test.js     28 tests
docs/screenshots/    screens from a real browser run
```

## Dashboard layout and required LC documents
- Requests now sit right under the KPI tiles (the "Your focus" banner is a slim one-line strip); the calendar is below.
- The request detail panel stays pinned beside the list and scrolls on its own, with contacts in a compact two-column grid, so there is no blank column while reading a long request.
- LC documents are required when the Coordinator creates a request and when resubmitting a revised LC (checked in the form and on the server). Public-portal intake stays file-less.

## Changes in this round
- **Review first:** the "Your focus" banner is gone. Requests waiting for the officer appear as review cards at the top, and the first one opens in the detail panel automatically.
- **Clickable tiles:** Need your action, In approval, Assigning / scheduled, Completed and LC rejected filter the request list (click again to clear).
- **AE:** step 1 approve the LC (reject / reschedule & reject still possible); step 2 upload documents and forward to the AEE. After the LC is approved there is no rejection. The 4-day clock starts at approval.
- **AEE and EE:** no rejection after the LC is approved. They use **Backtrack to AE** (reason required) or forward. The EE can backtrack straight to the AE, skipping the AEE, who is notified.
- **Chief:** step 1 receive the LC and send it to review; step 2 LC verified, send to surveyor.
- **Hierarchy filter:** Zone > Circle > Division > Nodal centre > Substation (Chief, SEIT, Coordinator, PM); EE filters by nodal centre and substation; AEE by substation; AE has none. Demo substations now carry zone, circle and nodal centre.
- **Surveyor:** sees the job, date, documents and a countdown only: no flow, stages or history.

## Information architecture redesign (latest)

Same look, new structure. Every screen answers: what is this, who has it, what action is required, where does it go next.

- **Hierarchy and workflow are separate.** Authority chain (Chief by zone → EE by division → AEE by nodal centre → AE by substation) is its own component; the workflow tracker shows the lifecycle (EE review, AEE review, AE action, AEE document review, EE verification, Chief approval, surveyor assignment, survey, report review, completed). No arbitrary step numbers.
- **Sidebar:** Dashboard · Requests (All Requests, Pending My Action, In Review, Scheduled, Completed, Rejected) · New Request (Coordinator) · Calendar · Reports · Notifications. It collapses on desktop and becomes a slide-in menu on small screens. "Survey Request" replaces "LC" everywhere.
- **Dashboard:** KPI cards open the matching list and show exactly the same count; Action Required cards, Recent Requests, Upcoming Surveys, mini calendar, Recent Activity. The calendar, lists and KPIs all read the same request list (`group` from `lib/workflow.js`).
- **Requests list:** search (ID, title, substation, nodal centre, survey type), hierarchy filters locked to the officer's own scope (Chief: zone; EE: zone and division; AEE: plus nodal centre; AE: all), status, priority, survey-date range. No horizontal scroll: the table turns into stacked rows below 1100 px.
- **Request detail is a full page:** current stage / owner / previous stage / next authority, required action, SLA badge, priority, workflow tracker, authority chain, details with "Not assigned" style fallbacks, documents (View / Download), activity timeline with comments, key contacts and "View all contacts".
- **Actions** are role-based and explicit ("Approve & Forward to AEE", "Reject Request", "Reschedule Survey", "Backtrack to AE", "Return for Correction", "Approve Report"). Each opens a confirmation dialog; comments are marked required or optional. Reject and Reschedule are separate actions; Reschedule keeps the stage and moves only the date.
- **Notifications** are categorised (Action Required, Approvals, Schedule Changes, Assignments, System), link to the request, and are only marked read by the user.
- **Deadlines (SLA):** AE 4 days, AEE 2, EE 2, Chief 2, PM 2 (everything except AE 4 and AEE 2 are defaults to confirm).
- **Demo data:** eight sample requests are created through the real workflow at start-up (set `NO_DEMO=1` to start empty). "DEMO ENVIRONMENT" is shown to Admin only.
