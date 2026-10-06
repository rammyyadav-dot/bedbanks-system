resource "aws_ecr_repository" "this" {
  for_each             = local.services
  name                 = "fbeds/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a tag is a commit SHA; it can never be repointed
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}
resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({ rules = [{
    rulePriority = 1, description = "keep the last 40 images",
    selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 40 }, action = { type = "expire" }
  }] })
}
