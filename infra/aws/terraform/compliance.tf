# Compliance export (ADR 0067 amendment 2). Off by default: an owner enables it per environment after provisioning the compliance database role.
#  - WORM archive: S3 Object Lock in COMPLIANCE mode, its own KMS key, TLS only, no delete, every upload must carry COMPLIANCE retention.
#  - Two scheduled Fargate tasks from the API image: `ops:compliance export` every 15 minutes, `ops:compliance verify` hourly.
#  - Least privilege: a task role that can put/read/list this bucket only (never delete), an execution role that can read only
#    COMPLIANCE_DATABASE_URL (the restricted fbeds_compliance_export login, never the owner), a security group that reaches only Postgres and HTTPS.
#  - Alarms: any FAIL line, or no successful export (45 min) / verification (2 h), pages the existing alarm topic.
#  - Signed checkpoints (amendment 4): an asymmetric KMS key the task role may only Sign with; export signs every chain head, verify checks them.
# Teardown note: objects under COMPLIANCE retention cannot be deleted by anyone, root included, until their retain-until date. Enabling this in an
# environment means its bucket outlives `terraform destroy` for the retention period. Use the minimum retention (365 days) only where that is acceptable.

variable "compliance_export_enabled" {
  type        = bool
  default     = false
  description = "Create the compliance WORM archive, roles and schedules. Provision fbeds_compliance_export and set the COMPLIANCE_DATABASE_URL secret value first."
}
variable "compliance_retention_days" {
  type        = number
  default     = 2557
  description = "Object Lock COMPLIANCE retention for archived batches (bucket default and the exporter's per-object date). Seven years by default."
  validation {
    condition     = var.compliance_retention_days >= 365 && floor(var.compliance_retention_days) == var.compliance_retention_days
    error_message = "compliance_retention_days must be a whole number of at least 365 (the exporter refuses less)."
  }
}

locals {
  compliance = var.compliance_export_enabled ? toset(["enabled"]) : toset([])
  # Task name -> CLI command and schedule. The heartbeat pattern is the line each command prints when it finished successfully.
  compliance_jobs = var.compliance_export_enabled ? {
    export = { schedule = "rate(15 minutes)", heartbeat = "\"Compliance export to\"", heartbeat_minutes = 45 }
    verify = { schedule = "rate(1 hour)", heartbeat = "\"Compliance archive verified.\"", heartbeat_minutes = 120 }
  } : {}
  compliance_bucket = "${local.name}-compliance-${data.aws_caller_identity.this.account_id}"
}

# ---- encryption key: separate from the data key so archive access is granted (and audited) on its own ----
resource "aws_kms_key" "compliance" {
  for_each                = local.compliance
  description             = "${local.name} compliance archive (S3 Object Lock)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms_compliance.json
}
data "aws_iam_policy_document" "kms_compliance" {
  statement {
    sid       = "AccountRootAndIam"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.this.account_id}:root"]
    }
  }
}

# ---- checkpoint signing key (ADR 0067 amendment 4): asymmetric, the private key never leaves KMS; only the compliance task role may sign ----
# Asymmetric KMS keys do not support automatic rotation. A rotation is a new key: checkpoints name the key fingerprint, the archive keeps every
# public key, and the verifier checks each checkpoint against the key it names (docs/runbooks/compliance-export.md).
resource "aws_kms_key" "compliance_signing" {
  for_each                 = local.compliance
  description              = "${local.name} compliance checkpoint signing (ECDSA P-256)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.kms_compliance.json
}
resource "aws_kms_alias" "compliance_signing" {
  for_each      = local.compliance
  name          = "alias/${local.name}-compliance-signing"
  target_key_id = aws_kms_key.compliance_signing[each.key].key_id
}

# ---- WORM archive ----
resource "aws_s3_bucket" "compliance" {
  for_each            = local.compliance
  bucket              = local.compliance_bucket
  object_lock_enabled = true
  tags                = { Service = "compliance" }
}
resource "aws_s3_bucket_public_access_block" "compliance" {
  for_each                = local.compliance
  bucket                  = aws_s3_bucket.compliance[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "compliance" {
  for_each = local.compliance
  bucket   = aws_s3_bucket.compliance[each.key].id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_versioning" "compliance" {
  for_each = local.compliance
  bucket   = aws_s3_bucket.compliance[each.key].id
  versioning_configuration { status = "Enabled" } # required by Object Lock
}
resource "aws_s3_bucket_object_lock_configuration" "compliance" {
  for_each = local.compliance
  bucket   = aws_s3_bucket.compliance[each.key].id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.compliance_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.compliance]
}
resource "aws_s3_bucket_server_side_encryption_configuration" "compliance" {
  for_each = local.compliance
  bucket   = aws_s3_bucket.compliance[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.compliance[each.key].arn
    }
    bucket_key_enabled = true
  }
}
# Objects never expire here: retention is enforced by Object Lock and the batches are evidence. Only abandoned multipart uploads are cleaned.
resource "aws_s3_bucket_lifecycle_configuration" "compliance" {
  for_each = local.compliance
  bucket   = aws_s3_bucket.compliance[each.key].id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
data "aws_iam_policy_document" "compliance_bucket" {
  for_each = local.compliance
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.compliance[each.key].arn, "${aws_s3_bucket.compliance[each.key].arn}/*"]
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
  # Object Lock already blocks deleting a locked version; this also refuses delete markers, which would hide a batch from readers.
  statement {
    sid       = "DenyDelete"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.compliance[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
  # Every upload must state COMPLIANCE retention itself (the exporter always does), so a misconfigured writer cannot rely on defaults silently.
  statement {
    sid       = "DenyPutWithoutComplianceLock"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.compliance[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:object-lock-mode"
      values   = ["COMPLIANCE"]
    }
  }
}
resource "aws_s3_bucket_policy" "compliance" {
  for_each   = local.compliance
  bucket     = aws_s3_bucket.compliance[each.key].id
  policy     = data.aws_iam_policy_document.compliance_bucket[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.compliance]
}

# ---- the restricted database login's URL: a secret SHELL, value set out of band like the other runtime URLs ----
resource "aws_secretsmanager_secret" "compliance_database_url" {
  for_each    = local.compliance
  name        = "${local.name}/compliance/COMPLIANCE_DATABASE_URL"
  kms_key_id  = aws_kms_key.data.arn
  description = "postgresql:// URL for fbeds_compliance_export (restricted compliance export role, ADR 0067). Never the owner or the API login."
}

resource "aws_cloudwatch_log_group" "compliance" {
  for_each          = local.compliance
  name              = "/fbeds/${var.environment}/compliance"
  retention_in_days = local.retention.app
  kms_key_id        = aws_kms_key.data.arn
  tags              = { Service = "compliance" }
}

# ---- IAM ----
resource "aws_iam_role" "compliance_execution" {
  for_each           = local.compliance
  name               = "${local.name}-compliance-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}
resource "aws_iam_role_policy_attachment" "compliance_execution" {
  for_each   = local.compliance
  role       = aws_iam_role.compliance_execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "compliance_execution" {
  for_each = local.compliance
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.compliance_database_url[each.key].arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}
resource "aws_iam_role_policy" "compliance_execution" {
  for_each = local.compliance
  role     = aws_iam_role.compliance_execution[each.key].id
  policy   = data.aws_iam_policy_document.compliance_execution[each.key].json
}

resource "aws_iam_role" "compliance_task" {
  for_each           = local.compliance
  name               = "${local.name}-compliance-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}
# Write-once archive access: put with retention, read, list, and the Object Lock check the exporter runs before every run. No delete, no
# retention change after the fact (s3:PutObjectRetention is needed only to set it on upload), no bypass.
data "aws_iam_policy_document" "compliance_task" {
  for_each = local.compliance
  statement {
    actions   = ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject"]
    resources = ["${aws_s3_bucket.compliance[each.key].arn}/compliance/*"]
  }
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketObjectLockConfiguration"]
    resources = [aws_s3_bucket.compliance[each.key].arn]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.compliance[each.key].arn]
  }
  # Sign checkpoints and read the public key to archive it. No kms:Verify needed (verification uses the archived public key).
  statement {
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = [aws_kms_key.compliance_signing[each.key].arn]
  }
}
resource "aws_iam_role_policy" "compliance_task" {
  for_each = local.compliance
  role     = aws_iam_role.compliance_task[each.key].id
  policy   = data.aws_iam_policy_document.compliance_task[each.key].json
}

# ---- tasks ----
resource "aws_ecs_task_definition" "compliance" {
  for_each                 = local.compliance_jobs
  family                   = "${local.name}-compliance-${each.key}"
  tags                     = { Service = "compliance" }
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.compliance_execution["enabled"].arn
  task_role_arn            = aws_iam_role.compliance_task["enabled"].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name      = "compliance"
    image     = "${aws_ecr_repository.this["api"].repository_url}:${var.initial_image_tag}"
    essential = true
    command   = ["node", "--no-experimental-strip-types", "-r", "@swc-node/register", "src/compliance/compliance-ops.cli.ts", each.key]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "AWS_REGION", value = var.region },
      { name = "COMPLIANCE_ARCHIVE_BUCKET", value = aws_s3_bucket.compliance["enabled"].bucket },
      { name = "COMPLIANCE_RETENTION_DAYS", value = tostring(var.compliance_retention_days) },
      { name = "COMPLIANCE_SIGNING_KEY_ID", value = aws_kms_key.compliance_signing["enabled"].arn },
    ]
    secrets         = [{ name = "COMPLIANCE_DATABASE_URL", valueFrom = aws_secretsmanager_secret.compliance_database_url["enabled"].arn }]
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.compliance["enabled"].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key }
    }
  }])
  # The deploy workflow registers a new revision with each API image; the schedules always run the latest revision.
  lifecycle { ignore_changes = [container_definitions] }
}

# ---- schedules (EventBridge Scheduler -> ecs:RunTask) ----
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
  }
}
resource "aws_iam_role" "compliance_scheduler" {
  for_each           = local.compliance
  name               = "${local.name}-compliance-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}
data "aws_iam_policy_document" "compliance_scheduler" {
  for_each = local.compliance
  statement {
    actions   = ["ecs:RunTask"]
    resources = [for t in aws_ecs_task_definition.compliance : "${t.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.compliance[each.key].arn]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.compliance_execution[each.key].arn, aws_iam_role.compliance_task[each.key].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role_policy" "compliance_scheduler" {
  for_each = local.compliance
  role     = aws_iam_role.compliance_scheduler[each.key].id
  policy   = data.aws_iam_policy_document.compliance_scheduler[each.key].json
}
resource "aws_scheduler_schedule" "compliance" {
  for_each            = local.compliance_jobs
  name                = "${local.name}-compliance-${each.key}"
  schedule_expression = each.value.schedule
  kms_key_arn         = aws_kms_key.compliance["enabled"].arn # schedule definitions encrypted with the compliance key (CKV_AWS_297)
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.compliance_scheduler["enabled"].arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.compliance[each.key].arn_without_revision # latest ACTIVE revision
      launch_type         = "FARGATE"
      platform_version    = "LATEST"
      task_count          = 1
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.this["compliance"].id]
        assign_public_ip = false
      }
    }
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 600
    }
  }
}

# ---- alarms: failures and missing heartbeats page the existing alarm topic ----
resource "aws_cloudwatch_log_metric_filter" "compliance_failure" {
  for_each       = local.compliance
  name           = "${local.name}-compliance-failure"
  log_group_name = aws_cloudwatch_log_group.compliance[each.key].name
  pattern        = "?\"FAIL:\" ?\"Compliance command failed\" ?\"Refusing to run\""
  metric_transformation {
    name          = "ComplianceFailures"
    namespace     = "FBEDS/${var.environment}/Compliance"
    value         = "1"
    default_value = "0"
  }
}
resource "aws_cloudwatch_metric_alarm" "compliance_failure" {
  for_each            = local.compliance
  alarm_name          = "${local.name}-compliance-failure"
  alarm_description   = "A compliance export or verification reported a failure (FAIL line). See docs/runbooks/compliance-export.md section 3."
  namespace           = "FBEDS/${var.environment}/Compliance"
  metric_name         = "ComplianceFailures"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
resource "aws_cloudwatch_log_metric_filter" "compliance_heartbeat" {
  for_each       = local.compliance_jobs
  name           = "${local.name}-compliance-${each.key}-heartbeat"
  log_group_name = aws_cloudwatch_log_group.compliance["enabled"].name
  pattern        = each.value.heartbeat
  metric_transformation {
    name      = "Compliance${title(each.key)}Succeeded"
    namespace = "FBEDS/${var.environment}/Compliance"
    value     = "1"
  }
}
# A stopped schedule, a task that never starts or an exporter that stays red has no heartbeat: missing data is breaching.
resource "aws_cloudwatch_metric_alarm" "compliance_heartbeat" {
  for_each            = local.compliance_jobs
  alarm_name          = "${local.name}-compliance-${each.key}-missing"
  alarm_description   = "No successful compliance ${each.key} in ${each.value.heartbeat_minutes} minutes."
  namespace           = "FBEDS/${var.environment}/Compliance"
  metric_name         = "Compliance${title(each.key)}Succeeded"
  statistic           = "Sum"
  period              = each.value.heartbeat_minutes * 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

output "compliance_archive_bucket" { value = var.compliance_export_enabled ? aws_s3_bucket.compliance["enabled"].bucket : null }
output "compliance_task_families" { value = [for t in aws_ecs_task_definition.compliance : t.family] }
output "compliance_signing_key_arn" { value = var.compliance_export_enabled ? aws_kms_key.compliance_signing["enabled"].arn : null }
output "compliance_database_url_secret_arn" { value = var.compliance_export_enabled ? aws_secretsmanager_secret.compliance_database_url["enabled"].arn : null }
