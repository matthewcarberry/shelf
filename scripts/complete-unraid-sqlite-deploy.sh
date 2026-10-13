#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="/mnt/user/appdata/shelfstream-src"
data_dir="/mnt/user/appdata/shelfstream"
container_name="shelfstream"
rollback_container="shelfstream-pre-sqlite-rollback"
rollback_tag="shelfstream:pre-sqlite-rollback"
status_file="${project_dir}/.codex-sqlite-swap-status.txt"
rollback_ready=0

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

rollback_on_error() {
  local exit_code=$?
  set +e
  if [[ "${rollback_ready}" == "1" ]]; then
    if docker container inspect "${container_name}" >/dev/null 2>&1; then
      failed_container="shelfstream-failed-sqlite-$(date +%Y%m%d-%H%M%S)"
      docker stop "${container_name}" >/dev/null 2>&1 || true
      docker rename "${container_name}" "${failed_container}" >/dev/null 2>&1 || true
      echo "Preserved failed replacement as ${failed_container}"
    fi
    docker rename "${rollback_container}" "${container_name}" >/dev/null 2>&1 || true
    docker start "${container_name}" >/dev/null 2>&1 || true
    echo "Restored the pre-SQLite container"
  fi
  echo "deployment=failed exit_code=${exit_code}"
  exit "${exit_code}"
}
trap rollback_on_error ERR

cd "${project_dir}"

if docker container inspect "${rollback_container}" >/dev/null 2>&1; then
  echo "Rollback container already exists; refusing to overwrite it"
  exit 1
fi

old_container_id="$(docker inspect --format '{{.Id}}' "${container_name}")"
old_image="$(docker inspect --format '{{.Image}}' "${container_name}")"
new_image="$(docker image inspect --format '{{.Id}}' shelfstream-src-shelfstream)"
legacy_hash="$(sha256sum "${data_dir}/shelfstream.json" | awk '{print $1}')"
expected_counts="$(docker exec "${container_name}" node -e 'const fs=require("node:fs");const db=JSON.parse(fs.readFileSync("/data/shelfstream.json","utf8"));const flat=(v)=>Object.keys(v||{}).length;const nested=(v)=>Object.values(v||{}).reduce((sum,bucket)=>sum+flat(bucket),0);console.log(JSON.stringify({users:flat(db.users),books:flat(db.books),progress:nested(db.progress),bookmarks:nested(db.bookmarks),highlights:nested(db.highlights),preferences:flat(db.preferences),reviews:nested(db.reviews),mobileTokens:flat(db.mobileTokens),schemaVersion:2,integrity:"ok"}));')"
dangling_before="$(docker image ls -q --filter dangling=true | sort -u | sed '/^$/d' | wc -l | tr -d ' ')"

if [[ "${old_image}" == "${new_image}" ]]; then
  echo "Current container already uses the replacement image"
  exit 1
fi

echo "old_container=${old_container_id}"
echo "old_image=${old_image}"
echo "new_image=${new_image}"
echo "dangling_before=${dangling_before}"
echo "expected_storage=${expected_counts}"

docker tag "${old_image}" "${rollback_tag}"
docker stop "${container_name}" >/dev/null
docker rename "${container_name}" "${rollback_container}"
rollback_ready=1

docker compose up -d --no-build
wait_for_health

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
unauthenticated_books_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:9191/api/books)"
if [[ "${unauthenticated_books_status}" != "401" ]]; then
  echo "Expected unauthenticated /api/books to return 401, received ${unauthenticated_books_status}"
  exit 1
fi

cp "${project_dir}/unraid/my-shelfstream.xml" /boot/config/plugins/dockerMan/templates-user/my-shelfstream.xml
php "${project_dir}/unraid/sync-template-env.php"
chmod 600 /boot/config/plugins/dockerMan/templates-user/my-shelfstream.xml

docker rm "${rollback_container}" >/dev/null
rollback_ready=0
docker image rm "${rollback_tag}" >/dev/null
if docker image inspect "${old_image}" >/dev/null 2>&1; then
  docker image rm "${old_image}" >/dev/null
fi

if docker image inspect "${old_image}" >/dev/null 2>&1; then
  echo "Retired Shelf image still exists"
  exit 1
fi

dangling_after="$(docker image ls -q --filter dangling=true | sort -u | sed '/^$/d' | wc -l | tr -d ' ')"
container_health="$(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' "${container_name}")"
container_image="$(docker inspect --format '{{.Image}}' "${container_name}")"

echo "container_health=${container_health}"
echo "container_image=${container_image}"
echo "dangling_after=${dangling_after}"
echo "storage=${post_restart_storage_json}"
echo "server_id=${restart_server_id}"
echo "legacy_backup_sha256=${automatic_backup_hash}"
echo "unauthenticated_books_status=${unauthenticated_books_status}"
echo "deployment=complete"
