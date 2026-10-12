FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    SMS_MODE=demo \
    DATABASE_PATH=/var/data/suite.sqlite \
    UPLOAD_DIR=/var/data/uploads \
    NUDGE_INTERVAL_MS=60000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts/check-twilio.js ./scripts/check-twilio.js

# The database and logos belong on a persistent volume, outside the image.
RUN mkdir -p /var/data/uploads && chown -R node:node /var/data
USER node

EXPOSE 10000
CMD ["node", "src/server.js"]
