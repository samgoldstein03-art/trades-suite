import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").split('document.addEventListener("click"')[0];
const job = {
  id: "j1", business_id: "b1", reference: "J-001", contact_id: "c1", contact_name: "Alex <Sample>",
  quote_id: "q1", quote: { id: "q1", reference: "Q-001", status: "accepted" },
  title: "Furnace <service>", description: "Clean <filter>", service_address: "12 Sample Road <unit 2>",
  job_type: "service", status: "scheduled", scheduled_date: "2027-01-04", arrival_start: "09:00", arrival_end: "11:00",
  time_zone: "America/Vancouver", private_notes: "Owner <only>", link_enabled: false, public_url: null,
  public_updates: [{ id: "u1", message: "Part <arrived>", status: "scheduled", created_at: "2027-01-01T14:00:00Z" }],
};
const initialState = {
  business: { id: "b1", name: "Sample Heating" }, businesses: [{ id: "b1", name: "Sample Heating" }],
  config: { sms_mode: "demo" }, contacts: [{ id: "c1", name: "Alex Sample" }],
  requests: [], quotes: [{ id: "q1", reference: "Q-001", contact_id: "c1", status: "accepted", line_items: [{ description: "Furnace service" }], total_cents: 15000, currency: "CAD" }],
  jobs: [job], activity: [], dashboard: {},
};
function adminContext(overrides = {}) {
  const context = createContext({ URL, location: { href: "https://example.com/", pathname: "/", hash: "#jobs" }, ...overrides });
  new Script(`${frontend}\nstate = ${JSON.stringify(initialState)};`).runInContext(context);
  return context;
}
const run = (context, source) => new Script(source).runInContext(context);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("jobs list offers actual statuses, types and schedule controls and escapes customer content", () => {
  const context = adminContext();
  const html = run(context, "jobsPage()");
  for (const status of ["awaiting_scheduling", "scheduled", "waiting_parts", "in_progress", "completed", "follow_up", "cancelled"]) assert.ok(html.includes(`value="${status}"`));
  assert.match(html, /Jobs & schedule/);
  assert.match(html, /Service & installation/);
  assert.match(html, /Furnace &lt;service&gt;/);
  assert.match(html, /Alex &lt;Sample&gt;/);
  assert.match(html, /12 Sample Road &lt;unit 2&gt;/);
  assert.match(html, /data-action="view-job" data-id="j1"/);
  assert.match(html, /America\/Vancouver/);
  assert.doesNotMatch(html, /Owner &lt;only&gt;/, "private notes do not clutter the list");
});

test("job search, status and type filters combine without mixing results", () => {
  const context = adminContext();
  run(context, `state.jobs.push({...state.jobs[0],id:"j2",title:"Heat pump install",job_type:"installation",status:"awaiting_scheduling",scheduled_date:""});`);
  assert.deepEqual(plain(run(context, 'filteredJobs(state.jobs,{query:"sample road",status:"scheduled",type:"service"}).map(job => job.id)')), ["j1"]);
  assert.deepEqual(plain(run(context, 'filteredJobs(state.jobs,{query:"heat pump",status:"all",type:"installation"}).map(job => job.id)')), ["j2"]);
  assert.deepEqual(plain(run(context, 'filteredJobs(state.jobs,{query:"heat pump",status:"completed",type:"all"})')), []);
  run(context, 'jobsUi.query = "no matching job"');
  assert.match(run(context, "jobsResults()"), /No matching jobs/);
});

test("customer shortcut filters by contact ID, keeping customers with matching names separate", () => {
  const context = adminContext();
  run(context, 'state.jobs.push({...state.jobs[0],id:"j2",contact_id:"c2"});jobsUi.contact="c1"');
  assert.deepEqual(plain(run(context, 'filteredJobs().map(job => job.id)')), ["j1"]);
  assert.match(run(context, "contactsTable(state.contacts)"), /data-action="customer-jobs" data-id="c1"/);
  const page = run(context, "jobsPage()");
  assert.match(page, /Jobs for <strong>Alex Sample/);
  assert.match(page, /Show all customers/);
});

test("schedule groups saved local dates and keeps undated jobs separate from cancelled work", () => {
  const context = adminContext();
  run(context, `jobsUi.view="schedule";jobsUi.day="2027-01-06";jobsUi.span="week";
    state.jobs.push({...state.jobs[0],id:"j2",title:"Unbooked repair",scheduled_date:"",status:"awaiting_scheduling"},
      {...state.jobs[0],id:"j3",title:"Old cancelled visit",status:"cancelled"},
      {...state.jobs[0],id:"j4",title:"Outside this week",scheduled_date:"2027-01-15"});`);
  assert.deepEqual(plain(run(context, "jobAgendaRange()")), { start: "2027-01-04", end: "2027-01-10" });
  const html = run(context, "jobsPage()");
  assert.match(html, /Needs a date/);
  assert.match(html, /Unbooked repair/);
  assert.match(html, /Furnace &lt;service&gt;/);
  assert.doesNotMatch(html, /Old cancelled visit|Outside this week/);
  assert.match(html, /each job’s saved time zone/);
  run(context, 'jobsUi.span="day";jobsUi.day="2027-01-05"');
  assert.match(run(context, "jobsResults()"), /No visits in this view/);
  assert.match(run(context, "jobsResults()"), /Unbooked repair/);
  assert.doesNotMatch(run(context, "jobsResults()"), /Furnace &lt;service&gt;/);
});

test("dashboard job queues use only open saved jobs and tolerate older state without jobs", () => {
  const context = adminContext();
  run(context, `jobToday = () => "2027-01-01";
    state.jobs.push({...state.jobs[0],id:"j2",title:"Needs a visit",scheduled_date:"",status:"awaiting_scheduling"},
    {...state.jobs[0],id:"j3",title:"Finished work",status:"completed"},
    {...state.jobs[0],id:"j4",title:"Cancelled work",status:"cancelled"});`);
  const html = run(context, "dashboardPage()");
  assert.match(html, /Your next jobs/);
  assert.match(html, /Needs booking/);
  assert.match(html, /Needs a visit/);
  assert.doesNotMatch(html, /Finished work|Cancelled work|conversion|jobs won/i);
  run(context, "delete state.jobs");
  assert.match(run(context, "dashboardPage()"), /Turn it into a job/);
});

test("accepted quote offers one create-or-view job action without changing quote terms", () => {
  const context = adminContext();
  assert.match(run(context, "quoteJobAction(state.quotes[0])"), /data-action="view-job" data-id="j1"/);
  run(context, "state.jobs=[]");
  assert.match(run(context, "quoteJobAction(state.quotes[0])"), /data-action="quote-to-job" data-id="q1"/);
  for (const status of ["draft", "sent", "viewed", "declined", "expired"]) assert.equal(run(context, `quoteJobAction({...state.quotes[0],status:"${status}"})`), "");
  assert.doesNotMatch(run(context, 'jobQuoteOptions("other-customer")'), /Q-001/);
});

function formFields() {
  const values = {
    "#job-contact": "c1", "#job-quote": "q1", "#job-title": "Furnace service", "#job-description": "Clean filter",
    "#job-address": "12 Sample Road", "#job-type": "service", "#job-status": "scheduled", "#job-date": "2027-01-04",
    "#job-start": "09:00", "#job-end": "11:00", "#job-zone": "America/Vancouver", "#job-private-notes": "Parts cost $30", "#job-update": "See you Monday.",
  };
  const fields = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value, addEventListener() {} }]));
  fields['button[type="submit"]'] = { disabled: false };
  fields["#job-schedule-help"] = { textContent: "" };
  return fields;
}

test("job save payload keeps local visit time and separates public update from internal notes", () => {
  const fields = formFields();
  const context = adminContext({ form: { querySelector: (selector) => fields[selector] } });
  assert.deepEqual(plain(run(context, "jobFormPayload(form)")), {
    contact_id: "c1", quote_id: "q1", title: "Furnace service", description: "Clean filter", service_address: "12 Sample Road",
    job_type: "service", status: "scheduled", scheduled_date: "2027-01-04", arrival_start: "09:00", arrival_end: "11:00",
    time_zone: "America/Vancouver", private_notes: "Parts cost $30", customer_update: "See you Monday.",
  });
  fields["#job-status"].value = "awaiting_scheduling";
  const unbooked = plain(run(context, "jobFormPayload(form)"));
  assert.equal(unbooked.scheduled_date, "");
  assert.equal(unbooked.arrival_start, "");
  assert.equal(unbooked.arrival_end, "");
  fields["#job-quote"].value = "";
  assert.equal(run(context, "jobFormPayload(form).quote_id"), null);
});

test("time-zone choices keep an existing zone and calendar formatting never shifts a saved date", () => {
  const context = adminContext();
  const html = run(context, 'jobZoneOptions("Pacific/Auckland")');
  assert.match(html, /value="Pacific\/Auckland" selected/);
  assert.match(html, /value="America\/Toronto"/);
  assert.match(run(context, 'jobDate("2027-01-04")'), /4/);
  assert.equal(run(context, 'jobTime("00:15")'), "12:15 am");
  assert.equal(run(context, 'jobTime("17:30")'), "5:30 pm");
  assert.equal(run(context, 'jobAddDays("2027-03-13",2)'), "2027-03-15");
});

test("details label public history and private notes and offer links only when enabled", () => {
  const context = adminContext();
  const disabled = run(context, "jobDetailMarkup(state.jobs[0])");
  assert.match(disabled, /Internal notes · owner only/);
  assert.match(disabled, /Owner &lt;only&gt;/);
  assert.match(disabled, /Part &lt;arrived&gt;/);
  assert.match(disabled, /data-action="share-job"/);
  assert.doesNotMatch(disabled, /data-action="copy-job-link"|Open customer job page|data-action="rotate-job-link"/);
  assert.match(disabled, /No text or email is sent/);
  const enabled = run(context, 'jobDetailMarkup({...state.jobs[0],link_enabled:true,public_url:"https://example.com/j/private-token"})');
  assert.match(enabled, /Anyone with this link can view this job/);
  assert.match(enabled, /data-action="copy-job-link"/);
  assert.match(enabled, /data-action="rotate-job-link"/);
  assert.match(enabled, /data-action="revoke-job-link"/);
  assert.match(enabled, /View Q-001/);
  assert.doesNotMatch(enabled, /Send text|Send email|data-decision=/);
  assert.doesNotMatch(run(context, 'jobDetailMarkup({...state.jobs[0],link_enabled:false,public_url:"https://example.com/j/old-token"})'), /old-token/);
  assert.doesNotMatch(run(context, 'jobDetailMarkup({...state.jobs[0],link_enabled:true,public_url:"javascript:alert(1)"})'), /javascript:/);
});

test("customer links reject injected schemes and allow only the matching local demo file route", () => {
  const context = adminContext();
  assert.equal(run(context, 'safeJobUrl("javascript:alert(1)")'), "");
  assert.equal(run(context, 'safeJobUrl("data:text/html,bad")'), "");
  assert.equal(run(context, 'safeJobUrl("https://example.com@other.example/j/token")'), "");
  run(context, 'state.config.browser_demo=true;location.href="file:///C:/demo/index.html";location.pathname="/C:/demo/index.html"');
  assert.equal(run(context, 'safeJobUrl("file:///C:/demo/index.html#job/private_token")'), "file:///C:/demo/index.html#job/private_token");
  assert.equal(run(context, 'safeJobUrl("file:///C:/other.html#job/private_token")'), "");
  assert.equal(run(context, 'safeJobUrl("file:///C:/demo/index.html#quote/private_token")'), "");
});

test("job editor posts a scoped payload and keeps customer-facing and internal fields clear", async () => {
  const fields = formFields();
  let submit;
  const form = { querySelector: (selector) => fields[selector], addEventListener: (name, handler) => { if (name === "submit") submit = handler; } };
  const content = { innerHTML: "" };
  const modal = { showModal() {}, close() {} };
  const context = adminContext({ document: { querySelector: (selector) => ({ "#dialog-form": form, "#modal-content": content, "#modal": modal })[selector] }, calls: [], notices: [] });
  run(context, `state.jobs=[];api=async (path,options)=>{calls.push({path,options});return {id:"saved-job"}};
    refresh=async()=>{};showJobDetail=(job)=>calls.push({detail:job.id});toast=(message)=>notices.push(message);`);
  run(context, 'jobEditor(undefined,"q1")');
  assert.match(content.innerHTML, /Customer sees/);
  assert.match(content.innerHTML, /Internal notes/);
  assert.match(content.innerHTML, /never appear on the customer page/);
  assert.match(content.innerHTML, /Visit time zone/);
  assert.match(content.innerHTML, /value="Furnace service"/);
  assert.match(content.innerHTML, /Service address/);
  assert.doesNotMatch(content.innerHTML, /12 Sample Road/, "the owner must supply the service address");
  await submit({ preventDefault() {} });
  assert.equal(context.calls[0].path, "/api/businesses/b1/jobs");
  assert.equal(context.calls[0].options.method, "POST");
  assert.equal(JSON.parse(context.calls[0].options.body).time_zone, "America/Vancouver");
  assert.equal(context.calls[1].detail, "saved-job");
  assert.deepEqual(context.notices, ["Job saved."]);
});

test("existing job editor keeps customer and accepted quote fixed while patching the job", async () => {
  const fields = formFields();
  let submit;
  const form = { querySelector: (selector) => fields[selector], addEventListener: (name, handler) => { if (name === "submit") submit = handler; } };
  const content = { innerHTML: "" };
  const context = adminContext({ document: { querySelector: (selector) => ({ "#dialog-form": form, "#modal-content": content, "#modal": { showModal() {} } })[selector] }, calls: [] });
  run(context, 'api=async(path,options)=>{calls.push({path,options});return {id:"j1"}};refresh=async()=>{};showJobDetail=()=>{};toast=()=>{};jobEditor("j1")');
  assert.match(content.innerHTML, /id="job-contact" required disabled/);
  assert.match(content.innerHTML, /id="job-quote" disabled/);
  await submit({ preventDefault() {} });
  assert.equal(context.calls[0].path, "/api/businesses/b1/jobs/j1");
  assert.equal(context.calls[0].options.method, "PATCH");
});

test("slow job detail cannot reopen a closed dialog or show a previous business's record", async () => {
  const content = { innerHTML: "" };
  const modal = { showModal() {}, close() {} };
  const context = adminContext({ document: { querySelector: (selector) => ({ "#modal-content": content, "#modal": modal })[selector] }, resolveJob: null });
  run(context, 'api=()=>new Promise(resolve=>{resolveJob=resolve})');
  const loading = run(context, 'jobDetail("j1")');
  assert.match(content.innerHTML, /Opening job/);
  run(context, 'closeModal();resolveJob(state.jobs[0])');
  await loading;
  assert.doesNotMatch(content.innerHTML, /Internal notes/);
  const switched = run(context, 'jobDetail("j1")');
  run(context, 'state.business={id:"b2",name:"Other business"};resolveJob(state.jobs[0])');
  await switched;
  assert.doesNotMatch(content.innerHTML, /Internal notes|Furnace &lt;service&gt;/);
});

test("link changes use only the scoped action and explain replacement or disabling", async () => {
  const context = adminContext({ calls: [], notices: [] });
  run(context, 'api=async(path,options)=>{calls.push({path,options})};refresh=async()=>{};jobDetail=async(id)=>calls.push({detail:id});toast=(message)=>notices.push(message)');
  await run(context, 'changeJobLink("j1","share")');
  assert.equal(context.calls[0].path, "/api/businesses/b1/jobs/j1/share");
  assert.equal(context.calls[0].options.method, "POST");
  assert.match(context.notices[0], /ready to copy/);
  await run(context, 'changeJobLink("j1","rotate-link")');
  assert.match(context.notices[1], /old link no longer works/);
  await run(context, 'changeJobLink("j1","revoke-link")');
  assert.match(context.notices[2], /turned off/);
  assert.ok(context.calls.every((call) => !call.path || !/sms|email|send/.test(call.path)));
});

test("link action cannot reopen a dismissed job dialog when its response arrives", async () => {
  const context = adminContext({ resolveLink: null, refreshed: 0, reopened: 0 });
  run(context, 'api=()=>new Promise(resolve=>{resolveLink=resolve});refresh=async()=>refreshed++;jobDetail=async()=>reopened++');
  const pending = run(context, 'changeJobLink("j1","share")');
  run(context, 'modalGeneration++;resolveLink({})');
  await pending;
  assert.equal(context.refreshed, 0);
  assert.equal(context.reopened, 0);
});

test("a freshly accepted quote detail makes that quote available to job creation immediately", async () => {
  const content = { innerHTML: "" };
  const context = adminContext({ document: { querySelector: (selector) => ({ "#modal-content": content, "#modal": { showModal() {} } })[selector] } });
  run(context, `state.quotes[0].status="sent";state.jobs=[];api=async()=>({...state.quotes[0],status:"accepted",line_items:[],deliveries:[]})`);
  await run(context, 'quoteDetail("q1")');
  assert.match(content.innerHTML, /data-action="quote-to-job" data-id="q1"/);
  assert.equal(run(context, 'state.quotes[0].status'), "accepted");
});

function editorFixture() {
  const fields = formFields();
  let submit;
  const form = { querySelector: (selector) => fields[selector], addEventListener: (name, handler) => { if (name === "submit") submit = handler; } };
  const content = { innerHTML: "" }, errors = { innerHTML: "" };
  const modal = { showModal() {}, close() {} };
  const context = adminContext({
    document: { querySelector: (selector) => ({ "#dialog-form": form, "#modal-content": content, "#modal": modal, "#dialog-error": errors })[selector] },
    savedRecord: { ...job, id: "saved-job" }, calls: [], notices: [], resolveSave: null, rejectRefresh: null, refreshes: 0,
  });
  run(context, 'toast=message=>notices.push(message)');
  return { context, fields, content, errors, submit: () => submit({ preventDefault() {} }) };
}

test("adding from a customer filter selects that customer, falls back safely if gone and preserves quote ownership", () => {
  const f = editorFixture();
  run(f.context, 'state.jobs=[];state.contacts.push({id:"c2",name:"Other customer"});jobsUi.contact="c2";jobEditor()');
  assert.match(f.content.innerHTML, /<option value="c2" selected>Other customer/);
  run(f.context, 'jobsUi.contact="missing-customer";jobEditor()');
  assert.match(f.content.innerHTML, /<option value="c1" selected>Alex Sample/);
  assert.doesNotMatch(f.content.innerHTML, /value="missing-customer"/);
  run(f.context, 'jobsUi.contact="c2";jobEditor(undefined,"q1")');
  assert.match(f.content.innerHTML, /<option value="c1" selected>Alex Sample/);
  assert.doesNotMatch(f.content.innerHTML, /<option value="c2" selected>/);
});

test("successful job mutations are never repeated when refreshing the workspace fails", async (t) => {
  for (const editing of [false, true]) await t.test(editing ? "PATCH does not republish its customer update" : "POST does not create another job", async () => {
    const f = editorFixture();
    if (!editing) f.fields["#job-quote"].value = "";
    run(f.context, `api=(path,options)=>{calls.push({path,options});return new Promise(resolve=>{resolveSave=resolve})};
      refresh=async()=>{refreshes++;throw new Error("Temporary refresh failure")};jobEditor(${editing ? '"j1"' : ""})`);
    const pending = f.submit();
    assert.equal(f.fields['button[type="submit"]'].disabled, true);
    await f.submit();
    assert.equal(f.context.calls.length, 1, "a second submit while saving cannot repeat the mutation");
    run(f.context, 'resolveSave(savedRecord)');
    await pending;
    assert.equal(f.context.refreshes, 1);
    assert.equal(f.context.calls[0].options.method, editing ? "PATCH" : "POST");
    assert.match(f.content.innerHTML, /<h2>Job saved<\/h2>/);
    assert.match(f.content.innerHTML, /data-action="view-job" data-id="saved-job">Open saved job/);
    assert.doesNotMatch(f.content.innerHTML, /id="dialog-form"|type="submit"/);
    await f.submit();
    assert.equal(f.context.calls.length, 1, "the old form handler stays locked after a successful mutation");
    assert.equal(f.fields['button[type="submit"]'].disabled, true);
    assert.deepEqual(f.context.notices, ["Job saved."]);
  });
});

test("a rejected job mutation can be corrected and retried without a false saved confirmation", async () => {
  const f = editorFixture();
  run(f.context, 'api=async(path,options)=>{calls.push({path,options});throw new Error("Enter a service address.")};refresh=async()=>{refreshes++};jobEditor()');
  await f.submit();
  assert.equal(f.context.refreshes, 0);
  assert.equal(f.fields['button[type="submit"]'].disabled, false);
  assert.match(f.errors.innerHTML, /Enter a service address/);
  assert.deepEqual(f.context.notices, []);
  run(f.context, 'api=async(path,options)=>{calls.push({path,options});return savedRecord}');
  await f.submit();
  assert.equal(f.context.calls.length, 2);
  assert.equal(f.context.refreshes, 1);
  assert.match(f.content.innerHTML, /Internal notes · owner only/);
  assert.equal(run(f.context, 'state.jobs.find(job=>job.id==="saved-job").title'), job.title);
  assert.deepEqual(f.context.notices, ["Job saved."]);
});

test("a saved job renders the returned record without a second read that could invite a mutation retry", async () => {
  const f = editorFixture();
  run(f.context, 'api=async(path,options)=>{calls.push({path,options});if(!options)throw new Error("Reads unavailable");return savedRecord};refresh=async()=>{refreshes++};jobEditor()');
  await f.submit();
  assert.equal(f.context.calls.length, 1);
  assert.match(f.content.innerHTML, /Furnace &lt;service&gt;/);
  assert.match(f.content.innerHTML, /Internal notes · owner only/);
  assert.deepEqual(f.context.notices, ["Job saved."]);
});

test("pending job saves never reopen dismissed or switched dialogs", async (t) => {
  for (const change of ["dismiss", "switch"]) await t.test(change, async () => {
    const f = editorFixture();
    run(f.context, 'api=()=>new Promise(resolve=>{resolveSave=resolve});refresh=async()=>{refreshes++;throw new Error("Refresh unavailable")};jobEditor()');
    const pending = f.submit();
    run(f.context, change === "dismiss" ? 'closeModal()' : 'state.business={id:"other-business"}');
    run(f.context, 'resolveSave(savedRecord)');
    await pending;
    assert.equal(f.context.refreshes, 0);
    assert.deepEqual(f.context.notices, []);
    assert.doesNotMatch(f.content.innerHTML, /<h2>Job saved<\/h2>|Open saved job/);
  });
  await t.test("dismissed while refreshing", async () => {
    const f = editorFixture();
    run(f.context, 'api=async()=>savedRecord;refresh=()=>new Promise((resolve,reject)=>{rejectRefresh=reject});jobEditor()');
    const pending = f.submit();
    await Promise.resolve();
    run(f.context, 'closeModal();rejectRefresh(new Error("Refresh unavailable"))');
    await pending;
    assert.deepEqual(f.context.notices, []);
    assert.doesNotMatch(f.content.innerHTML, /<h2>Job saved<\/h2>|Open saved job/);
  });
});
