# ---- Build the web app ----
FROM node:22.22.0-alpine3.22 AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Server ----
FROM node:22.22.0-alpine3.22
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=99:100 server/src ./src
COPY --chown=99:100 --from=webbuild /web/dist ./web-dist

RUN mkdir -p /data && chown -R 99:100 /data /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV WEB_DIST=/app/web-dist
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000
USER 99:100
CMD ["node", "src/index.js"]
