# ---- public ALB: the four portals, host-based routing ----
resource "aws_lb" "public" {
  name                       = "${local.name}-public"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb_public.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"
  idle_timeout               = 60
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.portals.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}
resource "aws_lb_target_group" "portal" {
  for_each             = local.portals
  name                 = "${local.name}-${each.key}"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30
  health_check {
    path                = each.value.check
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
  }
}
resource "aws_lb_listener_rule" "portal" {
  for_each     = local.portals
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.portal[each.key].arn
  }
  condition {
    host_header { values = [each.value.host] }
  }
}

# ---- internal ALB: the API, reachable only from the portals (server-side /api/v1 proxy). Browsers never reach it. ----
resource "aws_lb" "internal" {
  name                       = "${local.name}-internal"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb_internal.id]
  subnets                    = aws_subnet.private[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"
  idle_timeout               = 120 # supplier-backed searches can be slow
}
resource "aws_lb_listener" "internal_https" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api"
  port                 = 3002
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 60
  health_check {
    path                = "/api/v1/health/ready" # 503 when the database or a required dependency is down, so such a task is taken out of rotation
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
  }
}

# ---- WAF on the public ALB: AWS managed rules plus a per-IP rate limit (the website lead limiter is in-memory and best effort) ----
resource "aws_wafv2_web_acl" "public" {
  name  = "${local.name}-public"
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-public"
    sampled_requests_enabled   = true
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
  rule {
    name     = "rate-limit"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000 # requests per 5 minutes per source IP
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
resource "aws_wafv2_web_acl_association" "public" {
  resource_arn = aws_lb.public.arn
  web_acl_arn  = aws_wafv2_web_acl.public.arn
}
