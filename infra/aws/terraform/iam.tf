data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull images, write logs, read ONLY this environment's runtime secrets.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.api_database_url.arn, aws_secretsmanager_secret.booking_ops_database_url.arn, aws_secretsmanager_secret.redis_url.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}
resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task roles carry no AWS permissions: the apps call no AWS API. Separate roles so a grant can be added per service later.
resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# One-off migration task: the only principal that may read the database OWNER secret.
resource "aws_iam_role" "migrate_execution" {
  name               = "${local.name}-migrate-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}
resource "aws_iam_role_policy_attachment" "migrate_execution" {
  role       = aws_iam_role.migrate_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "migrate_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.this.master_user_secret[0].secret_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}
resource "aws_iam_role_policy" "migrate_secrets" {
  role   = aws_iam_role.migrate_execution.id
  policy = data.aws_iam_policy_document.migrate_secrets.json
}

# ---- GitHub Actions: OIDC, no long-lived keys. Build role may push images; deploy role may update only these services. ----
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
data "aws_iam_policy_document" "github_trust" {
  for_each = {
    build  = "repo:${var.github_repository}:ref:refs/heads/main"
    deploy = "repo:${var.github_repository}:environment:${var.environment}"
  }
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [each.value]
    }
  }
}
resource "aws_iam_role" "github_build" {
  name               = "${local.name}-github-build"
  assume_role_policy = data.aws_iam_policy_document.github_trust["build"].json
}
data "aws_iam_policy_document" "github_build" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:DescribeImages"]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }
}
resource "aws_iam_role_policy" "github_build" {
  role   = aws_iam_role.github_build.id
  policy = data.aws_iam_policy_document.github_build.json
}
resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_trust["deploy"].json
}
data "aws_iam_policy_document" "github_deploy" {
  statement {
    actions   = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecs:UpdateService"]
    resources = [for s in aws_ecs_service.this : s.id]
  }
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.this.account_id}:task-definition/${local.name}-migrate:*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = concat([aws_iam_role.execution.arn, aws_iam_role.migrate_execution.arn], [for r in aws_iam_role.task : r.arn])
  }
}
resource "aws_iam_role_policy" "github_deploy" {
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
