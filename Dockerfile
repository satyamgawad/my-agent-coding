# syntax=docker/dockerfile:1

# The UI is a Node service. Keep the image small and run it as an unprivileged
# user so generated-project activity cannot run as root in the container.
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    AGENT_UI_HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && apk add --no-cache su-exec

RUN addgroup -S codingagent \
    && adduser -S -G codingagent codingagent

COPY . .
RUN mkdir -p /app/projects \
    && chown -R root:root /app \
    && chown -R codingagent:codingagent /app/projects

COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod 755 /usr/local/bin/docker-entrypoint

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["npm", "run", "ui"]
