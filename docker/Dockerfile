FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
RUN npm ci --ignore-scripts
RUN npm run generate:catalog
RUN npm run build
RUN mkdir -p dist/web
# The runtime does not require the optional web console. Provider icon fetching
# can be unavailable in restricted build environments, so keep the API image
# buildable without those remote assets.
RUN npm run build --workspace web || true

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OOMOL_CONNECT_DATA_DIR=/app/data
COPY package.json package-lock.json ./
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY scripts/runtime-data.ts ./scripts/runtime-data.ts
COPY migrations ./migrations
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/open-connector
RUN mkdir -p /opt/application && printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/open-connector serve' > /opt/application/run.sh && chmod 755 /opt/application/run.sh

RUN npm ci --omit=dev --ignore-scripts
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/open-connector"]
CMD ["serve"]
