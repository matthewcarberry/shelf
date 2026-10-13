#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="/mnt/user/appdata/shelfstream-src"
data_dir="/mnt/user/appdata/shelfstream"
container_name="shelfstream"
status_file="${project_dir}/.codex-sqlite-deploy-status.txt"

exec > >(tee "${status_file}") 2>&1

wait_for_health() {
  local attempt state
  for attempt in $(seq 1 90); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_name}" 2>/dev/null || true)"
    if [[ "${state}" == "healthy" ]]; then
      return 0
    fi
    if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
      echo "Container entered ${state} state"
      docker logs --tail 80 "${container_name}" || true
      return 1
    fi
    sleep 2
  done
  echo "Timed out waiting for ${container_name} health"
  docker logs --tail 80 "${container_name}" || true
  return 1
}

extract_json_string() {
  local json="$1" key="$2"
  printf '%s' "${json}" | sed -n "s/.*\"${key}\":\"\([^\"]*\)\".*/\1/p"
}

cd "${project_dir}"

if [[ -f "${data_dir}/shelfstream.sqlite" ]]; then
  echo "ShelfStream is already using SQLite; this one-time migration script will not run again."
  exit 1
fi

old_image="$(docker inspect --format '{{.Image}}' "${container_name}")"
before_dangling="$(docker image ls -q --filter dangling=true --filter label=com.docker.compose.project=shelfstream-src --filter label=com.docker.compose.service=shelfstream | sort -u | sed '/^$/d' | wc -l | tr -d ' ')"
legacy_hash="$(sha256sum "${data_dir}/shelfstream.json" | awk '{print $1}')"
expected_counts="$(docker exec "${container_name}" node -e 'const fs=require("node:fs");const db=JSON.parse(fs.readFileSync("/data/shelfstream.json","utf8"));const flat=(v)=>Object.keys(v||{}).length;const nested=(v)=>Object.values(v||{}).reduce((sum,bucket)=>sum+flat(bucket),0);console.log(JSON.stringify({users:flat(db.users),books:flat(db.books),progress:nested(db.progress),bookmarks:nested(db.bookmarks),highlights:nested(db.highlights),preferences:flat(db.preferences),reviews:nested(db.reviews),mobileTokens:flat(db.mobileTokens),schemaVersion:2,integrity:"ok"}));')"

echo "old_image=${old_image}"
echo "shelfstream_dangling_before=${before_dangling}"
echo "legacy_json_sha256=${legacy_hash}"
echo "expected_storage=${expected_counts}"

docker compose up -d --build
wait_for_health

new_image="$(docker inspect --format '{{.Image}}' "${container_name}")"
storage_json="$(docker exec -e EXPECTED_STORAGE_COUNTS="${expected_counts}" "${container_name}" node server/storage-status.js)"
health_json="$(curl --fail --silent --show-error http://127.0.0.1:9191/api/health)"
identity_json="$(curl --fail --silent --show-error http://127.0.0.1:9191/.well-known/shelfstream-server)"
storage_server_id="$(extract_json_string "${storage_json}" serverId)"
health_server_id="$(extract_json_string "${health_json}" serverId)"
identity_server_id="$(extract_json_string "${identity_json}" serverId)"

if [[ -z "${storage_server_id}" || "${storage_server_id}" != "${health_server_id}" || "${storage_server_id}" != "${identity_server_id}" ]]; then
  echo "Server identity mismatch before restart"
  exit 1
fi

automatic_backup_hash="$(sha256sum "${data_dir}/shelfstream.json.pre-sqlite-backup" | awk '{print $1}')"
if [[ "${automatic_backup_hash}" != "${legacy_hash}" ]]; then
  echo "Automatic legacy backup hash does not match the source JSON"
  exit 1
fi

docker restart "${container_name}" >/dev/null
wait_for_health

restart_identity_json="$(curl --fail --silent --show-error http://127.0.0.1:9191/.well-known/shelfstream-server)"
restart_server_id="$(extract_json_string "${restart_identity_json}" serverId)"
if [[ "${restart_server_id}" != "${storage_server_id}" ]]; then
  echo "Server identity changed after restart"
  exit 1
fi

post_restart_storage_json="$(docker exec -e EXPECTED_STORAGE_COUNTS="${expected_counts}" "${container_name}" node server/storage-status.js)"

cp "${project_dir}/unraid/my-shelfstream.xml" /boot/config/plugins/dockerMan/templates-user/my-shelfstream.xml
php "${project_dir}/unraid/sync-template-env.php"
chmod 600 /boot/config/plugins/dockerMan/templates-user/my-shelfstream.xml

if [[ "${old_image}" != "${new_image}" ]]; then
  docker image rm "${old_image}"
fi

after_dangling="$(docker image ls -q --filter dangling=true --filter label=com.docker.compose.project=shelfstream-src --filter label=com.docker.compose.service=shelfstream | sort -u | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "${after_dangling}" != "${before_dangling}" ]]; then
  echo "ShelfStream dangling image count changed: before=${before_dangling} after=${after_dangling}"
  exit 1
fi

echo "new_image=${new_image}"
echo "shelfstream_dangling_after=${after_dangling}"
echo "storage=${post_restart_storage_json}"
echo "server_id=${restart_server_id}"
echo "legacy_backup_sha256=${automatic_backup_hash}"
echo "deployment=complete"
