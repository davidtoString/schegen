#!/bin/sh
# Rebuild and restart Schematic, but only once no crawl, generation or publish is running:
# a restart mid-operation marks that run "interrupted".
set -e
cd "$(dirname "$0")/.."
docker compose -f compose.host.yaml build
busy() {
  docker exec schematic node -e 'const d=require("/app/data/workspace.json");const r=d.runs.filter(r=>["discovering","crawling","generating","publishing"].includes(r.status));if(r.length){console.log(r.map(x=>x.id.slice(0,8)+" "+x.status).join(", "));process.exit(1)}' 2>/dev/null
}
waited=0
until busy >/dev/null; do
  [ "$waited" -eq 0 ] && echo "Waiting for running operations to finish: $(busy || true)"
  waited=$((waited + 10)); [ "$waited" -ge 1800 ] && { echo "Still busy after 30 minutes; not deploying." >&2; exit 1; }
  sleep 10
done
docker compose -f compose.host.yaml up -d
