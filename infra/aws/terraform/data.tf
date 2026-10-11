resource "aws_kms_key" "data" {
  description             = "${local.name} data at rest (RDS, Redis, Secrets Manager, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms_data.json
}
# Explicit key policy (the default one cannot be used by CloudWatch Logs or by CloudWatch alarms publishing to an encrypted SNS topic, so an
# encrypted log group or the alarm topic would fail or silently drop notifications). IAM keeps governing everything else through the root statement.
data "aws_iam_policy_document" "kms_data" {
  statement {
    sid       = "AccountRootAndIam"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.this.account_id}:root"]
    }
  }
  statement {
    sid       = "CloudWatchLogsEncryptDecrypt"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.this.account_id}:*"]
    }
  }
  statement {
    sid       = "CloudWatchAlarmsPublishToEncryptedTopic"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
  }
}
resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.id
}

# ---- PostgreSQL 16. RDS supports pgvector and pg_trgm, which migration 202610010003 creates (docs/runbooks/api-deploy.md). ----
resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}
resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.name}-pg16-"
  family      = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  # Connection and DDL auditing without statement bodies: log_statement=all would write guest PII and supplier payload fragments to the log.
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name  = "log_statement"
    value = "ddl"
  }
  lifecycle { create_before_destroy = true }
}
resource "aws_db_instance" "this" {
  identifier                          = local.name
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = var.db_instance_class
  allocated_storage                   = var.db_allocated_storage
  max_allocated_storage               = var.db_allocated_storage * 4
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.data.arn
  db_name                             = "fbeds"
  username                            = "fbeds_owner"
  manage_master_user_password         = true # the owner password lives only in Secrets Manager, rotated by RDS
  master_user_secret_kms_key_id       = aws_kms_key.data.arn
  multi_az                            = var.db_multi_az
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.this["data"].id]
  parameter_group_name                = aws_db_parameter_group.this.name
  publicly_accessible                 = false
  backup_retention_period             = 14
  deletion_protection                 = var.environment == "production"
  skip_final_snapshot                 = var.environment != "production"
  final_snapshot_identifier           = var.environment == "production" ? "${local.name}-final" : null
  copy_tags_to_snapshot               = true
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = false
  apply_immediately                   = false
  # The exported log groups must exist (with our retention and key) before RDS creates them with indefinite retention.
  depends_on = [aws_cloudwatch_log_group.rds]
}

# ---- Redis (search cache). TLS in transit; REDIS_URL must therefore be rediss:// ----
resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}
resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = local.name
  description                = "${local.name} search cache"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled           = var.environment == "production"
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.this["data"].id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  snapshot_retention_limit   = 1
  # Redis AUTH over TLS. The token is generated by Terraform and therefore lives in the (encrypted) state; rotation is documented in
  # docs/aws-secret-rotation-runbook.md. It is never an output and is stored for the API only as the REDIS_URL secret.
  auth_token                 = random_password.redis_auth.result
  auth_token_update_strategy = "ROTATE"
}
resource "random_password" "redis_auth" {
  length  = 48
  special = false # ElastiCache forbids @ " / and some printable characters; alphanumerics keep the URL parse-safe
  keepers = { rotation = var.redis_auth_rotation_id }
}
