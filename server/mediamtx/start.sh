#!/bin/sh
# Fill the config from Railway variables, then start MediaMTX.
#
# Railway's TCP proxy forwards public ICE_HOST:ICE_PORT to container :8189 and
# the public port can't be chosen. ICE candidates must carry the public port,
# so MediaMTX listens on ICE_PORT and socat bridges :8189 to it in-container.
set -eu
: "${ICE_HOST:?set ICE_HOST to the TCP proxy domain}"
: "${ICE_PORT:?set ICE_PORT to the TCP proxy public port}"
: "${AUTH_URL:?set AUTH_URL to the relay /mtx/auth URL with its key}"

sed -e "s|__ICE_HOST__|$ICE_HOST|" \
    -e "s|__ICE_PORT__|$ICE_PORT|" \
    -e "s|__AUTH_URL__|$AUTH_URL|" \
    /mediamtx.tmpl.yml > /tmp/mediamtx.yml

if [ "$ICE_PORT" != 8189 ]; then
  socat TCP-LISTEN:8189,fork,reuseaddr,nodelay TCP:127.0.0.1:"$ICE_PORT",nodelay &
fi
exec /mediamtx /tmp/mediamtx.yml
