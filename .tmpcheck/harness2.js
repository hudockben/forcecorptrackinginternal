const {Client}=require('pg');
const CS='postgres://postgres:pw@127.0.0.1:5432/fct';
// Same shim, but neutralises the microsecond CAS mismatch (finding #1) so the
// REST of the code path can be exercised. po-sync.js itself is untouched.
async function mkSql(log){
  const c=new Client({connectionString:CS});
  await c.connect();
  const sql=(strings,...vals)=>{
    let q=''; for(let i=0;i<strings.length;i++){q+=strings[i]; if(i<vals.length)q+='$'+(i+1);}
    const patched=q.replace(/updated_at = \$(\d+)/g, "date_trunc('milliseconds',updated_at) = $$$1");
    if(log) console.log('--SQL--',patched.replace(/\s+/g,' ').trim().slice(0,260),'\n  params:',JSON.stringify(vals).slice(0,300));
    return c.query(patched,vals).then(r=>r.rows);
  };
  sql.__client=c;
  return sql;
}
module.exports={mkSql,CS};
