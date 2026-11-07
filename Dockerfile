FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build --workspace web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server
COPY server server
COPY --from=build /app/web/dist web/dist
VOLUME /data
EXPOSE 3001
CMD ["node", "server/src/index.js"]
