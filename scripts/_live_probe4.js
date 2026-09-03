const fs=require('fs');const{JSDOM,VirtualConsole}=require('jsdom');
const HTML=fs.readFileSync('/home/user/forcecorptrackinginternal/trucking.html','utf8');
const vc=new VirtualConsole();vc.on('jsdomError',e=>console.log('[jsdomError]',e.message));
const puts=[];
const mk=()=>(url,opts)=>{const u=String(url);
  if(opts&&opts.method==='PUT') puts.push([u, opts.body]);
  let body={};
  if(u.includes('/data/fct_trucking_schedule')) body={value:{version:1,assignments:{'2026-09-01':[{id:'a1',driver:'Barr, Michael',division:'trucking',project:'Acme',unit:'2757',material:'Stone',start:'06:00',end:'14:00'}]},hidden:[]}};
  else if(u.includes('/data/fct_trucking_labor_schedule')) body={value:{version:1,assignments:{'2026-09-02':[{id:'b1',driver:'Glatt, Shane',division:'paving',project:'J2',unit:'',material:'',start:'07:00',end:'15:00'}]},hidden:[]}};
  else if(u.includes('trucking-driver-reports')) body={reports:[{assignment_id:'a1',work_date:'2026-09-01',driver_name:'Barr, Michael',tons:96,loads:4,actual_start:'06:05',actual_end:'14:20'}]};
  else if(u.includes('/data/')) body={value:null};
  else body={rows:[],jobs:[],reports:[],entries:[]};
  return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(body),text:()=>Promise.resolve('{}')});
};
const dom=new JSDOM(HTML,{runScripts:'dangerously',url:'https://x.test/trucking.html',virtualConsole:vc,
 beforeParse(w){w.localStorage.setItem('fct_token','t');w.localStorage.setItem('fct_user',JSON.stringify({name:'T',role:'admin'}));w.localStorage.setItem('fct_division','trucking');
  w.fetch=mk();w.URL.createObjectURL=()=>'b';w.URL.revokeObjectURL=()=>{};w.print=()=>{};w.alert=()=>{};if(!w.crypto.randomUUID)w.crypto.randomUUID=()=>'u'+Math.random();}});
const win=dom.window,doc=win.document;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=s=>{const e=doc.querySelector(s); if(!e){console.log('MISSING',s);return;} e.dispatchEvent(new win.Event('click',{bubbles:true}));};
const ev=(el,t)=>el.dispatchEvent(new win.Event(t,{bubbles:true}));
(async()=>{
  await sleep(150);
  click('.tab-btn[data-tab="scheduler"]'); await sleep(300);
  // open the assignment editor on the trucking board
  win.schedOpenEditor('2026-09-01','a1','');
  console.log('editor open?', doc.getElementById('sched-backdrop').className, 'ctx', JSON.stringify(win.eval('schedCtx')));
  // open picker too
  win.schedOpenPicker && win.schedOpenPicker();
  click('.sched-sub-btn[data-board="records"]'); await sleep(400);
  console.log('after switch -> editor', doc.getElementById('sched-backdrop').className,
              'ctx', JSON.stringify(win.eval('schedCtx')),
              'picker', doc.getElementById('sched-pick-backdrop').className,
              'report', doc.getElementById('sched-rep-backdrop').className);
  // interact
  const q=doc.getElementById('sched-rec-q'); q.value='barr'; ev(q,'input'); await sleep(20);
  console.log('search barr rows', doc.getElementById('sched-rec-body').querySelectorAll('tr').length);
  q.value=''; ev(q,'input');
  const f=doc.getElementById('sched-rec-f-driver'); f.focus(); f.value='glatt'; ev(f,'input'); await sleep(20);
  console.log('focus kept after col filter?', doc.activeElement===f, 'rows', doc.getElementById('sched-rec-body').querySelectorAll('tr').length);
  // now simulate a board update landing while typing
  win.eval("_schedStates.trucking.assignments['2026-09-01'].push({id:'zz',driver:'Glatt, Shane',division:'trucking',project:'X',unit:'',material:'',start:'08:00',end:'16:00'}); schedRerender('trucking');");
  await sleep(30);
  console.log('after board update: focus kept?', doc.activeElement===f, 'value', f.value,
    'rows', doc.getElementById('sched-rec-body').querySelectorAll('tr').length);
  // sort
  const th=[...doc.querySelectorAll('#sched-rec-hdr th')][3];
  ev(th,'click'); await sleep(20);
  console.log('after sort focus kept?', doc.activeElement===f);
  // clear
  win.schedRecClear(); await sleep(20);
  console.log('after clear: q=',doc.getElementById('sched-rec-q').value,'f=',f.value,'rows',doc.getElementById('sched-rec-body').querySelectorAll('tr').length);
  // download
  try { win.schedRecDownload(); console.log('download ok'); } catch(e){ console.log('DOWNLOAD THREW', e.message); }
  // round trip preserving state
  const q2=doc.getElementById('sched-rec-q'); q2.value='barr'; ev(q2,'input'); await sleep(10);
  win.schedRecSortBy('tons'); await sleep(10);
  console.log('sort now', JSON.stringify(win.eval('schedRec.sort')));
  click('.sched-sub-btn[data-board="trucking"]'); await sleep(200);
  click('.sched-sub-btn[data-board="records"]'); await sleep(200);
  console.log('round trip: q box=',doc.getElementById('sched-rec-q').value,
    'sort',JSON.stringify(win.eval('schedRec.sort')),
    'hdr sorted col', doc.querySelector('#sched-rec-hdr th.sorted') && doc.querySelector('#sched-rec-hdr th.sorted').textContent.trim());
  console.log('puts', puts.length, puts.map(p=>p[0]));
  process.exit(0);
})();
