# syntax=docker/dockerfile:1

# The UI is a Node service. Keep the image small and run it as an unprivileged
# user so generated-project activity cannot run as root in the container.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    AGENT_UI_HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

RUN addgroup -S codingagent \
    && adduser -S -G codingagent codingagent

COPY --chown=codingagent:codingagent . .
RUN mkdir -p /app/projects \
    && chown -R codingagent:codingagent /app

USER codingagent

EXPOSE 3000

CMD ["npm", "run", "ui"]
