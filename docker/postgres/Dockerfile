FROM pgvector/pgvector:0.8.6-pg18-trixie

# Keep PostgreSQL and pgvector unchanged; add the matching Debian extension package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && arch="$(dpkg --print-architecture)" \
    && curl --fail --location --retry 3 \
      "https://github.com/paradedb/paradedb/releases/download/v0.26.1/postgresql-18-pg-search_0.26.1-1PARADEDB-trixie_${arch}.deb" \
      --output /tmp/pg_search.deb \
    && apt-get install -y --no-install-recommends /tmp/pg_search.deb \
    && rm -f /tmp/pg_search.deb \
    && rm -rf /var/lib/apt/lists/*
