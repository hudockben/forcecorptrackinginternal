const E=require('./endpoint');
const jwt=require('jsonwebtoken');
const C='ACME';
function mkRes(){const r={_s:200,_j:null,setHeader(){},status(c){this._s=c;return this},json(o){this._j=o;return this},end(){return this}};return r;}
(async()=>{
  await E.client.connect();
  await E.client.query("DELETE FROM po_deliveries; DELETE FROM purchase_orders; DELETE FROM daily_tracking; DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  const handler=require('../api/purchase-orders');
  const t=jwt.sign({userId:1,companyCode:C,role:'admin',divisionRoles:{turf:'admin',paving:'admin',purchase_orders:'admin'}},process.env.JWT_SECRET,{expiresIn:'1h'});
  const H={authorization:'Bearer '+t};
  // paving's own tab stores PO-42 with a delivery
  let res=mkRes(); await handler({method:'PUT',headers:H,query:{division:'paving'},body:{purchaseOrders:[
    {id:'po-42',po_number:'PO-0042',date_created:'2026-09-01',project_id:'pjob',cost_code:'5',sub_code:'x',title:'Stone',supplier:'V',status:'pending',
     lines:[{id:'L',date:'2026-09-02',qty:'3',unit_cost:'9',tax:'0',po_row_id:'live-row-1'}]}]}},res);
  console.log('paving PUT ->',res._s);
  await E.client.query("INSERT INTO daily_tracking (row_id,project_id,company_code,division,date,field_type,material_cost) VALUES ('live-row-1','pjob','ACME','paving','2026-09-02','Material',27)");
  console.log('before: po rows',(await E.client.query('SELECT id,division FROM purchase_orders')).rows,
              'deliveries',(await E.client.query('SELECT count(*)::int c FROM po_deliveries')).rows[0].c,
              'dt',(await E.client.query('SELECT count(*)::int c FROM daily_tracking')).rows[0].c);
  // a stale purchasing tab thinks po-42 is in TURF and deletes it there
  res=mkRes(); await handler({method:'DELETE',headers:H,query:{division:'turf',id:'po-42'}},res);
  console.log('DELETE ?division=turf ->',res._s,JSON.stringify(res._j));
  console.log('after : po rows',(await E.client.query('SELECT id,division FROM purchase_orders')).rows,
              'deliveries',(await E.client.query('SELECT count(*)::int c FROM po_deliveries')).rows[0].c,
              'dt',(await E.client.query('SELECT count(*)::int c FROM daily_tracking')).rows[0].c);
  console.log('paving blob still has it:',(await E.client.query("SELECT jsonb_array_length(value) n FROM app_data WHERE key='ACME:fct_purchase_orders:paving'")).rows);
  await E.client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
