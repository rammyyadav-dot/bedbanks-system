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
variable "db_pool_max" {
  type        = number
  default     = 10
  description = "Prisma connections per API task, main client."
}
variable "db_booking_pool_max" {
  type        = number
  default     = 5
  description = "Prisma connections per API task, booking-module client."
}
variable "db_connections_alarm_threshold" {
  type        = number
  default     = 400
  description = "Alarm when the database has more than this many client connections. Keep it below ~70% of max_connections (see the runbook's connection budget)."
}
