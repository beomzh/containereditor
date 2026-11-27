# Runs the editor and CLI without installing Node.js or npm.
#   docker build -t containereditor https://github.com/beomzh/containereditor.git#main
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION}
# Client only: builds run on the engine whose socket you mount.
RUN apk add --no-cache docker-cli docker-cli-buildx
WORKDIR /app
COPY package.json package-lock.json LICENSE NOTICE ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY server ./server
COPY public ./public
# CONTAINEREDITOR_CONTAINER makes the server listen inside the container; publish it on 127.0.0.1 only.
# HOME must be writable for any --user, because the Docker client keeps state there.
ENV CONTAINEREDITOR_CONTAINER=1 HOME=/tmp
WORKDIR /work
USER node
EXPOSE 4173
ENTRYPOINT ["node", "/app/bin/containereditor.js"]
CMD ["serve"]
