# CloudFront + WAF edge (ADR 0055, WP3 phase 4). Off by default (staging keeps WAF-on-ALB behind an allow-listed security group);
# REQUIRED for production unless production_edge_exception_ref records an approved alternative.
#
# Origin protection is layered so no single copied secret opens the ALB:
#   1. network   - the public ALB security group admits ONLY the CloudFront origin-facing managed prefix list (no 0.0.0.0/0 on 443);
#   2. identity  - the ALB listener rules forward only requests carrying X-Origin-Verify with one of two rotating secrets, otherwise 403;
#   3. edge      - the CLOUDFRONT-scope web ACL (managed rules, rate limits, staging IP allow-list) runs before the origin is reached;
#   4. regional  - the existing REGIONAL web ACL stays on the ALB.
# The prefix list is shared by every CloudFront customer, so (1) alone does not stop another account's distribution; (2) does.
# One distribution per portal host keeps cache keys isolated between apps that serve identical paths such as /_next/static/*.
# The API is NOT behind CloudFront: it is only on the internal ALB, reached server-side by the portals.

locals {
  edge   = var.cloudfront_enabled
  cf_set = local.edge ? local.portals : {}
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = local.edge ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}
data "aws_cloudfront_cache_policy" "disabled" {
  count = local.edge ? 1 : 0
  name  = "Managed-CachingDisabled"
}
data "aws_cloudfront_cache_policy" "optimized" {
  count = local.edge ? 1 : 0
  name  = "Managed-CachingOptimized"
}
# Forwards every viewer header (including Host, which the ALB uses for host-based routing and the certificate match), cookies and query strings.
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.edge ? 1 : 0
  name  = "Managed-AllViewer"
}

# ---- origin verification secrets (two slots so rotation has no gap) ----
resource "random_password" "origin_verify" {
  for_each = local.edge ? toset(["a", "b"]) : toset([])
  length   = 48
  special  = false
  keepers  = { rotation = var.origin_verify_rotation_id[each.key] }
}

# ---- viewer certificate (must be in us-east-1). Its DNS validation records are the same names as the regional certificate's. ----
resource "aws_acm_certificate" "edge" {
  provider                  = aws.us_east_1
  count                     = local.edge ? 1 : 0
  domain_name               = values(local.portals)[0].host
  subject_alternative_names = slice([for p in values(local.portals) : p.host], 1, length(local.portals))
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_acm_certificate_validation" "edge" {
  provider                = aws.us_east_1
  count                   = local.edge ? 1 : 0
  certificate_arn         = aws_acm_certificate.edge[0].arn
  validation_record_fqdns = [for o in aws_acm_certificate.edge[0].domain_validation_options : o.resource_record_name]
  depends_on              = [aws_route53_record.validation]
}

# ---- CLOUDFRONT-scope WAF (us-east-1) ----
resource "aws_wafv2_ip_set" "staging_allow" {
  provider           = aws.us_east_1
  count              = local.edge && var.environment == "staging" ? 1 : 0
  name               = "${local.name}-staging-allow"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = var.public_ingress_cidrs
}
resource "aws_wafv2_web_acl" "edge" {
  provider = aws.us_east_1
  count    = local.edge ? 1 : 0
  name     = "${local.name}-edge"
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-edge"
    sampled_requests_enabled   = true
  }

  # Staging stays access-restricted at the edge: anything outside the allow-list is blocked before it can reach the origin.
  dynamic "rule" {
    for_each = var.environment == "staging" ? [1] : []
    content {
      name     = "staging-ip-allow-list"
      priority = 1
      action {
        block {}
      }
      statement {
        not_statement {
          statement {
            ip_set_reference_statement { arn = aws_wafv2_ip_set.staging_allow[0].arn }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "staging-ip-allow-list"
        sampled_requests_enabled   = true
      }
    }
  }
  rule {
    name     = "aws-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "aws-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-bad-inputs"
      sampled_requests_enabled   = true
    }
  }
  # Credential-stuffing brake on the authentication endpoints, far below the general limit.
  rule {
    name     = "rate-limit-auth"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 100 # requests per 5 minutes per source IP
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/v1/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-auth"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "rate-limit"
    priority = 40
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }
}

# WAF logs for the CloudFront ACL: the log group, its key and its delivery policy must all be in us-east-1.
data "aws_iam_policy_document" "kms_edge_logs" {
  count = local.edge ? 1 : 0
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
      identifiers = ["logs.us-east-1.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:us-east-1:${data.aws_caller_identity.this.account_id}:*"]
    }
  }
}
resource "aws_kms_key" "edge_logs" {
  provider                = aws.us_east_1
  count                   = local.edge ? 1 : 0
  description             = "${local.name} edge WAF logs (us-east-1)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms_edge_logs[0].json
}
resource "aws_cloudwatch_log_group" "waf_edge" {
  provider          = aws.us_east_1
  count             = local.edge ? 1 : 0
  name              = "aws-waf-logs-${local.name}-edge"
  retention_in_days = local.retention.waf
  kms_key_id        = aws_kms_key.edge_logs[0].arn
  tags              = { Service = "edge" }
}
data "aws_iam_policy_document" "waf_edge_logs_delivery" {
  count = local.edge ? 1 : 0
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.waf_edge[0].arn}:*"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:us-east-1:${data.aws_caller_identity.this.account_id}:*"]
    }
  }
}
resource "aws_cloudwatch_log_resource_policy" "waf_edge" {
  provider        = aws.us_east_1
  count           = local.edge ? 1 : 0
  policy_name     = "${local.name}-waf-edge-logs"
  policy_document = data.aws_iam_policy_document.waf_edge_logs_delivery[0].json
}
resource "aws_wafv2_web_acl_logging_configuration" "edge" {
  provider                = aws.us_east_1
  count                   = local.edge ? 1 : 0
  resource_arn            = aws_wafv2_web_acl.edge[0].arn
  log_destination_configs = [aws_cloudwatch_log_group.waf_edge[0].arn]
  redacted_fields {
    single_header { name = "authorization" }
  }
  redacted_fields {
    single_header { name = "cookie" }
  }
  logging_filter {
    default_behavior = "DROP"
    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"
      condition {
        action_condition { action = "BLOCK" }
      }
      condition {
        action_condition { action = "COUNT" }
      }
    }
  }
  depends_on = [aws_cloudwatch_log_resource_policy.waf_edge]
}

# ---- baseline security headers added at the edge ----
# override = false everywhere: a header the application already sets (Admin and the website send CSP/HSTS/frame headers) always wins, so the edge only
# fills the gap for apps that send none (Agent, Supplier). No CSP here: it is application-specific and must not be applied blindly.
resource "aws_cloudfront_response_headers_policy" "baseline" {
  count   = local.edge ? 1 : 0
  name    = "${local.name}-baseline-security-headers"
  comment = "Fills missing baseline security headers; never overrides the application"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = false
    }
    content_type_options {
      override = false
    }
    frame_options {
      frame_option = "DENY"
      override     = false
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = false
    }
  }
}

# ---- distributions ----
resource "aws_cloudfront_distribution" "portal" {
  for_each        = local.cf_set
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.cloudfront_price_class
  aliases         = [each.value.host]
  comment         = "${local.name} ${each.key}"
  web_acl_id      = aws_wafv2_web_acl.edge[0].arn
  tags            = { Service = each.key }

  origin {
    domain_name = aws_lb.public.dns_name
    origin_id   = "alb"
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify[var.origin_verify_active_slot].result
    }
  }

  # DEFAULT: never cached. HTML, server actions, login, search, rate rechecks and every mutation can be personalised or tenant-specific.
  default_cache_behavior {
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.baseline[0].id
  }
  # API calls (auth, hotel search, rate rechecks, bookings, finance): explicit no-cache so a future change to the default cannot cache them.
  ordered_cache_behavior {
    path_pattern               = "/api/v1/*"
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.baseline[0].id
  }
  # The only cached path: content-hashed, immutable build assets. Same for every user; the cache key ignores cookies and query strings.
  ordered_cache_behavior {
    path_pattern               = "/_next/static/*"
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized[0].id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.baseline[0].id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.edge[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
