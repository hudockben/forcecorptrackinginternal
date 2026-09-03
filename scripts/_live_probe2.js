const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const HTML = fs.readFileSync('/home/user/forcecorptrackinginternal/trucking.html', 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', e => console.log('[jsdomError]', e.message));

const calls = [];
let failReports = false, failSchedule = false;
function makeFetch() {
  return (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('trucking-driver-reports') && failReports) return Promise.resolve({ ok:false, status:500, json:()=>Promise.resolve({}) });
    if (u.includes('/data/fct_trucking') && failSchedule) return Promise.resolve({ ok:false, status:500, json:()=>Promise.resolve({}) });
    let body = {};
    if (u.includes('/data/fct_trucking_schedule')) body = { value:{version:1,assignments:{'2026-09-01':[{id:'a1',driver:'Barr, Michael',division:'trucking',project:'Acme',unit:'2757',material:'Stone',start:'06:00',end:'14:00'}]},hidden:[]} };
    else if (u.includes('/data/fct_trucking_labor_schedule')) body = { value:{version:1,assignments:{'2026-09-02':[{id:'b1',driver:'Glatt, Shane',division:'paving',project:'J2',unit:'',material:'',start:'07:00',end:'15:00'}]},hidden:[]} };
    else if (u.includes('trucking-driver-reports')) body = { reports:[{assignment_id:'a1',work_date:'2026-09-01',driver_name:'Barr, Michael',tons:96,loads:4,actual_start:'06:05',actual_end:'14:20'}] };
    else if (u.includes('/data/')) body = { value:null };
    else body = { rows:[], jobs:[], reports:[], entries:[] };
    return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(body), text:()=>Promise.resolve(JSON.stringify(body)) });
  };
}
const dom = new JSDOM(HTML, { runScripts:'dangerously', url:'https://x.test/trucking.html', virtualConsole:vc,
  beforeParse(win){ win.localStorage.setItem('fct_token','t'); win.localStorage.setItem('fct_user',JSON.stringify({name:'T',role:'admin'})); win.localStorage.setItem('fct_division','trucking');
    win.fetch = makeFetch(); win.URL.createObjectURL=()=>'blob:x'; win.URL.revokeObjectURL=()=>{}; win.print=()=>{}; win.alert=()=>{};
    if(!win.crypto.randomUUID) win.crypto.randomUUID=()=>'u'+Math.random(); } });
const win=dom.window, doc=win.document;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=sel=>{const el=doc.querySelector(sel); if(!el) throw new Error('no '+sel); el.dispatchEvent(new win.Event('click',{bubbles:true}));};
const clickEl=el=>el.dispatchEvent(new win.Event('click',{bubbles:true}));

(async()=>{
  failSchedule = true; failReports = true;
  await sleep(150);
  click('.tab-btn[data-tab="scheduler"]');
  await sleep(200);
  click('.sched-sub-btn[data-board="records"]');
  await sleep(1500);
  const n1 = calls.length;
  await sleep(1500);
  const n2 = calls.length;
  console.log('FAIL MODE: calls after 1.5s =', n1, ' after 3s =', n2, ' (growth', n2-n1, ')');
  console.log('note:', doc.getElementById('sched-rec-note').textContent);
  console.log('note html buttons:', [...doc.getElementById('sched-rec-note').querySelectorAll('button')].map(b=>b.getAttribute('onclick')));
  console.log('body:', doc.getElementById('sched-rec-body').textContent.trim().slice(0,120));
  process.exit(0);
})();
