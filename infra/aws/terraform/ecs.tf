resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = merge(local.services, { migrate = { port = 0 } })
  name              = "/fbeds/${var.environment}/${each.key}"
  retention_in_days = var.environment == "production" ? 90 : 30
  kms_key_id        = aws_kms_key.data.arn
}

locals {
  api_origin = "https://${local.api_host}/api/v1"
  portal_env = {
    website = [{ name = "TRUSTED_PROXY", value = "aws-alb" }] # lead rate limiter: trust only the ALB-appended X-Forwarded-For entry
    agent   = [{ name = "API_INTERNAL_URL", value = local.api_origin }, { name = "PORTAL_HOSTED", value = "1" }]
    admin   = [{ name = "API_INTERNAL_URL", value = local.api_origin }, { name = "AUTH_API_ORIGIN", value = "https://${local.portals.admin.host}" }, { name = "PORTAL_HOSTED", value = "1" }]
    supplier = [{ name = "API_INTERNAL_URL", value = local.api_origin }, { name = "SUPPLIER_ORIGIN", value = "https://${local.portals.supplier.host}" }, { name = "PORTAL_HOSTED", value = "1" }]
  }
  api_environment = concat([for k, v in merge({
    NODE_ENV            = "production"
    API_HOST            = "0.0.0.0"
    API_PORT            = "3002"
    API_PREFIX          = "api/v1"
    AUTH_COOKIE_SECURE  = "true"
    ADMIN_ORIGIN        = "https://${local.portals.admin.host}"
    TRUSTED_ORIGINS     = "https://${local.portals.agent.host},https://${local.portals.supplier.host}"
  }, var.api_env) : { name = k, value = v }])
  api_secrets = concat([
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url.arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
  ], var.booking_ops_enabled ? [{ name = "BOOKING_OPS_DATABASE_URL", valueFrom = aws_secretsmanager_secret.booking_ops_database_url.arn }] : [])
}

resource "aws_ecs_task_definition" "this" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "api" ? var.api_cpu : var.portal_cpu
  memory                   = each.key == "api" ? var.api_memory : var.portal_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name         = each.key
    image        = "${aws_ecr_repository.this[each.key].repository_url}:${var.initial_image_tag}"
    essential    = true
    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
    environment  = each.key == "api" ? tolist(local.api_environment) : tolist(lookup(local.portal_env, each.key, []))
    secrets      = each.key == "api" ? tolist(local.api_secrets) : []
    stopTimeout  = 30
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.this[each.key].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key }
    }
  }])
  # CI registers new revisions; Terraform owns only the first one.
  lifecycle { ignore_changes = [container_definitions] }
}

resource "aws_ecs_service" "this" {
  for_each                           = local.services
  name                               = each.key
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.this[each.key].arn
  desired_count                      = each.key == "api" ? var.api_desired_count : var.portal_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = each.key == "api" ? 120 : 60
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true # a deployment whose tasks never become healthy rolls back by itself
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [each.key == "api" ? aws_security_group.api.id : aws_security_group.portal.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = each.key == "api" ? aws_lb_target_group.api.arn : aws_lb_target_group.portal[each.key].arn
    container_name   = each.key
    container_port   = each.value.port
  }
  lifecycle { ignore_changes = [task_definition, desired_count] }
  depends_on = [aws_lb_listener.https, aws_lb_listener.internal_https]
}

resource "aws_appautoscaling_target" "this" {
  for_each           = local.services
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.key == "api" ? var.api_desired_count : var.portal_desired_count
  max_capacity       = (each.key == "api" ? var.api_desired_count : var.portal_desired_count) * 4
}
resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.services
  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

# ---- One-off migration task: run by a person, never by a deploy. The only task that can read the database owner secret. ----
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migrate_execution.arn
  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.this["api"].repository_url}:${var.initial_image_tag}"
    essential = true
    environment = [
      { name = "DB_HOST", value = aws_db_instance.this.address },
      { name = "DB_NAME", value = aws_db_instance.this.db_name },
      { name = "DB_USER", value = "fbeds_owner" },
    ]
    secrets = [{ name = "DB_PASSWORD", valueFrom = "${aws_db_instance.this.master_user_secret[0].secret_arn}:password::" }]
    command = ["sh", "-c", "export DATABASE_URL=\"postgresql://$DB_USER:$(node -p 'encodeURIComponent(process.env.DB_PASSWORD)')@$DB_HOST:5432/$DB_NAME?schema=public&sslmode=require\" && exec pnpm --filter @bedbanks/api prisma:migrate:deploy"]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.this["migrate"].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "migrate" }
    }
  }])
  lifecycle { ignore_changes = [container_definitions] }
}
