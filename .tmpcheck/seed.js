const {mkSql}=require('./harness');
(async()=>{
  const sql=await mkSql(false);
  await sql.__client.query("INSERT INTO companies (code,name) VALUES ('ACME','Acme') ON CONFLICT (code) DO NOTHING");
  await sql.__client.query("DELETE FROM po_deliveries; DELETE FROM purchase_orders; DELETE FROM daily_tracking; DELETE FROM app_data WHERE key LIKE 'ACME:%'");
  console.log('seeded');
  await sql.__client.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
