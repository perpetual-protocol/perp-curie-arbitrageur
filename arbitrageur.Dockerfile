#
# Builder stage
#
FROM node:16 AS builder

# Use non-root user to avoid unexpected npm behaviors.
RUN groupadd -r perp && useradd --no-log-init --create-home -r -g perp perp
USER perp

# Copy npm install dependencies so we can cache the results independently.
WORKDIR /home/perp
COPY --chown=perp:perp ./src ./src
COPY --chown=perp:perp ./package*.json .
COPY --chown=perp:perp ./tsconfig.json .
RUN npm ci --quiet
RUN npm run build

#
# Production stage
#
FROM node:16-alpine

# Use non-root user to avoid unexpected npm behaviors.
RUN addgroup perp && adduser -G perp -S -s /bin/sh -D perp perp
USER perp

WORKDIR /home/perp
COPY --chown=perp:perp --from=builder /home/perp/node_modules ./node_modules
COPY --chown=perp:perp --from=builder /home/perp/build ./build
ENTRYPOINT ["node", "build/index.js"]
