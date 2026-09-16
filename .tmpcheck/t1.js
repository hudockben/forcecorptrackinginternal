const {mkSql}=require('./harness');
const poSync=require('../api/lib/po-sync');
(async()=>{
  const sql=await mkSql(false);
  const companyCode='ACME';
  const po={ id:'po-1', po_number:'PO-1001', date_created:'2026-09-01', project_id:'proj-7',
    cost_code:'100', sub_code:'10', title:'Rebar', supplier:'Acme Steel', status:'pending', notes:'',
    lines:[{id:'L1', invoice_num:'INV1', date:'2026-09-02', qty:'10', unit_cost:'5', tax:'', tax_pct:'7', employee:'Bob'}]};

  console.log('--- upsertPO #1 (fresh) ---');
  let r = await poSync.upsertPO(sql, {companyCode, division:'paving', po:JSON.parse(JSON.stringify(po)), from:null});
  console.log(JSON.stringify(r.ok? {ok:r.ok, rows:r.rows, lines:r.purchaseOrder.lines}:r));

  const dt = await sql.__client.query('SELECT row_id,project_id,division,date,cost_code,sub_code,material,supplier,po_num,units_purchased,unit_cost,material_cost FROM daily_tracking');
  console.log('daily_tracking:', JSON.stringify(dt.rows));
  const pos = await sql.__client.query('SELECT id,division,po_num,origin,status,date_created FROM purchase_orders');
  console.log('purchase_orders:', JSON.stringify(pos.rows));
  const dl = await sql.__client.query('SELECT po_id,line_id,delivery_date,units_delivered,unit_cost,delivery_cost,tax,po_row_id FROM po_deliveries');
  console.log('po_deliveries:', JSON.stringify(dl.rows));

  console.log('--- upsertPO #2 (second save, same division) ---');
  const po2 = JSON.parse(JSON.stringify(po));
  po2.lines[0].po_row_id = r.ok ? r.purchaseOrder.lines[0].po_row_id : null;
  po2.title='Rebar (revised)';
  let r2 = await poSync.upsertPO(sql, {companyCode, division:'paving', po:po2, from:null});
  console.log(JSON.stringify(r2));
  const dt2 = await sql.__client.query('SELECT count(*)::int c FROM daily_tracking');
  console.log('daily_tracking count after 2nd save:', dt2.rows[0].c);
  await sql.__client.end();
})().catch(e=>{console.error('ERR',e.message,'\n',e.stack);process.exit(1)});
