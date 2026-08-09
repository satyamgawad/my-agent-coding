#!/bin/sh
set -eu

# Railway mounts persistent volumes as root-owned. Fix only the mount root,
# then drop privileges before Node and generated project code run.
mkdir -p /app/projects
chown codingagent:codingagent /app/projects

exec su-exec codingagent "$@"
