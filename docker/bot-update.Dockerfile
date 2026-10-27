# Small-disk update path: reuse an existing bot runtime with the SAME dependency lock.
# Build dist with VITE_DATA_FROM= first. A full build is required for dependency changes.
# npm prune can remove unreachable/dev entries; verify the reachable runtime graph.
ARG BASE_IMAGE=new-radio-ko-kr-bot:local
FROM ${BASE_IMAGE}
WORKDIR /app
RUN node -e "require('node:fs').copyFileSync('package-lock.json', '/tmp/bot-base-lock.json')"
COPY app/bot/verifyRuntimeLock.mjs /tmp/verifyRuntimeLock.mjs
COPY package*.json ./
RUN node /tmp/verifyRuntimeLock.mjs /tmp/bot-base-lock.json package-lock.json \
    && rm /tmp/bot-base-lock.json /tmp/verifyRuntimeLock.mjs
RUN rm -rf app src dist
COPY app ./app
COPY src ./src
COPY dist ./dist
ENV VITE_DATA_FROM=""
CMD ["npm", "run", "bot"]
