variable "region" { type = string }
variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}
variable "domain_name" {
  type        = string
  description = "Public root domain, e.g. fbeds.com. Hosted zone must already exist."
}
variable "hosted_zone_id" { type = string }
variable "az_count" {
  type    = number
  default = 2
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "nat_per_az" {
  type        = bool
  default     = false
  description = "One NAT gateway per AZ (production) or a single shared one (staging)."
}
variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}
variable "db_allocated_storage" {
  type    = number
  default = 100
}
variable "db_multi_az" {
  type    = bool
  default = true
}
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}
# Initial image tags only. After the first apply, CI registers new task-definition revisions (lifecycle ignores task_definition).
variable "initial_image_tag" {
  type    = string
  default = "bootstrap"
}
variable "api_cpu" {
  type    = number
  default = 1024
}
variable "api_memory" {
  type    = number
  default = 2048
}
variable "api_desired_count" {
  type    = number
  default = 2
}
variable "portal_cpu" {
  type    = number
  default = 512
}
variable "portal_memory" {
  type    = number
  default = 1024
}
variable "portal_desired_count" {
  type    = number
  default = 2
}
variable "github_repository" {
  type    = string
  default = "rammyyadav-dot/bedbanks-system"
}
variable "alarm_email" {
  type        = string
  default     = ""
  description = "Optional subscriber for the alarm topic."
}
# Non-secret API settings. Secrets (database URLs, Redis URL) live in Secrets Manager, never here.
variable "api_env" {
  type = map(string)
  default = {
    BOOKING_ENABLED = "false" # Agent booking stays unavailable until the owner decides otherwise.
  }
}
variable "booking_ops_enabled" {
  type        = bool
  default     = false
  description = "Inject BOOKING_OPS_DATABASE_URL (the booking module's limited role). Set the secret value first; ECS refuses to start a task whose secret is empty."
}

# ---- cost governance (blueprint section 7) ----
variable "cost_owner" {
  type        = string
  default     = "platform"
  description = "Value of the Owner cost-allocation tag."
  validation {
    condition     = trimspace(var.cost_owner) != ""
    error_message = "cost_owner must not be empty (mandatory tag)."
  }
}
variable "cost_center" {
  type        = string
  default     = "fbeds-platform"
  description = "Value of the CostCenter cost-allocation tag."
  validation {
    condition     = trimspace(var.cost_center) != ""
    error_message = "cost_center must not be empty (mandatory tag)."
  }
}
variable "monthly_budget_usd" {
  type        = number
  default     = 0
  description = "Approved monthly ceiling for this environment in USD. 0 creates no budget; set it BEFORE the first chargeable apply (the owner approves the number)."
  validation {
    condition     = var.monthly_budget_usd >= 0
    error_message = "monthly_budget_usd must not be negative."
  }
}
variable "budget_emails" {
  type        = list(string)
  default     = []
  description = "Recipients of budget alerts. Required when monthly_budget_usd > 0."
}
variable "budget_alert_thresholds" {
  type = list(object({
    percent = number
    type    = string
  }))
  default = [
    { percent = 80, type = "ACTUAL" },
    { percent = 100, type = "ACTUAL" },
    { percent = 100, type = "FORECASTED" },
  ]
  description = "Budget alert points. Parameters awaiting owner approval, not business decisions."
  validation {
    condition     = alltrue([for t in var.budget_alert_thresholds : t.percent > 0 && contains(["ACTUAL", "FORECASTED"], t.type)])
    error_message = "Each threshold needs percent > 0 and type ACTUAL or FORECASTED."
  }
}

# ---- exposure controls (ADR 0055) ----
variable "public_ingress_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "CIDRs allowed to reach the public ALB. Staging MUST list only trusted egress ranges (office/VPN); 0.0.0.0/0 is refused for staging."
  validation {
    condition     = length(var.public_ingress_cidrs) > 0 && alltrue([for c in var.public_ingress_cidrs : can(cidrnetmask(c))])
    error_message = "public_ingress_cidrs must be a non-empty list of valid IPv4 CIDRs."
  }
}
variable "production_edge_exception_ref" {
  type        = string
  default     = ""
  description = "Production requires CloudFront (ADR 0055), which this stack does not implement yet. Until it does, a production apply is refused unless this names the approved exception (ADR or ticket reference)."
}
variable "dns_cutover_authorization_ref" {
  type        = string
  default     = ""
  description = "Reference to the recorded CTO GO decision. Required to create production public DNS records (create_portal_records)."
}
