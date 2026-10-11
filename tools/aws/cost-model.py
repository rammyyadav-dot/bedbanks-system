#!/usr/bin/env python3
"""fBeds AWS monthly cost model (WP2). Pure arithmetic, no AWS access.

PRICES ARE UNVERIFIED PLACEHOLDERS: us-east-1 list prices recalled from memory, NOT ap-south-1 and NOT from the AWS Pricing Calculator.
Replace every value in PRICES (or pass --uplift for a flat regional factor) with the Calculator's figures before any budget is approved.
Usage: python3 tools/aws/cost-model.py [--uplift 1.0] [--markdown]
"""
import argparse

H = 730  # hours per month
PRICES = {
    "fargate_vcpu_h": 0.04048, "fargate_gb_h": 0.004445,
    "nat_h": 0.045, "nat_gb": 0.045,
    "alb_h": 0.0225, "alb_lcu_h": 0.008,
    "rds_h": {"db.t4g.medium": 0.065, "db.m7g.large": 0.168, "db.r7g.xlarge": 0.58},
    "rds_gb_mo": 0.115,
    "redis_h": {"cache.t4g.small": 0.032, "cache.r7g.large": 0.21},
    "waf_acl_mo": 5.0, "waf_rule_mo": 1.0, "waf_m_req": 0.60,
    "cf_gb": 0.085, "cf_m_req": 0.01,
    "logs_gb": 0.50, "logs_store_gb": 0.03,
    "vpce_h": 0.01, "kms_key_mo": 1.0, "secret_mo": 0.40,
}

def scenario(name, *, azs, nats, nat_gb, albs, lcu, tasks, rds, rds_multi_az, rds_gb, replicas, redis, redis_nodes,
             waf_rules, waf_m_req, cf_gb, cf_m_req, logs_gb, vpce, secrets):
    p = PRICES
    lines = {}
    lines["Fargate tasks"] = sum(n * (c * p["fargate_vcpu_h"] + m * p["fargate_gb_h"]) * H for n, c, m in tasks)
    lines["NAT gateways (hourly + data)"] = nats * p["nat_h"] * H + nat_gb * p["nat_gb"]
    lines["Load balancers"] = albs * (p["alb_h"] + lcu * p["alb_lcu_h"]) * H
    inst = p["rds_h"][rds] * H * (2 if rds_multi_az else 1) * (1 + replicas)
    lines["RDS (instances + storage)"] = inst + rds_gb * p["rds_gb_mo"] * (2 if rds_multi_az else 1) * (1 + replicas)
    lines["ElastiCache Redis"] = p["redis_h"][redis] * H * redis_nodes
    lines["WAF"] = p["waf_acl_mo"] + waf_rules * p["waf_rule_mo"] + waf_m_req * p["waf_m_req"]
    lines["CloudFront (not implemented yet)"] = cf_gb * p["cf_gb"] + cf_m_req * p["cf_m_req"]
    lines["CloudWatch logs"] = logs_gb * (p["logs_gb"] + p["logs_store_gb"])
    lines["Interface VPC endpoints"] = vpce * azs * p["vpce_h"] * H
    lines["KMS + Secrets Manager"] = 2 * p["kms_key_mo"] + secrets * p["secret_mo"]
    return name, lines

W = (0.5, 1)  # portal task: vCPU, GB
SCENARIOS = [
    scenario("A. Lean development / staging (staging.tfvars.example)", azs=2, nats=1, nat_gb=100, albs=2, lcu=1,
             tasks=[(1, 1, 2), (4, *W)], rds="db.t4g.medium", rds_multi_az=False, rds_gb=100, replicas=0,
             redis="cache.t4g.small", redis_nodes=1, waf_rules=3, waf_m_req=1, cf_gb=0, cf_m_req=0, logs_gb=10, vpce=0, secrets=4),
    scenario("B. MVP production (production.tfvars.example defaults + CloudFront)", azs=2, nats=2, nat_gb=500, albs=2, lcu=3,
             tasks=[(2, 1, 2), (8, *W)], rds="db.m7g.large", rds_multi_az=True, rds_gb=100, replicas=0,
             redis="cache.t4g.small", redis_nodes=2, waf_rules=3, waf_m_req=20, cf_gb=500, cf_m_req=20, logs_gb=50, vpce=0, secrets=4),
    scenario("C. Enterprise high availability (3 AZ, replica, interface endpoints)", azs=3, nats=3, nat_gb=5000, albs=2, lcu=15,
             tasks=[(6, 2, 4), (12, 1, 2)], rds="db.r7g.xlarge", rds_multi_az=True, rds_gb=500, replicas=1,
             redis="cache.r7g.large", redis_nodes=3, waf_rules=8, waf_m_req=200, cf_gb=5000, cf_m_req=200, logs_gb=500, vpce=4, secrets=8),
]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--uplift", type=float, default=1.0); ap.add_argument("--markdown", action="store_true")
    a = ap.parse_args()
    for name, lines in SCENARIOS:
        total = sum(lines.values()) * a.uplift
        if a.markdown:
            print(f"\n### {name}\n\n| Component | USD / month |\n|---|---:|")
            for k, v in lines.items(): print(f"| {k} | {v * a.uplift:,.0f} |")
            print(f"| **Total** | **{total:,.0f}** |")
        else:
            print(name); [print(f"  {k:40s}{v * a.uplift:10,.0f}") for k, v in lines.items()]; print(f"  {'TOTAL':40s}{total:10,.0f}")

if __name__ == "__main__":
    main()
