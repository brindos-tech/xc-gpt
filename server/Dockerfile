FROM node:22-slim
WORKDIR /app
COPY *.js *.html *.css ./
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
