#!/usr/bin/env bash
set -Eeuo pipefail

source_dir="/mnt/user/appdata/shelfstream-src"
container_name="shelfstream"
report_file="${source_dir}/.codex-deploy-status.txt"
before_dangling_file="$(mktemp)"
after_dangling_file="$(mktemp)"

cleanup() {
  rm -f -- "${before_dangling_file}" "${after_dangling_file}"
}
trap cleanup EXIT

cd "${source_dir}"
exec > >(tee "${report_file}") 2>&1

old_image="$(docker inspect --format '{{.Image}}' "${container_name}")"
if ! old_server_id="$(docker exec "${container_name}" node -e 'fetch("http://127.0.0.1:3000/.well-known/shelfstream-server").then((response)=>response.json()).then((value)=>process.stdout.write(value.serverId)).catch(()=>process.exit(1))')"; then
  old_server_id="$(docker exec "${container_name}" node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync("/data/shelfstream.sqlite",{readOnly:true}); process.stdout.write(db.prepare("SELECT server_id FROM server_identity WHERE singleton = 1").get().server_id); db.close();')"
fi
docker image ls --filter dangling=true --quiet --no-trunc | sort -u > "${before_dangling_file}"

rollback_tag="shelfstream:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
docker tag "${old_image}" "${rollback_tag}"

printf 'OLD_IMAGE=%s\n' "${old_image}"
printf 'OLD_SERVER_ID=%s\n' "${old_server_id}"
printf 'ROLLBACK_TAG=%s\n' "${rollback_tag}"

docker compose pull
docker compose up -d

health_status="starting"
for _attempt in $(seq 1 60); do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_name}")"
  if [[ "${health_status}" == "healthy" ]]; then
    break
  fi
  if [[ "${health_status}" == "unhealthy" || "${health_status}" == "exited" || "${health_status}" == "dead" ]]; then
    break
  fi
  sleep 2
done

if [[ "${health_status}" != "healthy" ]]; then
  docker logs --tail 100 "${container_name}"
  printf 'DEPLOY_RESULT=failed-health-%s\n' "${health_status}"
  exit 1
fi

new_image="$(docker inspect --format '{{.Image}}' "${container_name}")"
health_json="$(docker exec "${container_name}" node -e 'fetch("http://127.0.0.1:3000/api/health").then((response)=>response.text()).then((value)=>process.stdout.write(value)).catch((error)=>{console.error(error);process.exit(1)})')"
new_server_id="$(docker exec "${container_name}" node -e 'fetch("http://127.0.0.1:3000/.well-known/shelfstream-server").then((response)=>response.json()).then((value)=>process.stdout.write(value.serverId)).catch((error)=>{console.error(error);process.exit(1)})')"
storage_check="$(docker exec "${container_name}" node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync("/data/shelfstream.sqlite",{readOnly:true}); const count=(table)=>db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; const result={integrity:db.prepare("PRAGMA integrity_check").get().integrity_check,schemaVersion:db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,users:count("users"),books:count("books"),progress:count("progress"),bookmarks:count("bookmarks"),highlights:count("highlights"),preferences:count("preferences"),reviews:count("reviews"),profileUsage:count("profile_usage"),readList:count("read_list"),platformAccounts:count("platform_accounts"),registeredServers:count("registered_servers"),memberships:count("server_memberships"),libraries:count("libraries"),invitations:count("server_invitations")}; process.stdout.write(JSON.stringify(result)); db.close();')"

if [[ "${new_image}" == "${old_image}" ]]; then
  docker image rm "${rollback_tag}" >/dev/null
  printf 'DEPLOY_RESULT=already-up-to-date\n'
  exit 0
fi
if [[ "${new_server_id}" != "${old_server_id}" ]]; then
  printf 'DEPLOY_RESULT=failed-server-identity-changed\n'
  exit 1
fi
if [[ "${health_json}" != *'"schemaVersion":4'* ]]; then
  printf 'DEPLOY_RESULT=failed-schema-verification\n'
  exit 1
fi
if [[ "${storage_check}" != *'"integrity":"ok"'* ]]; then
  printf 'DEPLOY_RESULT=failed-integrity-check\n'
  exit 1
fi

docker image ls --filter dangling=true --quiet --no-trunc | sort -u > "${after_dangling_file}"
while IFS= read -r image_id; do
  [[ -n "${image_id}" ]] || continue
  compose_project="$(docker image inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${image_id}" 2>/dev/null || true)"
  if [[ "${compose_project}" == "shelfstream" || "${compose_project}" == "shelfstream-src" ]]; then
    short_id="${image_id#sha256:}"
    docker tag "${image_id}" "shelfstream:retained-${short_id:0:12}"
  fi
done < <(comm -13 "${before_dangling_file}" "${after_dangling_file}")

docker image ls --filter dangling=true --quiet --no-trunc | sort -u > "${after_dangling_file}"
new_dangling_count="$(comm -13 "${before_dangling_file}" "${after_dangling_file}" | sed '/^$/d' | wc -l | tr -d ' ')"

printf 'NEW_IMAGE=%s\n' "${new_image}"
printf 'NEW_SERVER_ID=%s\n' "${new_server_id}"
printf 'HEALTH=%s\n' "${health_json}"
printf 'STORAGE=%s\n' "${storage_check}"
printf 'NEW_DANGLING_IMAGES=%s\n' "${new_dangling_count}"
printf 'DEPLOY_RESULT=success\n'
