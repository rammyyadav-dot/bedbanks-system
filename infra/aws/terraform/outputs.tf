output "ecr_repositories" { value = { for k, r in aws_ecr_repository.this : k => r.repository_url } }
output "public_alb_dns" { value = aws_lb.public.dns_name }
output "api_internal_url" { value = local.api_origin }
output "db_endpoint" { value = aws_db_instance.this.address }
output "redis_primary_endpoint" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "github_build_role_arn" { value = aws_iam_role.github_build.arn }
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "migrate_task_family" { value = aws_ecs_task_definition.migrate.family }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "api_security_group_id" { value = aws_security_group.api.id }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "secret_arns" {
  value = { database_url = aws_secretsmanager_secret.api_database_url.arn, booking_ops_database_url = aws_secretsmanager_secret.booking_ops_database_url.arn, redis_url = aws_secretsmanager_secret.redis_url.arn }
}
# Worst case the stack can open: every API task at its autoscaling maximum, every pool full (+2 for the hold-expiry sweeper when enabled).
output "db_connection_budget" {
  value = { worst_case = (var.db_pool_max + var.db_booking_pool_max + 2) * var.api_desired_count * 4, per_task = var.db_pool_max + var.db_booking_pool_max + 2 }
}
