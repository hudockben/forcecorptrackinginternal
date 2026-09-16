const E=require('./endpoint');
const jwt=require('jsonwebtoken');
const C='ACME';
function mkRes(){const r={_s:200,_j:null,setHeader(){},status(c){this._s=c;return this},json(o){this._j=o;return this},end(){return this}};return r;}
(async()=>{
  await E.client.connect();
  await E.client.query("DELETE FROM po_deliveries; DELETE FROM purchase_orders; DELETE FROM daily_tracking; DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  const handler=require('../api/purchase-orders');
  const t=jwt.sign({userId:1,companyCode:C,role:'admin',divisionRoles:{paving:'admin',purchase_orders:'admin'},email:'a@b.c'},process.env.JWT_SECRET,{expiresIn:'1h'});
  const H={authorization:'Bearer '+t};
  // 1. paving's own tab saves its list (this is what always happens in production)
  let res=mkRes(); await handler({method:'PUT',headers:H,query:{division:'paving'},body:{purchaseOrders:[{id:'po-Z',po_number:'Z',project_id:'p1',lines:[]}]}},res);
  console.log('paving tab PUT ->',res._s);
  // 2. purchasing raises its very first order against paving
  res=mkRes(); await handler({method:'POST',headers:H,query:{division:'paving'},body:{purchaseOrder:{
    id:'po-N',po_number:'N1',date_created:'2026-09-05',project_id:'p1',cost_code:'3',sub_code:'c',title:'Gravel',supplier:'Q',status:'pending',origin:'purchasing',
    lines:[{id:'X1',date:'2026-09-06',qty:'100',unit_cost:'12'}]}}},res);
  console.log('purchasing FIRST POST ->',res._s,JSON.stringify(res._j).slice(0,160));
  let n=await E.client.query('SELECT count(*)::int c FROM daily_tracking'); console.log('  daily_tracking rows:',n.rows[0].c);
  await E.client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
