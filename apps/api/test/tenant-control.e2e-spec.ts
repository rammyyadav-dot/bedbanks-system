/** All HTTP requests use restricted credentials; only fixtures use the disposable owner. */
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { tenantControlPermissions, type TenantBusiness } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { TenantControlDatabase } from '../src/platform-admin/tenant-control.database'

const password = 'disposable-tenant-certification-2026'
const suffix = `${Date.now()}`
const business: TenantBusiness = { name: 'fBeds Control Fixture', classification: 'BUYER', country: 'AE', address: 'Fixture address', city: 'Dubai', businessEmail: 'business@example.test', registrationNumber: `REG-${suffix}`, currency: 'USD', markets: ['AE'], channels: ['B2B'], financeReviewed: true }
const strictSuite = process.env.TEST_OWNER_DATABASE_URL && process.env.TENANT_CONTROL_DATABASE_URL ? describe : describe.skip
strictSuite('Tenant control: strict-role HTTP and isolation certification', () => {
  const owner = new PrismaClient({ datasourceUrl: process.env.TEST_OWNER_DATABASE_URL })
  let app: INestApplication, maker: string, checker: string, tenantUser: string, tenantA: string, tenantB: string, created: string, makerId: string, checkerId: string, adminEmail: string
  const url = (tail = '') => `/api/v1/platform/tenants${tail}`
  const post = (cookie: string, tail: string, payload: object, key = `test-key-${Date.now()}-${Math.random()}`) => request(app.getHttpServer()).post(url(tail)).set('Cookie',cookie).set('Origin','http://localhost:3001').set('Idempotency-Key',key).send(payload)
  beforeAll(async () => {
    if (!process.env.TEST_OWNER_DATABASE_URL || new URL(process.env.TEST_OWNER_DATABASE_URL).pathname !== '/fbeds_ci') throw new Error('Disposable test owner is required')
    const passwordHash=await hashPassword(password)
    const users = await Promise.all(['maker','checker','admin'].map(name=>owner.user.create({data:{email:`${name}-${suffix}@example.test`,name,passwordHash,lastLoginAt:new Date()}})))
    makerId=users[0].id;checkerId=users[1].id;adminEmail=users[2].email
    const tenants=await Promise.all(['a','b'].map(name=>owner.tenant.create({data:{name:`Isolation ${name} ${suffix}`,slug:`isolation-${name}-${suffix}`}})))
    tenantA=tenants[0].id;tenantB=tenants[1].id
    for(const [index,tenant] of tenants.entries()) {
      await owner.tenantControlProfile.create({data:{tenantId:tenant.id,business:{...business,registrationNumber:`REG-${suffix}-${index}`},registrationKey:`AE:REG${suffix}${index}`,country:'AE',classification:'BUYER',updatedBy:makerId}})
      await owner.membership.create({data:{tenantId:tenant.id,userId:users[2].id,role:index===0?'owner':'member'}})
    }
    for(const user of users.slice(0,2)) {
      const role=await owner.platformRole.create({data:{id:`control-${user.id}`,name:`control-${user.id}`}})
      for(const key of tenantControlPermissions) {
        const perm=await owner.platformPermission.upsert({where:{key},update:{},create:{id:key,key}})
        await owner.platformRolePermission.create({data:{roleId:role.id,permissionId:perm.id}})
      }
      await owner.platformRoleAssignment.create({data:{userId:user.id,roleId:role.id}})
    }
    const module=await Test.createTestingModule({imports:[AppModule]}).compile()
    app=module.createNestApplication();app.use(cookieParser());app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}))
    app.useGlobalFilters(new HttpExceptionFilter());app.useGlobalInterceptors(new ResponseInterceptor());await app.init()
    const login=async(email:string)=>{const r=await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin','http://localhost:3001').send({email,password}).expect(200);return r.headers['set-cookie'][0].split(';')[0]}
    maker=await login(users[0].email);checker=await login(users[1].email);tenantUser=await login(users[2].email)
  },30000)
  afterAll(async()=>{await app?.close();await owner.$disconnect()})
  it('verifies the actual strict API role and unchanged grant contract',async()=>{const runtime=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});try{expect(await verifyApiRuntimeRole(runtime)).toEqual({ok:true,failures:[]})}finally{await runtime.$disconnect()}})
  it('denies protected finance, booking and credential reads to the authoring role',async()=>{
    const authoring=new PrismaClient({datasourceUrl:process.env.TENANT_CONTROL_DATABASE_URL})
    try {
      const [grants]=await authoring.$queryRaw<Array<{wallet:boolean;ledger:boolean;booking:boolean;credentials:boolean}>>`SELECT has_table_privilege(current_user, '"Wallet"', 'SELECT,INSERT,UPDATE,DELETE') AS wallet, has_table_privilege(current_user, '"LedgerEntry"', 'SELECT,INSERT,UPDATE,DELETE') AS ledger, has_table_privilege(current_user, '"Booking"', 'SELECT,INSERT,UPDATE,DELETE') AS booking, has_column_privilege(current_user, 'users', 'password_hash', 'SELECT') AS credentials`
      expect(grants).toEqual({wallet:false,ledger:false,booking:false,credentials:false})
    }finally{await authoring.$disconnect()}
  })
  it('rejects unauthenticated and tenant-owner access to the platform',async()=>{await request(app.getHttpServer()).get(url()).expect(401);await request(app.getHttpServer()).get(url()).set('Cookie',tenantUser).expect(403)})
  it('serves real paginated, filtered metrics without financial or identity secrets',async()=>{const r=await request(app.getHttpServer()).get(`${url()}?search=isolation-a-${suffix}&pageSize=1`).set('Cookie',maker).expect(200);expect(r.body.data.items).toHaveLength(1);expect(r.body.data.items[0].id).toBe(tenantA);expect(r.body.data.metrics.total).toBeGreaterThanOrEqual(2);expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|taxNumber|registrationNumber/)})
  it('rejects invalid query values and forged privilege headers',async()=>{await request(app.getHttpServer()).get(`${url()}?pageSize=200`).set('Cookie',maker).expect(400);await request(app.getHttpServer()).get(url()).set('Cookie',tenantUser).set('x-platform-permission','platform.tenants.read').expect(403)})
  it('enforces forced RLS across tenants and clears reused connections',async()=>{const db=app.get(TenantControlDatabase);expect(await db.withTenant(tenantA,tx=>tx.tenantControlProfile.findMany())).toHaveLength(1);expect(await db.withTenant(tenantB,tx=>tx.tenantControlProfile.findMany())).toHaveLength(1);expect(await db.withPlatformTenant(makerId,tenantA,tx=>tx.tenantControlProfile.findUnique({where:{tenantId:tenantB}}))).toBeNull();expect(await db.withTenant(tenantA,tx=>tx.membership.findMany({where:{tenantId:tenantB}}))).toHaveLength(0);expect(await db.withTenant(tenantA,tx=>tx.tenant.updateMany({where:{id:tenantB},data:{name:'Leaked'}}))).toEqual({count:0})})
  it('requires explicit settings context and checks the chosen tenant permission',async()=>{await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie',tenantUser).expect(403);const a=await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie',tenantUser).set('x-fbeds-tenant-id',tenantA).expect(200);expect(a.body.data.tenantId).toBe(tenantA);await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie',tenantUser).set('x-fbeds-tenant-id',tenantB).expect(403);await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie',tenantUser).set('x-fbeds-tenant-id','forged').expect(403)})
  it('updates settings under the authoring role and detects idempotency key reuse',async()=>{const payload={name:'Settings fixture',supportEmail:'ops@example.test',defaultLanguage:'en',timeZone:'UTC',defaultCurrency:'USD',lowBalanceThreshold:{amountMinor:'10000',currency:'USD'}};const patch=(body:object,key:string)=>request(app.getHttpServer()).patch('/api/v1/admin/settings').set('Cookie',tenantUser).set('Origin','http://localhost:3001').set('x-fbeds-tenant-id',tenantA).set('Idempotency-Key',key).send(body);await patch(payload,'settings-key-001').expect(200);await patch(payload,'settings-key-001').expect(200);await patch({...payload,name:'Conflicting'},'settings-key-001').expect(409);expect(await owner.auditEvent.count({where:{tenantId:tenantA,action:'settings.updated'}})).toBe(1)})
  it('validates creation, rejects self-ownership, and requires idempotency',async()=>{await post(maker,'',{}).expect(400);await request(app.getHttpServer()).post(url()).set('Cookie',maker).set('Origin','http://localhost:3001').send({slug:`test-${suffix}`,business,administratorEmail:adminEmail}).expect(400);const self=await owner.user.findUniqueOrThrow({where:{id:makerId}});await post(maker,'',{slug:`self-${suffix}`,business,administratorEmail:self.email}).expect(403)})
  it('transactionally creates an inactive tenant and replays creation',async()=>{const body={slug:`created-${suffix}`,business,administratorEmail:adminEmail};const r=await post(maker,'',body,'create-key-001').expect(201);created=r.body.data.id;const repeat=await post(maker,'',body,'create-key-001').expect(201);expect(repeat.body.data.id).toBe(created);expect(await owner.tenant.findUnique({where:{id:created}})).toMatchObject({status:'SUSPENDED'});expect(await owner.membership.count({where:{tenantId:created}})).toBe(1);await post(maker,'',{...body,slug:`other-${suffix}`},'create-key-001').expect(409)})
  it('rejects duplicate slugs and duplicate legal companies',async()=>{await post(maker,'',{slug:`created-${suffix}`,business:{...business,registrationNumber:'DIFFERENT'},administratorEmail:adminEmail}).expect(409);await post(maker,'',{slug:`duplicate-${suffix}`,business,administratorEmail:adminEmail}).expect(409)})
  it('does not remove the final administrator or permit self escalation',async()=>{await post(maker,`/${created}/memberships`,{email:adminEmail,role:'revoke',version:1}).expect(409);const self=await owner.user.findUniqueOrThrow({where:{id:makerId}});await post(maker,`/${created}/memberships`,{email:self.email,role:'owner',version:1}).expect(403)})
  it('serializes concurrent profile edits with one winner and one 409',async()=>{const edit=(name:string)=>request(app.getHttpServer()).patch(url(`/${created}/profile`)).set('Cookie',maker).set('Origin','http://localhost:3001').set('Idempotency-Key',`concurrent-${name.replace(/ /g,'-')}`).send({business:{...business,name},version:1});const results=await Promise.all([edit('Winner one'),edit('Winner two')]);expect(results.map(r=>r.status).sort()).toEqual([200,409])})
  it('blocks self compliance approval and requires an independent review',async()=>{await post(maker,`/${created}/compliance`,{decision:'APPROVED',reason:'Verified identity',version:2}).expect(403);await post(checker,`/${created}/compliance`,{decision:'APPROVED',reason:'Verified identity',version:2}).expect(201)})
  it('uses canonical maker-checker approval and activates only a ready tenant',async()=>{const r=await post(maker,`/${created}/lifecycle`,{status:'ACTIVE',reason:'All readiness met',version:3},'lifecycle-key-001').expect(201);const approvalId=r.body.data.id;await post(maker,`/${created}/approvals/${approvalId}`,{decision:'APPROVED',reason:'Approve myself'}).expect(403);await post(checker,`/${created}/approvals/${approvalId}`,{decision:'APPROVED',reason:'Independent approval'}).expect(201);expect(await owner.tenant.findUnique({where:{id:created}})).toMatchObject({status:'ACTIVE'});expect(await owner.approvalRequest.findUnique({where:{id:approvalId}})).toMatchObject({status:'EXECUTED',decidedById:checkerId})})
  it('blocks activation when readiness is incomplete',async()=>{const r=await post(maker,`/${tenantB}/lifecycle`,{status:'SUSPENDED',reason:'Suspend for review',version:1}).expect(201);await post(checker,`/${tenantB}/approvals/${r.body.data.id}`,{decision:'APPROVED',reason:'Review approved'}).expect(201);const activate=await post(maker,`/${tenantB}/lifecycle`,{status:'ACTIVE',reason:'Attempt incomplete activation',version:2}).expect(201);await post(checker,`/${tenantB}/approvals/${activate.body.data.id}`,{decision:'APPROVED',reason:'Readiness still checked'}).expect(409)})
  it('lists scoped immutable audit without sensitive payloads',async()=>{const r=await request(app.getHttpServer()).get(url(`/${created}/audit?action=tenant.lifecycle`)).set('Cookie',checker).expect(200);expect(r.body.data.items).toHaveLength(1);expect(r.body.data.items[0].action).toBe('tenant.lifecycle.changed');expect(r.body.data.items[0].payload).toBeUndefined()})
  it('revokes membership access on the next authenticated request',async()=>{await owner.membership.updateMany({where:{userId:(await owner.user.findUniqueOrThrow({where:{email:adminEmail}})).id,tenantId:tenantA},data:{revokedAt:new Date()}});await request(app.getHttpServer()).get('/api/v1/admin/settings').set('Cookie',tenantUser).set('x-fbeds-tenant-id',tenantA).expect(403)})
})
