locals {
  name = "fbeds-${var.environment}"
  azs  = slice(data.aws_availability_zones.this.names, 0, var.az_count)

  # The four Next.js apps. `host` is the public name; `check` is a public, unauthenticated path for the load balancer.
  portals = {
    website  = { host = var.environment == "production" ? "www.${var.domain_name}" : "www.${var.environment}.${var.domain_name}", check = "/", priority = 40 }
    agent    = { host = var.environment == "production" ? "agent.${var.domain_name}" : "agent.${var.environment}.${var.domain_name}", check = "/login", priority = 10 }
    admin    = { host = var.environment == "production" ? "admin.${var.domain_name}" : "admin.${var.environment}.${var.domain_name}", check = "/login", priority = 20 }
    supplier = { host = var.environment == "production" ? "supplier.${var.domain_name}" : "supplier.${var.environment}.${var.domain_name}", check = "/login", priority = 30 }
  }
  api_host = "api.internal.${var.environment}.${var.domain_name}"
  services = merge({ api = { port = 3002 } }, { for k, _ in local.portals : k => { port = 3000 } })
}

data "aws_availability_zones" "this" { state = "available" }
data "aws_caller_identity" "this" {}
