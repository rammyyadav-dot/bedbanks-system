# One certificate per name set, validated in the existing public zone. The API name is internal-only: its record lives in a PRIVATE zone,
# but a public certificate can still be issued for it (validation happens in the public zone).
resource "aws_acm_certificate" "portals" {
  domain_name               = values(local.portals)[0].host
  subject_alternative_names = slice([for p in values(local.portals) : p.host], 1, length(local.portals))
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_acm_certificate" "api" {
  domain_name       = local.api_host
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_route53_record" "validation" {
  for_each = { for o in concat(tolist(aws_acm_certificate.portals.domain_validation_options), tolist(aws_acm_certificate.api.domain_validation_options)) : o.resource_record_name => o... }
  zone_id         = var.hosted_zone_id
  name            = each.key
  type            = each.value[0].resource_record_type
  records         = [each.value[0].resource_record_value]
  ttl             = 60
  allow_overwrite = true
}
resource "aws_acm_certificate_validation" "portals" {
  certificate_arn         = aws_acm_certificate.portals.arn
  validation_record_fqdns = [for o in aws_acm_certificate.portals.domain_validation_options : o.resource_record_name]
  depends_on              = [aws_route53_record.validation]
}
resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for o in aws_acm_certificate.api.domain_validation_options : o.resource_record_name]
  depends_on              = [aws_route53_record.validation]
}

# Portal names point at the public ALB. NOT created for production until cutover is authorised: set `create_portal_records = true` then.
variable "create_portal_records" {
  type        = bool
  default     = false
  description = "Create the public DNS records. Leave false until the cutover step in the runbook; the ALB is reachable by its AWS name for verification."
}
resource "aws_route53_record" "portal" {
  for_each = var.create_portal_records ? local.portals : {}
  zone_id  = var.hosted_zone_id
  name     = each.value.host
  type     = "A"
  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_zone" "internal" {
  name = "internal.${var.environment}.${var.domain_name}"
  vpc { vpc_id = aws_vpc.this.id }
}
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.internal.zone_id
  name    = local.api_host
  type    = "A"
  alias {
    name                   = aws_lb.internal.dns_name
    zone_id                = aws_lb.internal.zone_id
    evaluate_target_health = true
  }
}
