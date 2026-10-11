# Logging and monitoring (WP3 phase 3). Every sink has an explicit retention, restricted access and no secret material:
#  - flow logs: addresses, ports, bytes (no payload);
#  - ALB logs: client IP, method and URL (query strings can carry identifiers, so keep retention short and the bucket private);
#  - WAF logs: only BLOCK/COUNT events, Authorization and Cookie headers redacted;
#  - RDS: connections, disconnections, DDL, slow statements (log_min_duration_statement) and the engine upgrade log, never statement bodies for DML.

# ---- VPC flow logs ----
resource "aws_cloudwatch_log_group" "flow" {
  count             = var.enable_flow_logs ? 1 : 0
  name              = "/fbeds/${var.environment}/vpc-flow"
  retention_in_days = local.retention.flow
  kms_key_id        = aws_kms_key.data.arn
  tags              = { Service = "network" }
}
data "aws_iam_policy_document" "flow_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ec2:${var.region}:${data.aws_caller_identity.this.account_id}:vpc-flow-log/*"]
    }
  }
}
resource "aws_iam_role" "flow" {
  count              = var.enable_flow_logs ? 1 : 0
  name               = "${local.name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_trust.json
}
data "aws_iam_policy_document" "flow" {
  count = var.enable_flow_logs ? 1 : 0
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow[0].arn}:*"]
  }
}
resource "aws_iam_role_policy" "flow" {
  count  = var.enable_flow_logs ? 1 : 0
  role   = aws_iam_role.flow[0].id
  policy = data.aws_iam_policy_document.flow[0].json
}
resource "aws_flow_log" "vpc" {
  count                    = var.enable_flow_logs ? 1 : 0
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow[0].arn
  iam_role_arn             = aws_iam_role.flow[0].arn
  max_aggregation_interval = 600 # ten-minute aggregation: a tenth of the ingestion of the 60 s option
  tags                     = { Name = "${local.name}-vpc-flow" }
}

# ---- ALB access logs ----
# ALB log delivery supports only SSE-S3 (AES256), not SSE-KMS; the bucket is private, TLS-only, versioned, and expires objects.
data "aws_elb_service_account" "this" {}
resource "aws_s3_bucket" "alb_logs" {
  bucket = "${local.name}-alb-logs-${data.aws_caller_identity.this.account_id}"
  tags   = { Service = "network" }
}
resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {}
    expiration { days = local.retention.alb_s3 }
    noncurrent_version_expiration { noncurrent_days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid       = "AlbDeliversLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/alb/*"]
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.alb_logs.arn, "${aws_s3_bucket.alb_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
resource "aws_s3_bucket_policy" "alb_logs" {
  bucket     = aws_s3_bucket.alb_logs.id
  policy     = data.aws_iam_policy_document.alb_logs.json
  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}

# ---- WAF logs for the REGIONAL web ACL on the public ALB (CloudFront's ACL is in edge.tf) ----
resource "aws_cloudwatch_log_group" "waf_regional" {
  name              = "aws-waf-logs-${local.name}-regional" # WAF requires the aws-waf-logs- prefix
  retention_in_days = local.retention.waf
  kms_key_id        = aws_kms_key.data.arn
  tags              = { Service = "edge" }
}
data "aws_iam_policy_document" "waf_logs_delivery" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.waf_regional.arn}:*"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.this.account_id}:*"]
    }
  }
}
resource "aws_cloudwatch_log_resource_policy" "waf_regional" {
  policy_name     = "${local.name}-waf-logs"
  policy_document = jsonencode(jsondecode(data.aws_iam_policy_document.waf_logs_delivery.json))
}
resource "aws_wafv2_web_acl_logging_configuration" "regional" {
  resource_arn            = aws_wafv2_web_acl.public.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf_regional.arn]
  redacted_fields {
    single_header { name = "authorization" }
  }
  redacted_fields {
    single_header { name = "cookie" }
  }
  # Cost control: allowed traffic is not logged (the ALB access log covers it); BLOCK and COUNT events are.
  logging_filter {
    default_behavior = "DROP"
    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"
      condition {
        action_condition { action = "BLOCK" }
      }
      condition {
        action_condition { action = "COUNT" }
      }
    }
  }
  depends_on = [aws_cloudwatch_log_resource_policy.waf_regional]
}

# ---- RDS: exported engine logs and Enhanced Monitoring ----
resource "aws_cloudwatch_log_group" "rds" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.name}/${each.key}"
  retention_in_days = local.retention.rds
  kms_key_id        = aws_kms_key.data.arn
  tags              = { Service = "database" }
}
data "aws_iam_policy_document" "rds_monitoring_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
  }
}
resource "aws_iam_role" "rds_monitoring" {
  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_trust.json
}
resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
