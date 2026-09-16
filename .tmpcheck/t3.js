const E=require('./endpoint');
const jwt=require('jsonwebtoken');
const C='ACME';
function mkRes(){const r={_s:200,_j:null,setHeader(){},status(c){this._s=c;return this},json(o){this._j=o;return this},end(){return this}};return r;}
function tok(p){return jwt.sign(p,process.env.JWT_SECRET,{expiresIn:'1h'});}
(async()=>{
  await E.client.connect();
  await E.client.query("DELETE FROM po_deliveries; DELETE FROM purchase_orders; DELETE FROM daily_tracking; DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  const auth=require('../api/lib/auth');
  console.log('PO_SOURCE_DIVISIONS',auth.PO_SOURCE_DIVISIONS,'GENERAL',auth.PO_GENERAL_DIVISION);
  const handler=require('../api/purchase-orders');
  // a turf admin doing the classic full-list PUT
  const t=tok({userId:1,companyCode:C,role:'admin',divisionRoles:{turf:'admin',paving:'admin',kiewit:'admin',purchase_orders:'admin'},email:'a@b.c'});
  const req={method:'PUT',headers:{authorization:'Bearer '+t},query:{division:'paving'},body:{purchaseOrders:[
    {id:'po-A',po_number:'A1',date_created:'2026-09-01',project_id:'p1',cost_code:'1',sub_code:'a',title:'T',supplier:'S',status:'pending',notes:'',
     lines:[{id:'L1',invoice_num:'i',date:'2026-09-02',qty:'2',unit_cost:'3',tax:'1',employee:'e',po_row_id:null}]}]}};
  let res=mkRes(); await handler(req,res); console.log('PUT ->',res._s,JSON.stringify(res._j));
  // GET
  res=mkRes(); await handler({method:'GET',headers:{authorization:'Bearer '+t},query:{division:'paving'}},res);
  console.log('GET ->',res._s,JSON.stringify(res._j).slice(0,400));
  // GET fallback: wipe blob, keep mirror
  await E.client.query("DELETE FROM app_data WHERE key='ACME:fct_purchase_orders:paving'");
  res=mkRes(); await handler({method:'GET',headers:{authorization:'Bearer '+t},query:{division:'paving'}},res);
  console.log('GET fallback ->',res._s,JSON.stringify(res._j).slice(0,600));
  // POST
  res=mkRes(); await handler({method:'POST',headers:{authorization:'Bearer '+t},query:{division:'paving'},body:{purchaseOrder:{
    id:'po-B',po_number:'B1',date_created:'2026-09-03',project_id:'p1',cost_code:'2',sub_code:'b',title:'TB',supplier:'SB',status:'pending',notes:'',origin:'purchasing',
    lines:[{id:'M1',invoice_num:'j',date:'2026-09-04',qty:'4',unit_cost:'2.5',tax_pct:'10',employee:'e2'}]}}},res);
  console.log('POST#1 ->',res._s,JSON.stringify(res._j));
  res=mkRes(); await handler({method:'POST',headers:{authorization:'Bearer '+t},query:{division:'paving'},body:{purchaseOrder:{
    id:'po-B',po_number:'B1',date_created:'2026-09-03',project_id:'p1',cost_code:'2',sub_code:'b',title:'TB2',supplier:'SB',status:'pending',notes:'',origin:'purchasing',
    lines:[{id:'M1',invoice_num:'j',date:'2026-09-04',qty:'4',unit_cost:'2.5',tax_pct:'10',employee:'e2'}]}}},res);
  console.log('POST#2 ->',res._s,JSON.stringify(res._j));
  // DELETE
  res=mkRes(); await handler({method:'DELETE',headers:{authorization:'Bearer '+t},query:{division:'paving',id:'po-B'}},res);
  console.log('DELETE ->',res._s,JSON.stringify(res._j));
  await E.client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
