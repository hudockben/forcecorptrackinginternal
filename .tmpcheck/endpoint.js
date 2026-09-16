// Replace the neon driver with our pg-backed shim BEFORE the endpoints load.
const path=require('path');
const {Client}=require('pg');
const CS='postgres://postgres:pw@127.0.0.1:5432/fct';
const client=new Client({connectionString:CS});
let CAS_FIX=false;
function sql(strings,...vals){
  let q=''; for(let i=0;i<strings.length;i++){q+=strings[i]; if(i<vals.length)q+='$'+(i+1);}
  if(CAS_FIX) q=q.replace(/updated_at = \$(\d+)/g,"date_trunc('milliseconds',updated_at) = $$$1");
  return client.query(q,vals).then(r=>r.rows);
}
const neonPath=require.resolve('@neondatabase/serverless');
require.cache[neonPath]={id:neonPath,filename:neonPath,loaded:true,exports:{neon:()=>sql}};
process.env.DATABASE_URL='postgres://x';
process.env.JWT_SECRET='test-secret';
module.exports={client,sql,setCasFix:v=>{CAS_FIX=v}};
