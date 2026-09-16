const E=require('./endpoint');
const jwt=require('jsonwebtoken');
const C='ACME';
function mkRes(){const r={_s:200,_j:null,setHeader(){},status(c){this._s=c;return this},json(o){this._j=o;return this},end(){return this}};return r;}
(async()=>{
  await E.client.connect();
  await E.client.query("DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  const put=(k,v)=>E.client.query('INSERT INTO app_data(key,value) VALUES($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',[ 'ACME:'+k, JSON.stringify(v)]);
  await put('fct_projects_index',['1','2']);
  await put('fct_project_1',{id:'1','project-name':'Turf A','job-number':'T-1',bidItems:[{cost_code:'10',sub_code:'a',description:'d'}]});
  await put('fct_project_2',{id:'2','project-name':'Turf B','job-number':'T-2',bidItems:[]});
  await put('fct_lists',{suppliers:[{name:'Acme Steel',state:'FL'},'Loose String Vendor'],employees:[{name:'Bob'}]});
  await put('fct_paving_projects_index',{ids:['9']});
  await put('fct_paving_project_9',{id:'9','project-name':'Paving X','job-number':'P-9',bidItems:[{cost_code:'20',sub_code:'b'}]});
  await put('fct_paving_lists',{suppliers:[{name:'acme steel',phone:'555'}],employees:[{name:'bob'},{name:'Sue'}]});
  const t=jwt.sign({userId:1,companyCode:C,role:'level1',divisionRoles:{purchase_orders:'level3'},email:'p@b.c'},process.env.JWT_SECRET,{expiresIn:'1h'});
  const h=require('../api/po-catalog');
  const res=mkRes(); await h({method:'GET',headers:{authorization:'Bearer '+t},query:{}},res);
  console.log('po-catalog ->',res._s); console.log(JSON.stringify(res._j,null,1));
  await E.client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
