resource "aws_kms_key" "data" {
  description             = "${local.name} data at rest (RDS, Redis, Secrets Manager, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
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
  vpc_security_group_ids              = [aws_security_group.data.id]
  parameter_group_name                = aws_db_parameter_group.this.name
  publicly_accessible                 = false
  backup_retention_period             = 14
  deletion_protection                 = var.environment == "production"
  skip_final_snapshot                 = var.environment != "production"
  final_snapshot_identifier           = var.environment == "production" ? "${local.name}-final" : null
  copy_tags_to_snapshot               = true
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.data.arn
  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = false
  apply_immediately                   = false
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
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  snapshot_retention_limit   = 1
}
