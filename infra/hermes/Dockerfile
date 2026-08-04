# syntax=docker/dockerfile:1.7

ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE}

LABEL org.opencontainers.image.title="Core-Agent Hermes Runtime"
LABEL org.opencontainers.image.description="Pinned Hermes runtime distribution for Core-Agent"
LABEL org.opencontainers.image.vendor="Core-Agent"

USER root

COPY infra/hermes/managed/config.yaml /etc/hermes/config.yaml
COPY infra/hermes/runtime/initialize.py /opt/core-agent/initialize.py
COPY infra/hermes/runtime/gateway-entrypoint.sh /opt/core-agent/gateway-entrypoint.sh

RUN chmod 0755 /etc/hermes \
    && chmod 0644 /etc/hermes/config.yaml \
    && chown root:root /opt/core-agent/initialize.py /opt/core-agent/gateway-entrypoint.sh \
    && chmod 0555 /opt/core-agent/initialize.py /opt/core-agent/gateway-entrypoint.sh

ENV API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    GATEWAY_MULTIPLEX_PROFILES=true

USER hermes

ENTRYPOINT ["/opt/core-agent/gateway-entrypoint.sh"]
