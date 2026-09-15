FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY packages ./packages
COPY apps/api ./apps/api
RUN ./node_modules/.bin/esbuild apps/api/server.ts --bundle --platform=node --format=esm --target=node24 --outfile=server.mjs

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
WORKDIR /app
# The bundled service only needs Node; package managers belong in the build stage.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/server.mjs ./server.mjs
COPY docker/entrypoint.mjs ./entrypoint.mjs
ENV NODE_ENV=production
ENV PORT=8787
ENV DATABASE_PATH=/data/elo.sqlite
EXPOSE 8787
# The entrypoint migrates the legacy volume then drops all root privileges
# before importing application code or accepting a connection.
CMD ["node", "entrypoint.mjs"]
