resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "this" { vpc_id = aws_vpc.this.id }

# Three tiers: public (load balancer, NAT), private (tasks), data (RDS, Redis; no route to the internet).
resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${count.index}" }
}
resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 4 + count.index)
  tags              = { Name = "${local.name}-private-${count.index}" }
}
resource "aws_subnet" "data" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 8 + count.index)
  tags              = { Name = "${local.name}-data-${count.index}" }
}

resource "aws_eip" "nat" {
  count  = var.nat_per_az ? var.az_count : 1
  domain = "vpc"
}
resource "aws_nat_gateway" "this" {
  count         = var.nat_per_az ? var.az_count : 1
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}
resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.nat_per_az ? count.index : 0].id
  }
}
resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
resource "aws_route_table" "data" { vpc_id = aws_vpc.this.id }
resource "aws_route_table_association" "data" {
  count          = var.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# Gateway endpoint for S3 (ECR layers) so image pulls do not cross the NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
}

# ---- security groups: each hop only from the one before it ----
# Groups are empty and every rule is a standalone resource: inline rules that reference each other create dependency cycles
# (alb_public <-> portal, alb_internal <-> api <-> data), which terraform validate rejects.
locals {
  security_groups = {
    alb_public   = "alb-public"
    portal       = "portal"
    alb_internal = "alb-internal"
    api          = "api"
    data         = "data"
    compliance   = "compliance" # scheduled compliance export/verify tasks (compliance.tf): Postgres and HTTPS only, no ingress
  }
  # Rules between two groups: from -> to on a TCP port.
  sg_links = {
    alb_public_to_portal   = { from = "alb_public", to = "portal", port = 3000 }
    portal_to_alb_internal = { from = "portal", to = "alb_internal", port = 443 }
    alb_internal_to_api    = { from = "alb_internal", to = "api", port = 3002 }
    api_to_data_postgres   = { from = "api", to = "data", port = 5432 }
    api_to_data_redis      = { from = "api", to = "data", port = 6379 }
    compliance_to_data     = { from = "compliance", to = "data", port = 5432 }
  }
  # Ingress to the public ALB: one rule per (CIDR, port). Staging must not be 0.0.0.0/0 (ADR 0055; enforced by a precondition below).
  # With CloudFront the world-facing rules disappear: the ALB admits only the CloudFront origin-facing prefix list on 443 (edge.tf).
  public_ingress = var.cloudfront_enabled ? {} : { for pair in setproduct(var.public_ingress_cidrs, [443, 80]) : "${pair[0]}-${pair[1]}" => { cidr = pair[0], port = pair[1] } }
}
resource "aws_security_group" "this" {
  for_each    = local.security_groups
  name_prefix = "${local.name}-${each.value}-"
  description = "${local.name} ${each.value}"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${local.name}-${each.value}" }
  lifecycle { create_before_destroy = true }
}
resource "aws_vpc_security_group_ingress_rule" "link" {
  for_each                     = local.sg_links
  security_group_id            = aws_security_group.this[each.value.to].id
  referenced_security_group_id = aws_security_group.this[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "${each.value.from} to ${each.value.to}"
}
resource "aws_vpc_security_group_egress_rule" "link" {
  for_each                     = local.sg_links
  security_group_id            = aws_security_group.this[each.value.from].id
  referenced_security_group_id = aws_security_group.this[each.value.to].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "${each.value.from} to ${each.value.to}"
}
resource "aws_vpc_security_group_ingress_rule" "public" {
  for_each          = local.public_ingress
  security_group_id = aws_security_group.this["alb_public"].id
  cidr_ipv4         = each.value.cidr
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  description       = each.value.port == 80 ? "redirect to 443 only" : "HTTPS"
}
# Tasks reach ECR, CloudWatch, Secrets Manager (via NAT), the internal API ALB (portal), suppliers (api) and KMS (compliance) over HTTPS only.
# The compliance archive itself is reached through the S3 gateway endpoint.
resource "aws_vpc_security_group_egress_rule" "https_out" {
  for_each          = toset(["portal", "api", "compliance"])
  security_group_id = aws_security_group.this[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to AWS APIs and, for the api, suppliers"
}

# The VPC's default security group admits all traffic from its own members. Strip it so nothing can be attached to it by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.name}-default-deny" }
}

# CloudFront -> ALB: HTTPS only, from the CloudFront origin-facing prefix list (shared by all CloudFront customers: the X-Origin-Verify listener
# condition is what distinguishes our distributions). Note the prefix list consumes ~55 rules of the security group quota (default 60 per direction).
resource "aws_vpc_security_group_ingress_rule" "cloudfront_origin" {
  count             = var.cloudfront_enabled ? 1 : 0
  security_group_id = aws_security_group.this["alb_public"].id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from CloudFront origin-facing addresses"
}
