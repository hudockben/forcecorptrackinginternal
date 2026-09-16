const {Client}=require('pg');
const CS='postgres://postgres:pw@127.0.0.1:5432/fct';
async function mkSql(log){
  const c=new Client({connectionString:CS});
  await c.connect();
  const sql=(strings,...vals)=>{
    let q=''; for(let i=0;i<strings.length;i++){q+=strings[i]; if(i<vals.length)q+='$'+(i+1);}
    if(log) console.log('--SQL--',q.replace(/\s+/g,' ').trim().slice(0,200),'\n  params:',JSON.stringify(vals).slice(0,300));
    return c.query(q,vals).then(r=>r.rows);
  };
  sql.__client=c;
  return sql;
}
module.exports={mkSql,CS};
