# Scheduled hotel search reindex (ADR 0097; role in ADR 0096). Off by default: an owner enables it per environment after provisioning
# fbeds_search_reindex_ops (docs/runbooks/hotel-search-reindex-role.md) and setting the secret value.
#  - One scheduled Fargate task from the API image: `ops:reindex-hotel-search --apply --fail-on-stale`, which writes only HotelSearchIndex.
#  - Least privilege: the task role has no AWS permissions at all, the execution role can read only HOTEL_SEARCH_REINDEX_DATABASE_URL
#    (the narrow login, never the owner or the API login), and the security group reaches only Postgres and HTTPS.
#  - Alarm: no successful run within the heartbeat window pages the existing alarm topic (missing data is breaching).

variable "hotel_search_reindex_enabled" {
  type        = bool
  default     = false
  description = "Create the scheduled hotel search reindex task, roles and alarm. Provision fbeds_search_reindex_ops and set the HOTEL_SEARCH_REINDEX_DATABASE_URL secret value first."
}
variable "hotel_search_reindex_schedule" {
  type        = string
  default     = "rate(1 hour)"
  description = "EventBridge Scheduler expression for the reindex. Idempotent: a run with nothing stale writes nothing."
}
variable "hotel_search_reindex_database_name" {
  type        = string
  default     = ""
  description = "Exact database name; the CLI refuses a remote target unless --confirm-database matches it."
  validation {
    condition     = !var.hotel_search_reindex_enabled || length(var.hotel_search_reindex_database_name) > 0
    error_message = "hotel_search_reindex_database_name is required when hotel_search_reindex_enabled is true."
  }
}

locals {
  reindex = var.hotel_search_reindex_enabled ? toset(["enabled"]) : toset([])
  # Window after which a missing success pages: three schedule periods at the default hourly rate.
  reindex_heartbeat_minutes = 180
}

# ---- the restricted database login's URL: a secret SHELL, value set out of band like the other runtime URLs ----
resource "aws_secretsmanager_secret" "search_reindex_database_url" {
  for_each    = local.reindex
  name        = "${local.name}/search-reindex/HOTEL_SEARCH_REINDEX_DATABASE_URL"
  kms_key_id  = aws_kms_key.data.arn
  description = "postgresql:// direct (non-pooled) URL for fbeds_search_reindex_ops (ADR 0096). Never the owner or the API login."
}

resource "aws_cloudwatch_log_group" "search_reindex" {
  for_each          = local.reindex
  name              = "/fbeds/${var.environment}/search-reindex"
  retention_in_days = local.retention.app
  kms_key_id        = aws_kms_key.data.arn
  tags              = { Service = "search-reindex" }
}

# ---- IAM ----
resource "aws_iam_role" "search_reindex_execution" {
  for_each           = local.reindex
  name               = "${local.name}-search-reindex-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}
resource "aws_iam_role_policy_attachment" "search_reindex_execution" {
  for_each   = local.reindex
  role       = aws_iam_role.search_reindex_execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "search_reindex_execution" {
  for_each = local.reindex
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.search_reindex_database_url[each.key].arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}
resource "aws_iam_role_policy" "search_reindex_execution" {
  for_each = local.reindex
  role     = aws_iam_role.search_reindex_execution[each.key].id
  policy   = data.aws_iam_policy_document.search_reindex_execution[each.key].json
}
# The job talks to Postgres only. The task role is deliberately empty: no AWS API access from inside the container.
resource "aws_iam_role" "search_reindex_task" {
  for_each           = local.reindex
  name               = "${local.name}-search-reindex-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# ---- task ----
resource "aws_ecs_task_definition" "search_reindex" {
  for_each                 = local.reindex
  family                   = "${local.name}-search-reindex"
  tags                     = { Service = "search-reindex" }
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.search_reindex_execution[each.key].arn
  task_role_arn            = aws_iam_role.search_reindex_task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name      = "search-reindex"
    image     = "${aws_ecr_repository.this["api"].repository_url}:${var.initial_image_tag}"
    essential = true
    command = [
      "node", "--no-experimental-strip-types", "-r", "@swc-node/register", "src/database/reindex-hotel-search.cli.ts",
      "--apply", "--fail-on-stale", "--allow-remote", "--confirm-database=${var.hotel_search_reindex_database_name}",
    ]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "AWS_REGION", value = var.region },
    ]
    secrets         = [{ name = "HOTEL_SEARCH_REINDEX_DATABASE_URL", valueFrom = aws_secretsmanager_secret.search_reindex_database_url[each.key].arn }]
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.search_reindex[each.key].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "reindex" }
    }
  }])
  # The deploy workflow registers a new revision with each API image; the schedule always runs the latest revision.
  lifecycle { ignore_changes = [container_definitions] }
}

# ---- schedule (EventBridge Scheduler -> ecs:RunTask) ----
resource "aws_iam_role" "search_reindex_scheduler" {
  for_each           = local.reindex
  name               = "${local.name}-search-reindex-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}
data "aws_iam_policy_document" "search_reindex_scheduler" {
  for_each = local.reindex
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.search_reindex[each.key].arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.search_reindex_execution[each.key].arn, aws_iam_role.search_reindex_task[each.key].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role_policy" "search_reindex_scheduler" {
  for_each = local.reindex
  role     = aws_iam_role.search_reindex_scheduler[each.key].id
  policy   = data.aws_iam_policy_document.search_reindex_scheduler[each.key].json
}
resource "aws_scheduler_schedule" "search_reindex" {
  for_each            = local.reindex
  name                = "${local.name}-search-reindex"
  schedule_expression = var.hotel_search_reindex_schedule
  kms_key_arn         = aws_kms_key.data.arn # schedule definition encrypted at rest (CKV_AWS_297)
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.search_reindex_scheduler[each.key].arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.search_reindex[each.key].arn_without_revision # latest ACTIVE revision
      launch_type         = "FARGATE"
      platform_version    = "LATEST"
      task_count          = 1
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.this["search_reindex"].id]
        assign_public_ip = false
      }
    }
    retry_policy {
      maximum_retry_attempts       = 1
      maximum_event_age_in_seconds = 600
    }
  }
}

# ---- alarm: the CLI prints its JSON report only after a run that reconciled; a stopped schedule, a task that never starts or a red run has no heartbeat ----
resource "aws_cloudwatch_log_metric_filter" "search_reindex_heartbeat" {
  for_each       = local.reindex
  name           = "${local.name}-search-reindex-heartbeat"
  log_group_name = aws_cloudwatch_log_group.search_reindex[each.key].name
  pattern        = "\"\\\"appliedEqualsIndexable\\\": true\""
  metric_transformation {
    name      = "SearchReindexSucceeded"
    namespace = "FBEDS/${var.environment}/SearchReindex"
    value     = "1"
  }
}
resource "aws_cloudwatch_metric_alarm" "search_reindex_missing" {
  for_each            = local.reindex
  alarm_name          = "${local.name}-search-reindex-missing"
  alarm_description   = "No successful hotel search reindex in ${local.reindex_heartbeat_minutes} minutes. See docs/runbooks/hotel-search-reindex-role.md."
  namespace           = "FBEDS/${var.environment}/SearchReindex"
  metric_name         = "SearchReindexSucceeded"
  statistic           = "Sum"
  period              = local.reindex_heartbeat_minutes * 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

output "search_reindex_database_url_secret_arn" { value = var.hotel_search_reindex_enabled ? aws_secretsmanager_secret.search_reindex_database_url["enabled"].arn : null }
