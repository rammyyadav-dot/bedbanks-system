# Monthly cost ceiling for this environment. Filters on the Environment cost-allocation tag, which must be ACTIVATED once per account in
# Billing > Cost allocation tags (out of band; tags only report cost from activation onward). Alerts 80% actual, 100% actual, 100% forecast.
resource "aws_budgets_budget" "monthly" {
  count        = var.monthly_budget_usd > 0 ? 1 : 0
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Environment$%s", var.environment)]
  }

  dynamic "notification" {
    for_each = [
      { threshold = 80, type = "ACTUAL" },
      { threshold = 100, type = "ACTUAL" },
      { threshold = 100, type = "FORECASTED" },
    ]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = var.budget_emails
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.budget_emails) > 0
      error_message = "budget_emails must list at least one recipient when monthly_budget_usd > 0."
    }
  }
}
