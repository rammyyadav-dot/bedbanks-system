import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTarget, checkHistory, pending, releaseSha } from './clone-certification-guard.mjs'

const now = Date.parse('2026-09-27T12:00:00Z')
const target = {releaseSha, branchId:'br-test-clone', parentBranchId:'br-test-parent', branchName:'cert-prod-schema-compat-test', primary:false, default:false, hostname:'ep-test-clone.c-10.us-east-1.aws.neon.tech', productionHostnames:['ep-test-production.c-10.us-east-1.aws.neon.tech'], database:'neondb', role:'clone_runner', verifiedAt:new Date(now).toISOString(), expectedLegacyRates:13}
const url = 'postgresql://clone_runner:example@ep-test-clone.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require'
test('accepts a fresh explicitly verified clone configuration', () => assert.equal(validateTarget(url, JSON.stringify(target), now).branchId, target.branchId))
test('rejects production identity, endpoint substitutions and pooled endpoint', () => {
  for (const change of [{primary:true},{default:true},{branchId:target.parentBranchId},{hostname:target.productionHostnames[0]},{hostname:target.hostname.replace('.', '-pooler.')}]) assert.throws(() => validateTarget(url,JSON.stringify({...target,...change}),now))
  assert.throws(() => validateTarget(url.replace(target.hostname,target.productionHostnames[0]),JSON.stringify(target),now))
})
test('rejects alternate routing, schema and disabled TLS', () => {
  for (const candidate of [url+'&host=localhost',url+'&options=unsafe',url+'&schema=other',url.replace('require','disable'),url+'&sslmode=disable']) assert.throws(() => validateTarget(candidate,JSON.stringify(target),now))
})
test('rejects missing secrets, wrong release and stale or future metadata', () => {
  assert.throws(() => validateTarget('', '', now))
  for (const change of [{releaseSha:'bad'},{verifiedAt:'2020-01-01'},{verifiedAt:new Date(now+1000).toISOString()}]) assert.throws(() => validateTarget(url,JSON.stringify({...target,...change}),now))
})
const migrations = [...Array.from({length:12},(_,i)=>`baseline-${i}`),...pending].map(name=>({name,checksum:`checksum-${name}`}))
const rows = migrations.slice(0,12).map(m=>({migration_name:m.name,checksum:m.checksum,finished_at:'date',rolled_back_at:null,applied_steps_count:1}))
test('accepts exact baseline and preserves rolled-back historical attempts',()=>checkHistory([...rows,{...rows[0],checksum:'old',finished_at:null,rolled_back_at:'date'}],migrations))
test('rejects unresolved failures, missing history and checksum mismatches',()=>{
  for(const candidate of [rows.slice(1),[...rows,{...rows[0],finished_at:null}],rows.map((r,i)=>i? r:{...r,checksum:'wrong'})]) assert.throws(()=>checkHistory(candidate,migrations))
})
test('rejects partially migrated clones',()=>assert.throws(()=>checkHistory([...rows,{migration_name:pending[0],finished_at:'date',checksum:migrations[12].checksum,applied_steps_count:1}],migrations)))
