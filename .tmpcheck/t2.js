const {mkSql}=require('./harness2');
const poSync=require('../api/lib/po-sync');
const C='ACME';
(async()=>{
  const sql=await mkSql(false);
  await sql.__client.query("DELETE FROM po_deliveries; DELETE FROM purchase_orders; DELETE FROM daily_tracking; DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  const mk=()=>({ id:'po-1', po_number:'PO-1001', date_created:'2026-09-01', project_id:'proj-7',
    cost_code:'100', sub_code:'10', title:'Rebar', supplier:'Acme Steel', status:'pending', notes:'',
    lines:[{id:'L1', invoice_num:'INV1', date:'2026-09-02', qty:'10', unit_cost:'5', tax:'', tax_pct:'7', employee:'Bob'}]});

  let r=await poSync.upsertPO(sql,{companyCode:C,division:'paving',po:mk(),from:null});
  console.log('save1',r.ok, r.rows);
  const rid=r.purchaseOrder.lines[0].po_row_id;
  const a=JSON.parse(JSON.stringify(r.purchaseOrder));
  a.title='Rebar v2';
  let r2=await poSync.upsertPO(sql,{companyCode:C,division:'paving',po:a,from:null});
  console.log('save2',r2.ok, r2.rows, 'sameRow:', r2.ok && r2.purchaseOrder.lines[0].po_row_id===rid);
  let dt=await sql.__client.query('SELECT row_id,material,division,project_id,cost_code,sub_code,material_cost FROM daily_tracking');
  console.log('dt after save2:',JSON.stringify(dt.rows));

  console.log('--- move to kiewit ---');
  const b=JSON.parse(JSON.stringify(r2.purchaseOrder));
  b.project_id='kjob-3';
  let r3=await poSync.upsertPO(sql,{companyCode:C,division:'kiewit',po:b,from:'paving'});
  console.log('move',r3.ok, r3.rows, 'staleCopy:',r3.staleCopy);
  dt=await sql.__client.query('SELECT row_id,division,project_id,material_cost FROM daily_tracking');
  console.log('dt after move:',JSON.stringify(dt.rows));
  let blobs=await sql.__client.query("SELECT key, jsonb_array_length(value) n FROM app_data WHERE key LIKE 'ACME:%' ORDER BY key");
  console.log('blobs:',JSON.stringify(blobs.rows));
  let pt=await sql.__client.query('SELECT id,division,project_id FROM purchase_orders');
  console.log('po table:',JSON.stringify(pt.rows));

  console.log('--- move to purchase_orders (general) ---');
  const d=JSON.parse(JSON.stringify(r3.purchaseOrder));
  let r4=await poSync.upsertPO(sql,{companyCode:C,division:'purchase_orders',po:d,from:'kiewit'});
  console.log('gen',r4.ok, r4.rows);
  dt=await sql.__client.query('SELECT count(*)::int c FROM daily_tracking'); console.log('dt count:',dt.rows[0].c);
  pt=await sql.__client.query('SELECT id,division,project_id FROM purchase_orders'); console.log('po table:',JSON.stringify(pt.rows));

  console.log('--- delete ---');
  let r5=await poSync.removePO(sql,{companyCode:C,division:'purchase_orders',poId:'po-1'});
  console.log('del',JSON.stringify(r5));
  await sql.__client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
