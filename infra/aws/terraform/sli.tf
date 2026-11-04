# Staging SLIs (ADR 0112). The API writes one JSON line per finished request: {"event":"ops.sli",...}.
# Metric filters turn server errors and authorization denials into alarms on the same SNS topic as the other pages.
# Connector failure ratio stays on traces until the ADOT collector is confirmed (ADR 0093). Job heartbeats stay in search-reindex.tf and compliance.tf.

locals {
  sli_namespace = "FBEDS/${var.environment}/Sli"
  sli_server_errors = {
    authentication = { signal = "authentication", metric = "AuthenticationServerError", threshold = 5, description = "Authentication responses returned HTTP 5xx." }
    search         = { signal = "search", metric = "SearchServerError", threshold = 5, description = "Hotel search responses returned HTTP 5xx." }
    recheck        = { signal = "recheck", metric = "RecheckServerError", threshold = 5, description = "Rate recheck responses returned HTTP 5xx." }
    booking        = { signal = "booking", metric = "BookingServerError", threshold = 1, description = "Booking create responses returned HTTP 5xx." }
    cancellation   = { signal = "cancellation", metric = "CancellationServerError", threshold = 1, description = "Booking cancellation responses returned HTTP 5xx." }
  }
}

resource "aws_cloudwatch_log_metric_filter" "sli_server_error" {
  for_each       = local.sli_server_errors
  name           = "${local.name}-sli-${each.key}-server-error"
  log_group_name = aws_cloudwatch_log_group.this["api"].name
  pattern        = "{ $.event = \"ops.sli\" && $.signal = \"${each.value.signal}\" && $.outcome = \"server_error\" }"
  metric_transformation {
    name          = each.value.metric
    namespace     = local.sli_namespace
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_metric_alarm" "sli_server_error" {
  for_each            = local.sli_server_errors
  alarm_name          = "${local.name}-sli-${each.key}-server-error"
  alarm_description   = each.value.description
  namespace           = local.sli_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_log_metric_filter" "sli_authorization_denial" {
  name           = "${local.name}-sli-authorization-denial"
  log_group_name = aws_cloudwatch_log_group.this["api"].name
  pattern        = "{ $.event = \"ops.sli\" && $.outcome = \"denied\" && $.signal != \"authentication\" }"
  metric_transformation {
    name          = "AuthorizationDenial"
    namespace     = local.sli_namespace
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_metric_alarm" "sli_authorization_denial" {
  alarm_name          = "${local.name}-sli-authorization-denial"
  alarm_description   = "Authorization denials outside authentication exceeded 100 in 5 minutes."
  namespace           = local.sli_namespace
  metric_name         = "AuthorizationDenial"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 100
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = "${local.name}-operations"
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 3
        properties = {
          markdown = "# fBeds ${var.environment} operations\nObjectives live in docs/ops/slo-catalog.json. SLI widgets stay at zero until the API revision that emits `ops.sli` is serving. Booking stays off until an owner enables it for this environment. An alarm with no confirmed SNS subscriber is not monitoring."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 3
        width  = 12
        height = 6
        properties = {
          title   = "API target latency"
          view    = "timeSeries"
          region  = var.region
          period  = 60
          stat    = "p95"
          metrics = [["AWS/ApplicationELB", "TargetResponseTime", "TargetGroup", aws_lb_target_group.api.arn_suffix, "LoadBalancer", aws_lb.internal.arn_suffix]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 3
        width  = 12
        height = 6
        properties = {
          title   = "API 5xx and healthy targets"
          view    = "timeSeries"
          region  = var.region
          period  = 60
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.internal.arn_suffix, { stat = "Sum" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", aws_lb_target_group.api.arn_suffix, "LoadBalancer", aws_lb.internal.arn_suffix, { stat = "Minimum" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 9
        width  = 12
        height = 6
        properties = {
          title   = "API task saturation"
          view    = "timeSeries"
          region  = var.region
          period  = 60
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.this.name, "ServiceName", aws_ecs_service.this["api"].name],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.this.name, "ServiceName", aws_ecs_service.this["api"].name]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 9
        width  = 12
        height = 6
        properties = {
          title   = "Database pressure"
          view    = "timeSeries"
          region  = var.region
          period  = 60
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.this.identifier],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.this.identifier],
            ["AWS/RDS", "FreeableMemory", "DBInstanceIdentifier", aws_db_instance.this.identifier],
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", aws_db_instance.this.identifier]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 15
        width  = 24
        height = 6
        properties = {
          title   = "Journey server errors and authorization denials"
          view    = "timeSeries"
          region  = var.region
          period  = 300
          stat    = "Sum"
          metrics = [
            [local.sli_namespace, "AuthenticationServerError"],
            [local.sli_namespace, "SearchServerError"],
            [local.sli_namespace, "RecheckServerError"],
            [local.sli_namespace, "BookingServerError"],
            [local.sli_namespace, "CancellationServerError"],
            [local.sli_namespace, "AuthorizationDenial"]
          ]
        }
      }
    ]
  })
}
