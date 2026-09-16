const E=require('./endpoint');
const jwt=require('jsonwebtoken');
const C='ACME';
function mkRes(){const r={_s:200,_j:null,setHeader(){},status(c){this._s=c;return this},json(o){this._j=o;return this},end(){return this}};return r;}
(async()=>{
  await E.client.connect();
  await E.client.query("DELETE FROM po_deliveries; DELETE FROM purchase_orders; DELETE FROM daily_tracking; DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  // A TRUCKING division purchase order exists in the mirror (purchasing holds no trucking role)
  await E.client.query("INSERT INTO purchase_orders (id,company_code,division,po_num,title,status) VALUES ('truck-po-1','ACME','trucking','TR-900','Diesel pump','Open')");
  await E.client.query("INSERT INTO po_deliveries (po_id,company_code,line_id,units_delivered,unit_cost,delivery_cost) VALUES ('truck-po-1','ACME','l1',5,100,500)");
  const handler=require('../api/purchase-orders');
  // Central purchasing ONLY. No turf/paving/kiewit/trucking role at all.
  const t=jwt.sign({userId:9,companyCode:C,role:'level1',divisionRoles:{purchase_orders:'level3'}},process.env.JWT_SECRET,{expiresIn:'1h'});
  const H={authorization:'Bearer '+t};
  console.log('before:',(await E.client.query('SELECT id,division,po_num FROM purchase_orders')).rows,
              (await E.client.query('SELECT count(*)::int c FROM po_deliveries')).rows[0]);
  const res=mkRes();
  await handler({method:'DELETE',headers:H,query:{division:'purchase_orders',id:'truck-po-1'}},res);
  console.log('DELETE ?division=purchase_orders&id=truck-po-1 ->',res._s,JSON.stringify(res._j));
  console.log('after :',(await E.client.query('SELECT id,division,po_num FROM purchase_orders')).rows,
              (await E.client.query('SELECT count(*)::int c FROM po_deliveries')).rows[0]);
  await E.client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
