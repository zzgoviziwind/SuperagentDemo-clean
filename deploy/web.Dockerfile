FROM node:22-slim AS build
WORKDIR /web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build
FROM nginx:1.28-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
