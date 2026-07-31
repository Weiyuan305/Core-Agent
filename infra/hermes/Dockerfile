# syntax=docker/dockerfile:1.7

ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE}

LABEL org.opencontainers.image.title="Core-Agent Hermes Runtime"
LABEL org.opencontainers.image.description="Pinned Hermes runtime distribution for Core-Agent"
LABEL org.opencontainers.image.vendor="Core-Agent"

USER root

COPY infra/hermes/managed/config.yaml /etc/hermes/config.yaml

RUN chmod 0755 /etc/hermes \
    && chmod 0644 /etc/hermes/config.yaml
