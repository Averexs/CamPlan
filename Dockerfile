FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV PLANS_DIR=/data/plans
VOLUME /data/plans
EXPOSE 3000
CMD ["node", "server.js"]
