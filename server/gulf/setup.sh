#!/bin/sh
# One-shot setup of MediaMTX with real UDP on a small Linux VM near the
# viewers (e.g. Oracle Cloud free tier in Jeddah/Riyadh). Over UDP, WebRTC
# drops a late frame instead of queueing it, so delay stays ~150-300 ms even
# at 1080p — unlike the Railway server, which only has ICE over TCP.
#
#   sudo AUTH_URL='https://<relay>/mtx/auth?key=<MTX_AUTH_KEY>' sh setup.sh
#
# Installs: MediaMTX (WebRTC: UDP 8189, TCP 8189 fallback) behind Caddy, which
# serves HTTPS on <public-ip>.sslip.io with an automatic Let's Encrypt cert.
# Publishing is still checked by the realtime relay (streamer accounts).
# Safe to re-run.
set -eu
: "${AUTH_URL:?set AUTH_URL to the relay /mtx/auth URL with its key}"
MEDIAMTX_VERSION=1.21.2
CADDY_VERSION=2.11.7

case "$(uname -m)" in
  aarch64 | arm64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=amd64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org)}"
DOMAIN="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "== MediaMTX $MEDIAMTX_VERSION ($ARCH)"
M="mediamtx_v${MEDIAMTX_VERSION}_linux_${ARCH}.tar.gz"
curl -fsSLO "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/$M"
curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/checksums.sha256" | grep " $M\$" | sha256sum -c -
tar -xzf "$M" mediamtx
install -m 0755 mediamtx /usr/local/bin/mediamtx

echo "== Caddy $CADDY_VERSION ($ARCH)"
C="caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/$C"
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt" | grep " $C\$" | sha512sum -c -
tar -xzf "$C" caddy
install -m 0755 caddy /usr/local/bin/caddy

echo "== config"
mkdir -p /etc/mediamtx /etc/caddy
cat > /etc/mediamtx/mediamtx.yml <<EOF
# Written by server/gulf/setup.sh — re-run the script instead of editing.
logLevel: info
api: false
metrics: false
pprof: false
playback: false
rtsp: false
rtmp: false
hls: false
srt: false
moq: false

webrtc: true
# Caddy terminates HTTPS in front of this.
webrtcAddress: 127.0.0.1:8889
webrtcAllowOrigins: ["*"]
webrtcTrustedProxies: [127.0.0.1]
webrtcLocalUDPAddress: :8189
# For viewers whose network blocks UDP.
webrtcLocalTCPAddress: :8189
# Cloud VMs only see their private IP; tell clients the public one.
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: [$PUBLIC_IP]
webrtcICEServers2: []

# Streamer accounts live in the realtime relay; watching and voice-lounge
# mics need no account.
authMethod: http
authHTTPAddress: $AUTH_URL
authHTTPExclude:
  - action: read
  - action: playback
  - action: publish
    path: "~^[^/]+-voice-[0-9a-f]{8}\$"

paths:
  all_others:
EOF
chmod 0644 /etc/mediamtx/mediamtx.yml

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:8889
}
EOF

echo "== services"
cat > /etc/systemd/system/mediamtx.service <<'EOF'
[Unit]
Description=MediaMTX (majlis)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml
DynamicUser=yes
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy HTTPS for MediaMTX
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
DynamicUser=yes
StateDirectory=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# Bigger UDP buffers keep 1080p+ WebRTC bursts from being dropped by the kernel.
cat > /etc/sysctl.d/90-webrtc.conf <<'EOF'
net.core.rmem_max=4194304
net.core.wmem_max=4194304
EOF
sysctl -q --system

echo "== firewall"
# Oracle's Ubuntu images reject everything but SSH in iptables (on top of the
# cloud security list), so open HTTP(S) and WebRTC explicitly.
if command -v iptables >/dev/null; then
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443" "-p tcp --dport 8189" "-p udp --dport 8189"; do
    # shellcheck disable=SC2086
    iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 1 $rule -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null; fi
fi

systemctl daemon-reload
systemctl enable --now mediamtx caddy
systemctl restart mediamtx caddy

echo
echo "MediaMTX: https://$DOMAIN   (WHEP: https://$DOMAIN/<room>/whep)"
echo "ICE: udp+tcp $PUBLIC_IP:8189"
