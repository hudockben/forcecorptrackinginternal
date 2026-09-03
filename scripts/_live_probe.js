const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const HTML = fs.readFileSync('/home/user/forcecorptrackinginternal/trucking.html', 'utf8');

const vc = new VirtualConsole();
vc.on('jsdomError', e => console.log('[jsdomError]', e.message));
['error','warn','log'].forEach(k=>vc.on(k,(...a)=>console.log('[page]',...a)));

const calls = [];
function makeFetch(win) {
  return (url, opts) => {
    calls.push(String(url));
    const u = String(url);
    let body = {};
    if (u.includes('/data/fct_trucking_schedule')) body = { value: { version:1, assignments: { '2026-09-01': [ {id:'a1',driver:'Barr, Michael',division:'trucking',project:'Acme',unit:'2757',material:'Stone',start:'06:00',end:'14:00'} ] }, hidden: [] } };
    else if (u.includes('/data/fct_trucking_labor_schedule')) body = { value: { version:1, assignments: { '2026-09-02': [ {id:'b1',driver:'Glatt, Shane',division:'paving',project:'Job 2',unit:'',material:'',start:'07:00',end:'15:00'} ] }, hidden: [] } };
    else if (u.includes('trucking-driver-reports')) body = { reports: [ { assignment_id:'a1', work_date:'2026-09-01', driver_name:'Barr, Michael', tons: 96, loads: 4, actual_start:'06:05', actual_end:'14:20' } ] };
    else if (u.includes('/data/')) body = { value: null };
    else body = { rows: [], jobs: [], reports: [], entries: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };
}

const dom = new JSDOM(HTML, {
  runScripts: 'dangerously',
  url: 'https://x.test/trucking.html',
  virtualConsole: vc,
  beforeParse(win) {
    win.localStorage.setItem('fct_token', 't');
    win.localStorage.setItem('fct_user', JSON.stringify({ name: 'Test', role: 'admin' }));
    win.localStorage.setItem('fct_division', 'trucking');
    win.fetch = makeFetch(win);
    win.crypto = win.crypto || {}; 
    if (!win.crypto.randomUUID) win.crypto.randomUUID = () => 'uuid-' + Math.random().toString(36).slice(2);
    win.URL.createObjectURL = () => 'blob:x';
    win.URL.revokeObjectURL = () => {};
    win.print = () => {};
    win.alert = () => {};
  },
});
const win = dom.window, doc = win.document;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dupIds = () => {
  const seen = new Map(), dup = [];
  doc.querySelectorAll('[id]').forEach(el => {
    const id = el.id;
    seen.set(id, (seen.get(id)||0)+1);
  });
  seen.forEach((n,id) => { if (n>1) dup.push(id+' x'+n); });
  return dup;
};
const click = sel => { const el = doc.querySelector(sel); if (!el) throw new Error('no '+sel); el.dispatchEvent(new win.Event('click', {bubbles:true})); };

(async () => {
  await sleep(200);
  console.log('--- initial dup ids:', dupIds());
  // go to scheduler
  click('.tab-btn[data-tab="scheduler"]');
  await sleep(300);
  console.log('after scheduler: schedView=', win.eval('schedView'), 'schedBoard=', win.eval('schedBoard'));
  console.log('trucking panel len', doc.getElementById('sched-board-trucking').innerHTML.length,
              'labor', doc.getElementById('sched-board-labor').innerHTML.length,
              'records', doc.getElementById('sched-board-records').innerHTML.length);
  console.log('dup ids:', dupIds());

  click('.sched-sub-btn[data-board="records"]');
  await sleep(400);
  console.log('after records: schedView=', win.eval('schedView'), 'schedBoard=', win.eval('schedBoard'));
  console.log('trucking panel len', doc.getElementById('sched-board-trucking').innerHTML.length,
              'labor', doc.getElementById('sched-board-labor').innerHTML.length,
              'records', doc.getElementById('sched-board-records').innerHTML.length);
  console.log('dup ids:', dupIds());
  const body = doc.getElementById('sched-rec-body');
  console.log('rows drawn:', body ? body.querySelectorAll('tr').length : 'NO BODY');
  console.log('note:', (doc.getElementById('sched-rec-note')||{}).textContent);
  console.log('totals:', (doc.getElementById('sched-rec-totals')||{}).textContent);

  // round trip
  click('.sched-sub-btn[data-board="labor"]');
  await sleep(300);
  console.log('after labor: view/board', win.eval('schedView'), win.eval('schedBoard'), 'dups', dupIds());
  console.log('lens', doc.getElementById('sched-board-trucking').innerHTML.length,
              doc.getElementById('sched-board-labor').innerHTML.length,
              doc.getElementById('sched-board-records').innerHTML.length);
  click('.sched-sub-btn[data-board="records"]');
  await sleep(300);
  console.log('back to records: dups', dupIds(), 'rows', doc.getElementById('sched-rec-body').querySelectorAll('tr').length);
  console.log('fetch calls:', calls.length);
  console.log(calls.filter(c=>c.includes('driver-reports')));
  process.exit(0);
})();
