# ---- Build the web app ----
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---- Server ----
FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/src ./src
COPY --from=webbuild /web/dist ./web-dist

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV WEB_DIST=/app/web-dist
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/index.js"]
