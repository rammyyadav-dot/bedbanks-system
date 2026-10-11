# Offline governance tests: a mocked AWS provider, `command = plan`, no credentials and no AWS API call.
# Run: terraform -chdir=infra/aws/terraform test   (after `terraform init -backend=false`)
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-south-1a", "ap-south-1b", "ap-south-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  # Policy documents must be valid JSON for the mocked resources that embed them.
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

run "empty_cost_tag_is_refused" {
  command = plan
  variables {
    environment          = "staging"
    public_ingress_cidrs = ["203.0.113.0/24"]
    cost_owner           = " "
  }
  expect_failures = [var.cost_owner]
}
