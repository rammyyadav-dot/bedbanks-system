# Secret shells only. Terraform never holds a value: they are set out of band with `aws secretsmanager put-secret-value`
# (docs/runbooks/aws-ecs-deployment.md). The two runtime URLs are for the LIMITED roles, never the owner (ADR 0010, strict runtime role).
resource "aws_secretsmanager_secret" "api_database_url" {
  name       = "${local.name}/api/DATABASE_URL"
  kms_key_id = aws_kms_key.data.arn
  description = "postgresql:// URL for fbeds_api_login (strict runtime role). Never the owner URL."
}
resource "aws_secretsmanager_secret" "booking_ops_database_url" {
  name       = "${local.name}/api/BOOKING_OPS_DATABASE_URL"
  kms_key_id = aws_kms_key.data.arn
  description = "postgresql:// URL for fbeds_booking_ops. Must differ from DATABASE_URL."
}
resource "aws_secretsmanager_secret" "redis_url" {
  name       = "${local.name}/api/REDIS_URL"
  kms_key_id = aws_kms_key.data.arn
  description = "rediss://... URL of the ElastiCache replication group (TLS)."
}
