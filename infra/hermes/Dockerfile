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
COPY infra/hermes/runtime/error_projection.py /opt/hermes/core_agent_error_projection.py
COPY infra/hermes/runtime/install_error_projection.py /opt/core-agent/install_error_projection.py
COPY infra/hermes/patches/v2026.7.30-gateway-error-projection.patch /opt/core-agent/v2026.7.30-gateway-error-projection.patch

RUN python3 /opt/core-agent/install_error_projection.py

RUN chmod 0755 /etc/hermes \
    && chmod 0644 /etc/hermes/config.yaml \
    && install -d -m 01777 -o root -g root /opt/data \
    && chown root:root /opt/core-agent/initialize.py /opt/core-agent/gateway-entrypoint.sh \
    && chmod 0555 /opt/core-agent/initialize.py /opt/core-agent/gateway-entrypoint.sh \
    && chown root:root \
        /opt/core-agent/install_error_projection.py \
        /opt/core-agent/v2026.7.30-gateway-error-projection.patch \
        /opt/hermes/core_agent_error_projection.py \
    && chmod 0555 /opt/core-agent/install_error_projection.py \
    && chmod 0444 \
        /opt/core-agent/v2026.7.30-gateway-error-projection.patch \
        /opt/hermes/core_agent_error_projection.py

ENV API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    GATEWAY_MULTIPLEX_PROFILES=true

USER hermes

ENTRYPOINT ["/opt/core-agent/gateway-entrypoint.sh"]
