const fs=require('fs');const{JSDOM,VirtualConsole}=require('jsdom');
const HTML=fs.readFileSync('/home/user/forcecorptrackinginternal/trucking.html','utf8');
const vc=new VirtualConsole();vc.on('jsdomError',e=>{});
let failFrom = '2026-08-05';   // fail report pulls whose from= equals this
const reportsFor = (from,to)=>REPORTS.filter(r=>r.work_date>=from&&r.work_date<=to);
const REPORTS=[
  {assignment_id:'a1',work_date:'2026-08-10',driver_name:'Barr, Michael',tons:100,loads:5,actual_start:'06:00',actual_end:'14:00'},
  {assignment_id:'a2',work_date:'2026-09-01',driver_name:'Barr, Michael',tons:20,loads:1,actual_start:'06:00',actual_end:'10:00'},
];
const mk=()=>(url)=>{const u=String(url);
  let body={};
  if(u.includes('/data/fct_trucking_schedule')) body={value:{version:1,assignments:{
     '2026-08-10':[{id:'a1',driver:'Barr, Michael',division:'trucking',project:'Acme',unit:'2757',material:'Stone',start:'06:00',end:'14:00'}],
     '2026-09-01':[{id:'a2',driver:'Barr, Michael',division:'trucking',project:'Acme',unit:'2757',material:'Stone',start:'06:00',end:'10:00'}]},hidden:[]}};
  else if(u.includes('/data/fct_trucking_labor_schedule')) body={value:{version:1,assignments:{},hidden:[]}};
  else if(u.includes('trucking-driver-reports')){
    const m=/from=([\d-]+)&to=([\d-]+)/.exec(u);
    if(failFrom && m && m[1]===failFrom) return Promise.resolve({ok:false,status:500,json:()=>Promise.resolve({})});
    body={reports:reportsFor(m[1],m[2])};
  }
  else if(u.includes('/data/')) body={value:null};
  else body={rows:[],jobs:[],reports:[],entries:[]};
  return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(body),text:()=>Promise.resolve('{}')});
};
const dom=new JSDOM(HTML,{runScripts:'dangerously',url:'https://x.test/trucking.html',virtualConsole:vc,
 beforeParse(w){w.localStorage.setItem('fct_token','t');w.localStorage.setItem('fct_user',JSON.stringify({name:'T',role:'admin'}));w.localStorage.setItem('fct_division','trucking');
  w.fetch=mk();w.URL.createObjectURL=()=>'b';w.URL.revokeObjectURL=()=>{};w.print=()=>{};w.alert=()=>{};if(!w.crypto.randomUUID)w.crypto.randomUUID=()=>'u';}});
const win=dom.window,doc=win.document;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=s=>doc.querySelector(s).dispatchEvent(new win.Event('click',{bubbles:true}));
const state=lbl=>{
  const b=doc.getElementById('sched-rec-body');
  const rows=[...b.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  console.log('\n== '+lbl+' ==');
  console.log('  range', win.eval('schedRec.from+".."+schedRec.to'),
              '| reportsRange', win.eval('JSON.stringify(schedRec.reportsRange)'),
              '| errRange', win.eval('JSON.stringify(schedRec.reportsErrRange)'),
              '| err', win.eval('JSON.stringify(schedRec.reportsErr)'));
  rows.forEach(r=>console.log('   date=%s driver=%s actHrs=%s tons=%s status=%s', r[1],r[3],r[16],r[17],r[23]));
  console.log('  totals:', doc.getElementById('sched-rec-totals').textContent);
  console.log('  note:', doc.getElementById('sched-rec-note').textContent);
};
(async()=>{
  await sleep(150);
  click('.tab-btn[data-tab="scheduler"]'); await sleep(200);
  click('.sched-sub-btn[data-board="records"]'); await sleep(300);
  state('A: default last-30-days — reports endpoint fails for this range');
  // Range B = last 7 days: succeeds.
  win.schedRecSetPreset('7');
  console.log('  [sync after setPreset 7]', win.eval('JSON.stringify([schedRec.from,schedRec.to,schedRec.reportsLoading,schedRec.reportsErr,schedRec.reportsErrRange])'));
  await sleep(50);
  console.log('  [50ms]', win.eval('JSON.stringify([schedRec.reportsRange,schedRec.reportsLoading,schedRec.reportsErr,schedRec.reportsErrRange])'));
  await sleep(250);
  state('B: last 7 days — succeeds');
  // Back to range A. Endpoint would still fail, but it is never asked.
  win.schedRecSetPreset('30'); await sleep(400);
  state('C: back to last 30 days — no warning, joined against the 7-day reports');
  process.exit(0);
})();
