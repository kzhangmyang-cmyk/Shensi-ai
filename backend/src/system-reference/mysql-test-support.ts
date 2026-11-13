import {randomUUID} from 'node:crypto';
import mysql from 'mysql2/promise';

/** Same owned-database lifecycle as financial-council tests, with Unix-socket support.
 * Explicit test configuration only: never reads DATABASE_URL or local env files. */
export async function createReferenceTestDatabase(){
  const configured=process.env.MYSQL_TEST_ADMIN_URL;
  if(!configured)throw Error('MYSQL_TEST_ADMIN_URL_REQUIRED:system-reference');
  let url:URL;try{url=new URL(configured);}catch{throw Error('MYSQL_TEST_ADMIN_URL_INVALID:system-reference');}
  if(url.protocol!=='mysql:')throw Error('MYSQL_TEST_ADMIN_URL_INVALID:system-reference');
  const options={host:url.hostname,port:Number(url.port||3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),
    ...(url.searchParams.get('socketPath')?{socketPath:url.searchParams.get('socketPath')!}:{}),timezone:'Z' as const};
  const name=`shensi_reference_test_${randomUUID().replaceAll('-','')}`;
  const admin=await mysql.createConnection(options);const pools:mysql.Pool[]=[];let created=false,closed=false;
  try{
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
    const openPool=(connectionLimit=8)=>{const pool=mysql.createPool({...options,database:name,connectionLimit});pools.push(pool);return pool;};
    return {name,pool:openPool(),openPool,async close(){
      if(closed)return;closed=true;
      try{await Promise.all(pools.map(pool=>pool.end()));await admin.query(`DROP DATABASE \`${name}\``);}finally{await admin.end();}
    }};
  }catch(error){if(created)await admin.query(`DROP DATABASE \`${name}\``).catch(()=>undefined);await admin.end().catch(()=>undefined);throw error;}
}
