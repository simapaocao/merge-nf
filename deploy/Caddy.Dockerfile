# syntax=docker/dockerfile:1.7
FROM caddy:2.10.2-alpine

USER root
# Low ports are not needed: compose.public.yaml maps 80/443 to 8080/8443.
# Preparing ownership in the image also initializes fresh Docker named volumes.
# Remove the base image's low-port file capability before dropping all capabilities.
RUN setcap -r /usr/bin/caddy \
    && addgroup -S -g 10001 hubproxy \
    && adduser -S -D -H -u 10001 -G hubproxy hubproxy \
    && mkdir -p /data/caddy /config/caddy \
    && chown -R 10001:10001 /data /config \
    && chmod 0700 /data /data/caddy /config /config/caddy

USER 10001:10001
