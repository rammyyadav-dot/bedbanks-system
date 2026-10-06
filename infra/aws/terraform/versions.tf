terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  # State is remote and locked; create the bucket and lock table out of band (docs/runbooks/aws-ecs-deployment.md, step 1).
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "fbeds", Environment = var.environment, ManagedBy = "terraform" } }
}
