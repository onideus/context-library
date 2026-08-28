# context-library blast container — consumer of blast-base.
#
# The containment boundary (default-deny egress, non-root user, credentials in a
# named volume, no Docker socket) is inherited from the base image and is not
# re-implemented here. See ../.devcontainer/BLAST-SETUP.md and the base repo's
# BLAST-CONTRACT.md.
#
# This layer adds only what context-library development needs beyond Node.
ARG BLAST_BASE=ghcr.io/onideus/blast-base:0.1.0
FROM ${BLAST_BASE}

# Consumed so the TZ build arg the compose file passes actually takes effect in
# this layer; the base's own ARG TZ was resolved when the base image was built.
ARG TZ
ENV TZ="$TZ"

USER root
# psql/pg_isready for inspecting the test sidecar from inside. Nothing else.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
USER node
