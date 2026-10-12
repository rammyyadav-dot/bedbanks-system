terraform {
  required_version = ">= 1.9"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State is remote and locked; create the bucket and lock table out of band (docs/runbooks/aws-ecs-deployment.md, step 1).
  # Encryption is part of the code, not a flag someone must remember at init. Bucket, key, region and lock table are passed with -backend-config.
  backend "s3" {
    encrypt = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "fbeds", Environment = var.environment, Service = "shared", ManagedBy = "terraform", Owner = var.cost_owner, CostCenter = var.cost_center } }
}

# CloudFront certificates and CLOUDFRONT-scope WAF must live in us-east-1 whatever the primary region is (ADR 0055).
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags { tags = { Project = "fbeds", Environment = var.environment, Service = "shared", ManagedBy = "terraform", Owner = var.cost_owner, CostCenter = var.cost_center } }
}
