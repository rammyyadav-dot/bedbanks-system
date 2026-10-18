# Offline governance tests: a mocked AWS provider, `command = plan`, no credentials and no AWS API call.
# Run: terraform -chdir=infra/aws/terraform test   (after `terraform init -backend=false`)
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-south-1a", "ap-south-1b", "ap-south-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_elb_service_account" {
    defaults = { arn = "arn:aws:iam::718504428378:root" }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-0123456789abcdef0" }
  }
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { id = "00000000-0000-0000-0000-000000000001" }
  }
  mock_data "aws_cloudfront_origin_request_policy" {
    defaults = { id = "00000000-0000-0000-0000-000000000002" }
  }
  # Policy documents must be valid JSON for the mocked resources that embed them.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  region         = "ap-south-1"
  domain_name    = "example.test"
  hosted_zone_id = "Z0000000000000000000"
}

run "staging_restricted_plans" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
  }
}

run "staging_open_to_world_is_refused" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [aws_lb.public]
}

run "production_without_edge_exception_is_refused" {
  command = plan
  variables {
    environment = "production"
  }
  expect_failures = [aws_lb.public]
}

run "production_dns_without_authorization_is_refused" {
  command = plan
  variables {
    environment                   = "production"
    production_edge_exception_ref = "ADR-0055-exception-test"
    create_portal_records         = true
  }
  expect_failures = [aws_route53_record.portal]
}

run "budget_requires_recipients" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
    monthly_budget_usd   = 100
  }
  expect_failures = [aws_budgets_budget.monthly]
}

run "budget_with_recipients_plans" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
    monthly_budget_usd   = 100
    budget_emails        = ["finops@example.test"]
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1
    error_message = "budget should be planned when a ceiling and recipients are given"
  }
}

run "no_budget_by_default" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 0
    error_message = "no budget may be invented without an approved ceiling"
  }
}

# ---- WP3: logging, monitoring and secrets ----
run "logging_and_monitoring_are_on_by_default" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
  }
  assert {
    condition     = length(aws_flow_log.vpc) == 1 && aws_flow_log.vpc[0].traffic_type == "ALL"
    error_message = "VPC flow logs must be enabled for all traffic"
  }
  assert {
    condition     = aws_lb.public.access_logs[0].enabled && aws_lb.internal.access_logs[0].enabled
    error_message = "both ALBs must write access logs"
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.alb_logs.block_public_acls && aws_s3_bucket_public_access_block.alb_logs.block_public_policy && aws_s3_bucket_public_access_block.alb_logs.ignore_public_acls && aws_s3_bucket_public_access_block.alb_logs.restrict_public_buckets
    error_message = "the ALB log bucket must be fully private"
  }
  assert {
    condition     = toset(aws_db_instance.this.enabled_cloudwatch_logs_exports) == toset(["postgresql", "upgrade"]) && aws_db_instance.this.monitoring_interval == 60
    error_message = "RDS must export postgresql/upgrade logs and run Enhanced Monitoring"
  }
  assert {
    condition     = aws_db_instance.this.publicly_accessible == false && aws_db_instance.this.storage_encrypted
    error_message = "RDS must stay private and encrypted"
  }
  assert {
    condition     = aws_elasticache_replication_group.this.transit_encryption_enabled && aws_elasticache_replication_group.this.at_rest_encryption_enabled
    error_message = "Redis must be encrypted in transit and at rest"
  }
  assert {
    condition     = toset([for r in aws_wafv2_web_acl_logging_configuration.regional.redacted_fields : r.single_header[0].name]) == toset(["authorization", "cookie"])
    error_message = "WAF logs must redact the Authorization and Cookie headers"
  }
  assert {
    condition     = aws_cloudwatch_log_group.waf_regional.retention_in_days == 30 && aws_cloudwatch_log_group.rds["postgresql"].retention_in_days == 30 && aws_cloudwatch_log_group.flow[0].retention_in_days == 14
    error_message = "staging retention classes must be the interim defaults, not identical and not unlimited"
  }
  assert {
    condition     = length(aws_cloudfront_distribution.portal) == 0
    error_message = "CloudFront is off unless enabled"
  }
}

run "production_retention_is_longer_and_per_class" {
  command = plan
  variables {
    environment                   = "production"
    production_edge_exception_ref = "ADR-0055-exception-test"
  }
  assert {
    condition     = aws_cloudwatch_log_group.flow[0].retention_in_days == 90 && aws_s3_bucket_lifecycle_configuration.alb_logs.rule[0].expiration[0].days == 180
    error_message = "production retention interim defaults"
  }
}

run "retention_override_is_validated" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
    log_retention        = { app = 31, flow = 14, waf = 30, rds = 30, alb_s3 = 30 }
  }
  expect_failures = [var.log_retention]
}

run "flow_logs_can_be_switched_off_only_explicitly" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
    enable_flow_logs     = false
  }
  assert {
    condition     = length(aws_flow_log.vpc) == 0
    error_message = "flow logs off when explicitly disabled"
  }
}

# ---- WP3: CloudFront edge ----
run "production_with_cloudfront_needs_no_exception" {
  command = plan
  variables {
    environment        = "production"
    cloudfront_enabled = true
  }
  assert {
    condition     = length(aws_cloudfront_distribution.portal) == 4
    error_message = "one distribution per portal host"
  }
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : d.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && alltrue([for b in d.ordered_cache_behavior : b.viewer_protocol_policy == "redirect-to-https"])])
    error_message = "every behavior must redirect HTTP to HTTPS"
  }
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : d.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021" && alltrue([for o in d.origin : o.custom_origin_config[0].origin_protocol_policy == "https-only"])])
    error_message = "TLS 1.2+ to viewers and HTTPS-only to the origin"
  }
  # Cache-policy wiring cannot be asserted here: the mocked data sources return unknown ids, which makes such comparisons vacuously true.
  # It is verified statically (and mutation-tested) in tools/aws-governance-check.mjs.
  assert {
    condition     = aws_vpc_security_group_ingress_rule.cloudfront_origin[0].from_port == 443 && length(aws_vpc_security_group_ingress_rule.public) == 0
    error_message = "with CloudFront the ALB admits only the CloudFront prefix list on 443 and no CIDR rules"
  }
  assert {
    condition     = alltrue([for r in aws_lb_listener_rule.portal : length([for c in r.condition : c if length(c.http_header) > 0]) == 1])
    error_message = "every portal listener rule must also require the origin-verification header"
  }
  assert {
    condition     = length(aws_wafv2_web_acl.edge) == 1 && aws_wafv2_web_acl.edge[0].scope == "CLOUDFRONT" && length(aws_wafv2_web_acl_logging_configuration.edge) == 1
    error_message = "a CLOUDFRONT web ACL with logging must front the distributions"
  }
}

run "staging_cloudfront_is_allow_listed_at_the_edge" {
  command = plan
  variables {
    environment          = "staging"
    cloudfront_enabled   = true
    public_ingress_cidrs = ["203.0.113.0/24"]
  }
  assert {
    condition     = length(aws_wafv2_ip_set.staging_allow) == 1 && aws_wafv2_ip_set.staging_allow[0].addresses == toset(["203.0.113.0/24"])
    error_message = "staging edge must carry the IP allow-list"
  }
}

run "staging_cloudfront_open_to_world_is_still_refused" {
  command = plan
  variables {
    environment          = "staging"
    cloudfront_enabled   = true
    public_ingress_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [aws_lb.public]
}

run "origin_verify_slot_must_be_a_or_b" {
  command = plan
  variables {
    environment               = "staging"
    public_ingress_cidrs      = ["203.0.113.0/24"]
    origin_verify_active_slot = "c"
  }
  expect_failures = [var.origin_verify_active_slot]
}

run "cloudfront_price_class_is_validated" {
  command = plan
  variables {
    environment            = "staging"
    public_ingress_cidrs   = ["203.0.113.0/24"]
    cloudfront_price_class = "PriceClass_Free"
  }
  expect_failures = [var.cloudfront_price_class]
}

run "empty_cost_tag_is_refused" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
    cost_owner           = " "
  }
  expect_failures = [var.cost_owner]
}

# ---- Compliance export (ADR 0067 amendment 2) ----
run "compliance_export_is_off_by_default" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
  }
  assert {
    condition     = length(aws_s3_bucket.compliance) == 0 && length(aws_ecs_task_definition.compliance) == 0 && length(aws_scheduler_schedule.compliance) == 0
    error_message = "Compliance export must not be created unless compliance_export_enabled is set."
  }
}

run "compliance_export_is_worm_least_privilege_and_monitored" {
  command = plan
  variables {
    environment               = "staging"
    public_ingress_cidrs      = ["203.0.113.0/24"]
    compliance_export_enabled = true
  }
  assert {
    condition     = aws_s3_bucket.compliance["enabled"].object_lock_enabled == true
    error_message = "The compliance archive must be created with Object Lock."
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.compliance["enabled"].rule).default_retention[0].mode == "COMPLIANCE" && one(aws_s3_bucket_object_lock_configuration.compliance["enabled"].rule).default_retention[0].days == 2557
    error_message = "Default retention must be COMPLIANCE mode for seven years."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.compliance_task["enabled"].statement : alltrue([for a in s.actions : !strcontains(lower(a), "delete") && !strcontains(a, "*") && !strcontains(a, "Bypass")])])
    error_message = "The compliance task role must not delete, bypass retention or use wildcard actions."
  }
  assert {
    condition     = contains([for s in data.aws_iam_policy_document.compliance_bucket["enabled"].statement : s.sid], "DenyDelete") && contains([for s in data.aws_iam_policy_document.compliance_bucket["enabled"].statement : s.sid], "DenyPutWithoutComplianceLock")
    error_message = "The bucket policy must deny deletes and uploads without COMPLIANCE retention."
  }
  assert {
    condition     = aws_kms_key.compliance_signing["enabled"].customer_master_key_spec == "ECC_NIST_P256" && aws_kms_key.compliance_signing["enabled"].key_usage == "SIGN_VERIFY"
    error_message = "Checkpoints are signed with an asymmetric ECC_NIST_P256 SIGN_VERIFY key."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.compliance_task["enabled"].statement : s.actions]), "kms:Sign") && !contains(flatten([for s in data.aws_iam_policy_document.github_deploy.statement : s.actions]), "kms:Sign")
    error_message = "Only the compliance task role may sign checkpoints; the deploy role must not."
  }
  assert {
    condition     = aws_scheduler_schedule.compliance["export"].schedule_expression == "rate(15 minutes)" && aws_scheduler_schedule.compliance["verify"].schedule_expression == "rate(1 hour)"
    error_message = "Export runs every 15 minutes and verification hourly."
  }
  assert {
    condition     = one(aws_scheduler_schedule.compliance["export"].target).ecs_parameters[0].network_configuration[0].assign_public_ip == false
    error_message = "Compliance tasks run in private subnets without a public IP."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.compliance_heartbeat["export"].treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.compliance_heartbeat["verify"].treat_missing_data == "breaching"
    error_message = "A missing compliance heartbeat must alarm."
  }
  assert {
    condition     = aws_secretsmanager_secret.compliance_database_url["enabled"].name == "fbeds-staging/compliance/COMPLIANCE_DATABASE_URL" && length(data.aws_iam_policy_document.compliance_execution["enabled"].statement[0].resources) == 1
    error_message = "Compliance tasks read only their own restricted database URL secret."
  }
}

run "compliance_retention_below_one_year_is_refused" {
  command = plan
  variables {
    environment               = "staging"
    public_ingress_cidrs      = ["203.0.113.0/24"]
    compliance_export_enabled = true
    compliance_retention_days = 30
  }
  expect_failures = [var.compliance_retention_days]
}
