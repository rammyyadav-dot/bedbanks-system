// Run only from an approved runner. Never log connection strings or database rows.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { validateTarget, inventory, checkHistory, requireCheck, pending, releaseSha } from './clone-certification-guard.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = { releaseSha, startedAt: new Date().toISOString(), steps: [], verdict: 'BLOCKED', productionAuthorization: false }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
let db
function command(label, args, { clone = false, allowPending = false } = {}) {
  const startedAt = new Date().toISOString()
  // Pass a minimal environment. No production/supplier credentials are inherited.
  const env = Object.fromEntries(['PATH','HOME','CI','PNPM_HOME','COREPACK_HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
  Object.assign(env, { NODE_ENV: 'test', DATABASE_URL: clone ? process.env.FBEDS_CERT_CLONE_DATABASE_URL : 'postgresql://invalid:invalid@localhost:5432/invalid', NEXT_TELEMETRY_DISABLED: '1', TURBO_TELEMETRY_DISABLED: '1' })
  if (clone && process.env.REDIS_URL) env.REDIS_URL = process.env.REDIS_URL
  const result = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64*1024*1024, timeout: 15*60*1000 })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const row = { label, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status }
  // Whitelist aggregate test results; never emit raw Prisma/Jest error payloads.
  row.testSummary = output.split('\n').filter(line=>/^(Test Suites:|Tests:|Snapshots:)/.test(line)).map(line=>line.replace(/\x1b\[[0-9;]*m/g,''))
  evidence.steps.push(row)
  console.log(JSON.stringify(row))
  const expectedPending = allowPending && result.status === 1 && /have not yet been applied/.test(output) && pending.every(name=>output.includes(name)) && !/P\d{4}/.test(output)
  requireCheck(result.status === 0 || expectedPending, 'COMMAND_FAILED')
}
const prisma = (label, script, options = {}) => command(label, ['--filter','@bedbanks/api',script], {clone:true,...options})
const history = () => db.$queryRawUnsafe('SELECT id,migration_name,checksum,started_at,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY started_at,id')
async function fingerprints() {
  const rates = await db.$queryRawUnsafe(`SELECT id,md5((to_jsonb(r)-'amount_basis')::text) AS digest FROM "DailyRate" r ORDER BY id`)
  const availability = await db.$queryRawUnsafe(`SELECT id,md5((to_jsonb(a)-'held')::text) AS digest FROM "DailyAvailability" a ORDER BY id`)
  return {rates,availability}
}
async function preserved(before) {
  const after = await fingerprints()
  for(const table of ['rates','availability']) {
    const map = new Map(after[table].map(row=>[row.id,row.digest]))
    requireCheck(before[table].every(row=>map.get(row.id)===row.digest), 'LEGACY_ROWS_CHANGED')
  }
  const classified = await db.dailyRate.count({where:{id:{in:before.rates.map(row=>row.id)},amountBasis:{not:null}}})
  requireCheck(classified===0,'LEGACY_RATES_CLASSIFIED')
  const held = await db.dailyAvailability.count({where:{id:{in:before.availability.map(row=>row.id)},held:{not:0}}})
  requireCheck(held===0,'LEGACY_AVAILABILITY_HELD_CHANGED')
}
async function assertSchema() {
  const tables = await db.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname IN ('SupplierRoomMapping','InventoryHold','InventoryHoldNight')`)
  requireCheck(tables.length===3 && tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity),'RLS_FLAGS_MISSING')
  const policies = await db.$queryRawUnsafe(`SELECT tablename,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('SupplierRoomMapping','InventoryHold','InventoryHoldNight')`)
  requireCheck(policies.length===3 && policies.every(p=>p.qual?.includes('tenant_id = fbeds_current_tenant_id()') && p.with_check?.includes('tenant_id = fbeds_current_tenant_id()')),'TENANT_POLICIES_MISSING')
  const columns = await db.$queryRawUnsafe(`SELECT table_name,column_name,is_nullable,column_default,udt_name FROM information_schema.columns WHERE table_schema='public' AND ((table_name='DailyAvailability' AND column_name='held') OR (table_name='DailyRate' AND column_name='amount_basis'))`)
  requireCheck(columns.some(c=>c.column_name==='held'&&c.udt_name==='int4'&&c.is_nullable==='NO'&&c.column_default==='0'),'HELD_COLUMN_INVALID')
  requireCheck(columns.some(c=>c.column_name==='amount_basis'&&c.udt_name==='RateAmountBasis'&&c.is_nullable==='YES'&&c.column_default===null),'AMOUNT_BASIS_INVALID')
  const checks = await db.$queryRawUnsafe(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace`)
  const check = name => checks.find(c=>c.conname===name)?.definition || ''
  requireCheck(check('DailyAvailability_inventory_check').includes('(sold + held) <= allotment')&&check('DailyAvailability_inventory_check').includes('held >= 0'),'INVENTORY_CHECK_INVALID')
  requireCheck(check('SupplierRoomMapping_supplier_room_id_nonblank').includes('btrim(supplier_room_id)'),'ROOM_ID_CHECK_MISSING')
  requireCheck(check('SupplierRoomMapping_confidence_check').includes('confidence >= 0')&&check('SupplierRoomMapping_confidence_check').includes('confidence <= 100'),'CONFIDENCE_CHECK_MISSING')
  // Exact names are committed contracts; schema drift additionally validates modeled definitions.
  const fks = ['SupplierRoomMapping_tenant_id_supplier_hotel_mapping_id_ho_fkey','SupplierRoomMapping_hotel_id_room_type_id_fkey','InventoryHoldNight_tenant_id_hold_id_fkey','InventoryHoldNight_tenant_id_availability_id_fkey']
  requireCheck(fks.every(name=>check(name).startsWith('FOREIGN KEY')),'TENANT_FOREIGN_KEYS_MISSING')
  const indexes = await db.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)
  const requiredIndexes = ['SupplierRoomMapping_supplier_hotel_mapping_id_supplier_room_key','SupplierRoomMapping_tenant_id_status_idx','SupplierRoomMapping_hotel_id_room_type_id_idx','InventoryHold_tenant_id_idempotency_key_key','InventoryHold_tenant_id_status_expires_at_idx','InventoryHoldNight_tenant_id_stay_date_idx','DailyRate_tenant_id_amount_basis_stay_date_idx']
  requireCheck(requiredIndexes.every(name=>indexes.some(i=>i.indexname===name)),'INDEXES_MISSING')
  const enums=await db.$queryRawUnsafe(`SELECT t.typname,e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typnamespace='public'::regnamespace AND t.typname IN ('RateAmountBasis','InventoryHoldStatus') ORDER BY t.typname,e.enumsortorder`)
  requireCheck(JSON.stringify(enums.filter(e=>e.typname==='RateAmountBasis').map(e=>e.enumlabel))===JSON.stringify(['NET','SELL']),'RATE_ENUM_INVALID')
  requireCheck(JSON.stringify(enums.filter(e=>e.typname==='InventoryHoldStatus').map(e=>e.enumlabel))===JSON.stringify(['PENDING_RECHECK','RECHECKED','HOLD_PENDING','HELD','RELEASED','EXPIRED','FAILED']),'HOLD_ENUM_INVALID')
  requireCheck(await db.permission.count({where:{key:{in:['supply.suppliers.read','supply.suppliers.manage']}}})===2,'SUPPLIER_PERMISSIONS_MISSING')
  requireCheck(await db.platformPermission.count({where:{key:{in:['platform.roles.read','platform.roles.manage','platform.assignments.read','platform.assignments.manage']}}})===4,'PLATFORM_PERMISSIONS_MISSING')
  const missingBindings = await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "PlatformRolePermission" rp JOIN "PlatformPermission" old ON old.id=rp.permission_id CROSS JOIN (VALUES ('platform.access.read','platform.roles.read'),('platform.access.read','platform.assignments.read'),('platform.access.manage','platform.roles.manage'),('platform.access.manage','platform.assignments.manage')) AS expected(old_key,new_key) JOIN "PlatformPermission" replacement ON replacement.key=expected.new_key WHERE old.key=expected.old_key AND NOT EXISTS (SELECT 1 FROM "PlatformRolePermission" actual WHERE actual.role_id=rp.role_id AND actual.permission_id=replacement.id)`)
  requireCheck(missingBindings[0].count===0,'ROLE_BINDINGS_MISSING')
}
async function main() {
  const target = validateTarget(process.env.FBEDS_CERT_CLONE_DATABASE_URL,process.env.FBEDS_CERT_CLONE_TARGET_JSON)
  requireCheck(process.env.FBEDS_CERT_ALLOW_CLONE_WRITE==='yes','CLONE_WRITE_NOT_APPROVED')
  const migrationDir = `${root}/apps/api/prisma/migrations`
  const migrations = inventory(migrationDir)
  for(const m of migrations) {
    const committed = execFileSync('git',['show',`${releaseSha}:apps/api/prisma/migrations/${m.name}/migration.sql`],{cwd:root,stdio:['ignore','pipe','pipe']})
    requireCheck(sha256(committed)===m.checksum,'COMMITTED_MIGRATION_CHANGED')
  }
  requireCheck(execFileSync('git',['diff','--name-only',releaseSha,'--','apps','packages','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','turbo.json'],{cwd:root,encoding:'utf8'}).trim()==='', 'APPLICATION_BASELINE_CHANGED')
  evidence.migrations=migrations
  evidence.targetVerification='owner-attested clone metadata; exact direct endpoint match; no production credentials supplied'
  // Generation/validation cannot write the database; no raw CLI output is emitted.
  prisma('validate','prisma:validate')
  prisma('generate','prisma:generate')
  const {PrismaClient}=await import('@prisma/client')
  db=new PrismaClient({datasources:{db:{url:process.env.FBEDS_CERT_CLONE_DATABASE_URL}}})
  await db.$connect()
  const beforeHistory=await history()
  checkHistory(beforeHistory,migrations)
  const objects = await db.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND ((table_name='DailyAvailability' AND column_name='held') OR (table_name='DailyRate' AND column_name='amount_basis'))) AS columns,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname IN ('SupplierRoomMapping','InventoryHold','InventoryHoldNight')) AS tables,(SELECT count(*)::int FROM pg_type WHERE typnamespace='public'::regnamespace AND typname IN ('InventoryHoldStatus','RateAmountBasis')) AS enums`)
  requireCheck(Object.values(objects[0]).every(n=>n===0),'CLONE_SCHEMA_ALREADY_TOUCHED')
  const partial = await db.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM "PlatformPermission" WHERE key IN ('platform.roles.read','platform.roles.manage','platform.assignments.read','platform.assignments.manage')) AS platform_permissions,(SELECT count(*)::int FROM "Permission" WHERE key IN ('supply.suppliers.read','supply.suppliers.manage','supply.mappings.read','supply.mappings.manage')) AS supplier_permissions,(SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname IN ('Supplier_tenant_id_id_key','Hotel_tenant_id_id_key','RoomType_hotel_id_id_key','SupplierHotelMapping_tenant_id_id_hotel_id_key','DailyAvailability_tenant_id_id_key','DailyRate_tenant_id_amount_basis_stay_date_idx')) AS indexes,(SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname IN ('SupplierHotelMapping_supplier_hotel_id_nonblank','SupplierHotelMapping_tenant_id_supplier_id_fkey','SupplierHotelMapping_tenant_id_hotel_id_fkey')) AS constraints`)
  requireCheck(Object.values(partial[0]).every(n=>n===0),'CLONE_SCHEMA_ALREADY_TOUCHED')
  const invalid = await db.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM "SupplierHotelMapping" m LEFT JOIN "Supplier" s ON s.id=m.supplier_id LEFT JOIN "Hotel" h ON h.id=m.hotel_id WHERE s.id IS NULL OR h.id IS NULL OR m.tenant_id IS DISTINCT FROM s.tenant_id OR m.tenant_id IS DISTINCT FROM h.tenant_id OR m.supplier_hotel_id IS NULL OR btrim(m.supplier_hotel_id)='' OR m.status::text NOT IN ('PENDING','MAPPED','REJECTED')) AS mappings,(SELECT count(*)::int FROM (SELECT supplier_id,supplier_hotel_id FROM "SupplierHotelMapping" GROUP BY 1,2 HAVING count(*)>1) t) AS external_duplicates,(SELECT count(*)::int FROM (SELECT supplier_id,hotel_id FROM "SupplierHotelMapping" GROUP BY 1,2 HAVING count(*)>1) t) AS hotel_duplicates,(SELECT count(*)::int FROM "DailyAvailability" WHERE allotment<0 OR sold<0 OR sold>allotment OR min_stay<=0) AS availability`)
  requireCheck(Object.values(invalid[0]).every(n=>n===0),'PREFLIGHT_VIOLATION')
  // Model selects require newer columns, so fingerprint through raw read-only SQL first.
  const before=await fingerprints()
  requireCheck(before.rates.length===target.expectedLegacyRates,'PREFLIGHT_DATA_CHANGED')
  prisma('status-before','prisma:migrate:status',{allowPending:true})
  prisma('deploy-clone','prisma:migrate:deploy')
  const afterHistory=await history()
  checkHistory(afterHistory,migrations,true)
  requireCheck(JSON.stringify(afterHistory.filter(r=>beforeHistory.some(b=>b.id===r.id)))===JSON.stringify(beforeHistory),'HISTORICAL_ROWS_CHANGED')
  requireCheck(afterHistory.length===beforeHistory.length+5,'UNEXPECTED_HISTORY_ADDITIONS')
  prisma('status-after','prisma:migrate:status')
  prisma('schema-drift','prisma:migrate:drift')
  await assertSchema()
  await preserved(before)
  evidence.schemaAssertions='PASS'
  evidence.legacyPreservation='PASS'
  // All API E2E suites run against this disposable clone, including RLS and Dubai scale.
  // They create synthetic fixtures and grant the existing NOLOGIN test role on this clone.
  command('API-E2E',['--filter','@bedbanks/api','test:e2e'],{clone:true})
  await preserved(before)
  prisma('drift-after-E2E','prisma:migrate:drift')
  command('schema-guard',['check:schema'])
  command('type-check',['type-check'])
  command('lint',['lint'])
  command('API-unit',['--filter','@bedbanks/api','test:unit'])
  command('Admin-auth',['--filter','@bedbanks/api','test:auth:admin'])
  command('build',['build'])
  evidence.verdict='CLONE_CHECKS_PASSED_REQUIRES_OWNER_REVIEW'
  evidence.unresolved=['production HTTP role','backup/PITR and tested recovery','human approval and maintenance window','authenticated production smoke test']
}
try { await main() } catch(error) {
  // Error messages from database drivers may include credentials or source data.
  const safeCodes=new Set(['CLONE_SECRETS_MISSING','CLONE_CONFIG_INVALID','RELEASE_SHA_MISMATCH','BRANCH_ID_INVALID','TARGET_NOT_DISPOSABLE_CLONE','DIRECT_ENDPOINT_REQUIRED','PRODUCTION_DENYLIST_REQUIRED','PRODUCTION_TARGET_REJECTED','CONNECTION_TARGET_MISMATCH','DATABASE_OR_ROLE_MISMATCH','CONNECTION_OPTIONS_REJECTED','TLS_OR_SCHEMA_REJECTED','TARGET_VERIFICATION_EXPIRED','PREFLIGHT_COUNT_REQUIRED','CLONE_WRITE_NOT_APPROVED','COMMITTED_MIGRATION_CHANGED','APPLICATION_BASELINE_CHANGED','COMMAND_FAILED','MIGRATION_CHAIN_CHANGED','UNKNOWN_HISTORY','UNRESOLVED_MIGRATION','UNEXPECTED_HISTORY_COUNT','HISTORY_CHECKSUM_OR_STEPS_MISMATCH','CLONE_ALREADY_TOUCHED','CLONE_SCHEMA_ALREADY_TOUCHED','PREFLIGHT_VIOLATION','PREFLIGHT_DATA_CHANGED','HISTORICAL_ROWS_CHANGED','UNEXPECTED_HISTORY_ADDITIONS','LEGACY_ROWS_CHANGED','LEGACY_RATES_CLASSIFIED','LEGACY_AVAILABILITY_HELD_CHANGED'])
  evidence.error=safeCodes.has(error?.message)?error.message:'DATABASE_OR_SCHEMA_CHECK_FAILED'
  console.error(evidence.error)
  process.exitCode=1
} finally {
  await db?.$disconnect().catch(()=>{})
  evidence.finishedAt=new Date().toISOString()
  mkdirSync(`${root}/clone-certification-evidence`,{recursive:true})
  writeFileSync(`${root}/clone-certification-evidence/result.json`,JSON.stringify(evidence,null,2)+'\n')
  console.log(`Certification result: ${evidence.verdict}; production authorization: false`)
}
