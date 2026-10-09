FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @mynote/server && npm run build -w @mynote/web

FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
