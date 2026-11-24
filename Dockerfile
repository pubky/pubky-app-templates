FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY basic-pubky-app/package.json basic-pubky-app/package-lock.json ./basic-pubky-app/
COPY vite-starter/package.json vite-starter/package-lock.json ./vite-starter/
RUN npm --prefix basic-pubky-app ci && npm --prefix vite-starter ci

COPY basic-pubky-app ./basic-pubky-app
COPY vite-starter ./vite-starter
COPY pages ./pages

RUN VITE_PUBKY_TESTNET=false npm --prefix basic-pubky-app run build -- --base ./ --outDir dist/mainnet \
    && VITE_PUBKY_TESTNET=true VITE_PUBKY_STORAGE_NAMESPACE=testnet npm --prefix basic-pubky-app run build -- --base ./ --outDir dist/testnet \
    && npm --prefix vite-starter run build -- --base ./ \
    && mkdir -p dist/mainnet/basic-pubky-app dist/testnet/basic-pubky-app dist/vite-starter \
    && cp -R pages/. dist/ \
    && cp -R basic-pubky-app/dist/mainnet/. dist/mainnet/basic-pubky-app/ \
    && cp -R basic-pubky-app/dist/testnet/. dist/testnet/basic-pubky-app/ \
    && cp -R vite-starter/dist/. dist/vite-starter/

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "server.js"]
