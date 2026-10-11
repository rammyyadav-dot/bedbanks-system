/** Owner-only operator tool. Never called by a controller or application startup. */
import { PrismaClient } from '@prisma/client'
import { checkTarget } from './provision-hold-expiry-role.cli'
import { provisionTenantControlRole } from './tenant-control-role'
async function main() {
  const url=process.env.PROVISION_DATABASE_URL,password=process.env.TENANT_CONTROL_ROLE_PASSWORD
  if(!url||!password)throw new Error('PROVISION_DATABASE_URL and TENANT_CONTROL_ROLE_PASSWORD are required')
  const target=checkTarget(url,process.argv.slice(2))
  const db=new PrismaClient({datasourceUrl:url})
  try{await provisionTenantControlRole(db,password);console.log(`Provisioned restricted tenant control login on ${target.database}. Store TENANT_CONTROL_DATABASE_URL separately from the API credential.`)}finally{await db.$disconnect()}
}
if(require.main===module)main().catch(()=>{console.error('Tenant control provisioning failed; no credentials printed.');process.exitCode=1})
