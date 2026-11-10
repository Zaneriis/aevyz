FROM node:24-slim
WORKDIR /app
COPY server.js index.html ./
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data
USER node
CMD ["node", "server.js"]
