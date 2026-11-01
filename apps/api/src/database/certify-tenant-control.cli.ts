/** Isolated owner provisioning and strict-role HTTP certification. No production targets. */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { provisionApiRuntimeRole } from './api-runtime-role'
import { provisionTenantControlRole, TENANT_CONTROL_LOGIN } from './tenant-control-role'
async function main() {
  if(process.env.NODE_ENV!=='test')throw new Error('Test environment required')
  if(process.env.GITHUB_ACTIONS!=='true'&&!process.argv.includes('--disposable-local'))throw new Error('CI service or explicit disposable-local flag required')
  const target=new URL(process.env.DATABASE_URL??'')
  if(!['127.0.0.1','localhost'].includes(target.hostname)||target.pathname!=='/fbeds_ci')throw new Error('Disposable loopback fbeds_ci database required')
  const owner=new PrismaClient({datasourceUrl:target.toString()})
  try {
    const apiPassword=randomBytes(32).toString('hex'),controlPassword=randomBytes(32).toString('hex')
    await provisionApiRuntimeRole(owner,{password:apiPassword});await provisionTenantControlRole(owner,controlPassword)
    const runtime=new URL(target);runtime.username='fbeds_api_login';runtime.password=apiPassword
    const authoring=new URL(target);authoring.username=TENANT_CONTROL_LOGIN;authoring.password=controlPassword
    const result=spawnSync(process.execPath,['node_modules/jest/bin/jest.js','--config','test/jest-e2e.json','--runInBand','tenant-control.e2e-spec.ts'],{stdio:'inherit',env:{...process.env,DATABASE_URL:runtime.toString(),TENANT_CONTROL_DATABASE_URL:authoring.toString(),TEST_OWNER_DATABASE_URL:target.toString(),DB_RUNTIME_ROLE_GUARD:'enforce',ADMIN_ORIGIN:'http://localhost:3001'}})
    process.exitCode=result.status??1
  }finally{await owner.$disconnect()}
}
if(require.main===module)main().catch(()=>{console.error('Disposable tenant certification failed. No credentials printed.');process.exitCode=1})
