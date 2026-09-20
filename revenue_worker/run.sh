#!/usr/bin/with-contenv bashio
set -e

export B360_ENABLED="$(bashio::config 'enabled')"
export B360_BACKEND_BASE="$(bashio::config 'backend_base')"
export B360_WORKER_TOKEN="$(bashio::config 'worker_token')"
export B360_HEADLESS="$(bashio::config 'headless')"
export B360_LEASE_SECONDS="$(bashio::config 'lease_seconds')"
export B360_CLAIM_RETRY_SECONDS="$(bashio::config 'claim_retry_seconds')"
export B360_NAVIGATION_TIMEOUT_SECONDS="$(bashio::config 'navigation_timeout_seconds')"
export B360_READER_DEADLINE_SECONDS="$(bashio::config 'reader_deadline_seconds')"
export B360_LOCALE="$(bashio::config 'locale')"
export B360_TIMEZONE="$(bashio::config 'timezone')"
export B360_DEBUG="$(bashio::config 'debug')"

mkdir -p /data/chromium

exec node /app/worker.js
