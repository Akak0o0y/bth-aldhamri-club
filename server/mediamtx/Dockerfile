# Official MediaMTX binary on Alpine, plus socat for the ICE-TCP port bridge
# (see start.sh). Deploy: `railway up -s mediamtx` from this folder.
FROM bluenviron/mediamtx:1.21.2 AS mediamtx

FROM alpine:3.20
RUN apk add --no-cache socat
COPY --from=mediamtx /mediamtx /mediamtx
COPY mediamtx.yml /mediamtx.tmpl.yml
COPY start.sh /start.sh
EXPOSE 8889 8189
CMD ["/bin/sh", "/start.sh"]
