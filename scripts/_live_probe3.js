const fs=require('fs');const{JSDOM,VirtualConsole}=require('jsdom');
const HTML=fs.readFileSync('/home/user/forcecorptrackinginternal/trucking.html','utf8');
const vc=new VirtualConsole();vc.on('jsdomError',e=>console.log('[jsdomError]',e.message));
let delaySchedule = 2000;      // schedule blobs answer slowly
let failLabor = false;
const mk=()=>(url)=>{const u=String(url);
  let body={};
  if(u.includes('/data/fct_trucking_schedule')) body={value:{version:1,assignments:{'2026-09-01':[{id:'a1',driver:'Barr, Michael',division:'trucking',project:'Acme',unit:'2757',material:'Stone',start:'06:00',end:'14:00'}]},hidden:[]}};
  else if(u.includes('/data/fct_trucking_labor_schedule')) body={value:{version:1,assignments:{'2026-09-02':[{id:'b1',driver:'Glatt, Shane',division:'paving',project:'J2',unit:'',material:'',start:'07:00',end:'15:00'}]},hidden:[]}};
  else if(u.includes('trucking-driver-reports')) body={reports:[
      {assignment_id:'a1',work_date:'2026-09-01',driver_name:'Barr, Michael',tons:96,loads:4,actual_start:'06:05',actual_end:'14:20'},
      {assignment_id:'b1',work_date:'2026-09-02',driver_name:'Glatt, Shane',tons:0,loads:0,actual_start:'07:05',actual_end:'15:00'}]};
  else if(u.includes('/data/')) body={value:null};
  else body={rows:[],jobs:[],reports:[],entries:[]};
  const slow = u.includes('/data/fct_trucking_schedule')||u.includes('/data/fct_trucking_labor_schedule');
  if (failLabor && u.includes('fct_trucking_labor_schedule'))
    return new Promise(r=>setTimeout(()=>r({ok:false,status:500,json:()=>Promise.resolve({})}),50));
  return new Promise(r=>setTimeout(()=>r({ok:true,status:200,json:()=>Promise.resolve(body),text:()=>Promise.resolve('{}')}), slow?delaySchedule:0));
};
const dom=new JSDOM(HTML,{runScripts:'dangerously',url:'https://x.test/trucking.html',virtualConsole:vc,
 beforeParse(w){w.localStorage.setItem('fct_token','t');w.localStorage.setItem('fct_user',JSON.stringify({name:'T',role:'admin'}));w.localStorage.setItem('fct_division','trucking');
  w.fetch=mk();w.URL.createObjectURL=()=>'b';w.URL.revokeObjectURL=()=>{};w.print=()=>{};w.alert=()=>{};if(!w.crypto.randomUUID)w.crypto.randomUUID=()=>'u';}});
const win=dom.window,doc=win.document;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=s=>doc.querySelector(s).dispatchEvent(new win.Event('click',{bubbles:true}));
const dump=lbl=>{
  const b=doc.getElementById('sched-rec-body');
  const rows=[...b.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  console.log('\n== '+lbl+' ==');
  rows.forEach(r=>console.log('   board=%j date=%j driver=%j status=%j', r[0],r[1],r[3],r[23]));
  console.log('   totals:', doc.getElementById('sched-rec-totals').textContent);
  console.log('   note:', doc.getElementById('sched-rec-note').textContent);
};
(async()=>{
  await sleep(100);
  click('.tab-btn[data-tab="scheduler"]');
  await sleep(50);
  click('.sched-sub-btn[data-board="records"]');
  await sleep(900);            // reports back, schedules still in flight
  dump('reports back, boards still loading');
  await sleep(2500);           // schedules land
  dump('boards loaded');
  process.exit(0);
})();
