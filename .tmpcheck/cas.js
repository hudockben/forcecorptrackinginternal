const {Client}=require('pg');
const CS='postgres://postgres:pw@127.0.0.1:5432/fct';
(async()=>{
  const c=new Client({connectionString:CS});
  await c.connect();
  // tagged-template shim that mimics @neondatabase/serverless's neon(): $n params, pg prepareValue, pg-types parsing
  const sql=(strings,...vals)=>{
    let q=''; for(let i=0;i<strings.length;i++){q+=strings[i]; if(i<vals.length)q+='$'+(i+1);}
    return c.query(q,vals).then(r=>r.rows);
  };
  const key='ACME:fct_purchase_orders:paving';
  await c.query('DELETE FROM app_data WHERE key=$1',[key]);

  // --- casWritePOBlob insert arm ---
  const json=JSON.stringify([{id:'po1'}]);
  const inserted=await sql`
    INSERT INTO app_data (key, value, updated_at)
    VALUES (${key}, ${json}::jsonb, clock_timestamp())
    ON CONFLICT (key) DO NOTHING
    RETURNING key`;
  console.log('insert arm landed:', inserted.length>0);

  // --- readPOBlob ---
  const rows=await sql`SELECT value, updated_at FROM app_data WHERE key = ${key}`;
  const base={list:rows[0].value, updatedAt:rows[0].updated_at, exists:true};
  console.log('updatedAt typeof:', typeof base.updatedAt, base.updatedAt instanceof Date ? 'Date' : '', String(base.updatedAt));
  const raw=await c.query('SELECT updated_at::text FROM app_data WHERE key=$1',[key]);
  console.log('stored raw    :', raw.rows[0].updated_at);
  console.log('rebound as    :', require('pg').types===undefined?'':require('/home/user/forcecorptrackinginternal/node_modules/pg/lib/utils.js').prepareValue(base.updatedAt));

  // --- casWritePOBlob update arm ---
  const json2=JSON.stringify([{id:'po1'},{id:'po2'}]);
  const updated=await sql`
    UPDATE app_data
    SET    value = ${json2}::jsonb, updated_at = clock_timestamp()
    WHERE  key = ${key} AND updated_at = ${base.updatedAt}
    RETURNING key`;
  console.log('>>> CAS UPDATE matched rows:', updated.length, updated.length? 'OK':'*** CAS LOST (no concurrent writer) ***');
  await c.end();
})().catch(e=>{console.error('ERR',e.message,e.stack);process.exit(1)});
