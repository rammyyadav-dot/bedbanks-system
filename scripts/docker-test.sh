#!/usr/bin/env bash
# Local verification of the container images BEFORE any AWS step (ADR 0040). Needs a running Docker daemon and, for the API, a database.
#
#   scripts/docker-test.sh web admin          # build and smoke-test one portal image (no database needed)
#   scripts/docker-test.sh api                # build the API image, start a throwaway PostgreSQL 16 (pgvector), migrate, boot, probe
#
# Nothing here touches a real database: the API test uses a disposable container and generated credentials. To point the API at your own
# NON-production database instead, export TEST_DATABASE_URL (the strict runtime-role URL) and REDIS_URL before running.
set -euo pipefail
cd "$(dirname "$0")/.."
kind=${1:?usage: docker-test.sh web <admin|agent|supplier|website> | api}
tag=fbeds-test
cleanup() { docker rm -f "$tag-app" "$tag-pg" "$tag-redis" >/dev/null 2>&1 || true; docker network rm "$tag-net" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" && return 0; sleep 1; done
  echo "FAIL: $1 did not answer 200 within $2 s" >&2; docker logs "$tag-app" 2>&1 | tail -30 >&2; return 1
}

if [ "$kind" = web ]; then
  app=${2:?app}
  case "$app" in admin) pkg=@bedbanks/admin-console ;; agent) pkg=@bedbanks/agent-portal ;; supplier) pkg=@bedbanks/supplier-portal ;; website) pkg=@bedbanks/website ;; *) echo "unknown app" >&2; exit 1 ;; esac
  docker build -f Dockerfile.web -t "$tag-$app" \
    --build-arg APP="$app" --build-arg PACKAGE="$pkg" \
    --build-arg API_INTERNAL_URL=https://api.internal.example.test/api/v1 --build-arg AUTH_API_ORIGIN=https://admin.example.test \
    --build-arg SUPPLIER_ORIGIN=https://supplier.example.test --build-arg NEXT_PUBLIC_SITE_URL=https://www.example.test \
    --build-arg NEXT_PUBLIC_AGENT_URL=https://agent.example.test --build-arg NEXT_PUBLIC_ADMIN_URL=https://admin.example.test \
    --build-arg NEXT_PUBLIC_SUPPLIER_URL=https://supplier.example.test --build-arg NEXT_PUBLIC_CONTACT_EMAIL=hello@example.test .
  docker run -d --name "$tag-app" -p 3000:3000 "$tag-$app" >/dev/null
  wait_for http://localhost:3000/api/health 40
  echo "PASS health: $(curl -fsS http://localhost:3000/api/health)"
  user=$(docker exec "$tag-app" id -un); [ "$user" = node ] && echo "PASS runs as non-root ($user)" || { echo "FAIL runs as $user" >&2; exit 1; }
  csp=$(curl -fsSI http://localhost:3000/api/health | grep -ic 'x-content-type-options' || true); echo "headers present: $csp"
  echo "OK: $app image starts, answers the load balancer probe and runs unprivileged"
  exit 0
fi

# ---- API ----
docker build -f Dockerfile.api -t "$tag-api" .
docker network create "$tag-net" >/dev/null
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  pw=$(openssl rand -hex 16)
  docker run -d --name "$tag-pg" --network "$tag-net" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=fbeds_ci pgvector/pgvector:pg16 >/dev/null
  for _ in $(seq 1 30); do docker exec "$tag-pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  owner="postgresql://postgres:$pw@$tag-pg:5432/fbeds_ci?schema=public"
  # Owner-run steps, exactly as in docs/runbooks/api-deploy.md: migrate, then provision the strict runtime role.
  docker run --rm --network "$tag-net" -e DATABASE_URL="$owner" "$tag-api" pnpm --filter @bedbanks/api prisma:migrate:deploy
  rt=$(openssl rand -hex 20)
  docker run --rm --network "$tag-net" -e PROVISION_DATABASE_URL="$owner" -e API_RUNTIME_LOGIN_PASSWORD="$rt" "$tag-api" pnpm --filter @bedbanks/api ops:provision-api-runtime-role >/dev/null
  TEST_DATABASE_URL="postgresql://fbeds_api_login:$rt@$tag-pg:5432/fbeds_ci?schema=public"
fi
docker run -d --name "$tag-redis" --network "$tag-net" redis:7-alpine >/dev/null
docker run -d --name "$tag-app" --network "$tag-net" -p 3002:3002 \
  -e DATABASE_URL="$TEST_DATABASE_URL" -e REDIS_URL="${REDIS_URL:-redis://$tag-redis:6379}" \
  -e ADMIN_ORIGIN=http://localhost:3001 -e AUTH_COOKIE_SECURE=false "$tag-api" >/dev/null
wait_for http://localhost:3002/api/v1/health 90
wait_for http://localhost:3002/api/v1/health/ready 30
echo "PASS health:  $(curl -fsS http://localhost:3002/api/v1/health)"
echo "PASS ready:   $(curl -fsS http://localhost:3002/api/v1/health/ready)"
user=$(docker exec "$tag-app" id -un); [ "$user" = node ] && echo "PASS runs as non-root ($user)" || { echo "FAIL runs as $user" >&2; exit 1; }
# Prisma engine present for the image's OS/openssl, and the app is NOT connected as the table owner (it would bypass row-level security).
who=$(docker exec "$tag-app" sh -c 'node -e "const u=new URL(process.env.DATABASE_URL);console.log(u.username)"')
[ "$who" = fbeds_api_login ] && echo "PASS runtime database login is $who (not the owner)" || echo "WARN runtime login is $who: use the strict role outside this test"
echo "OK: API image boots, reaches PostgreSQL and Redis, and reports ready"
