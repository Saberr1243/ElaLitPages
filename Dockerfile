FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    make \
    g++ \
    procps \
    xvfb \
    openbox \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    x11-utils \
    lsof \
    xterm \
    endless-sky \
    openjdk-17-jre-headless \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000 6080
CMD ["npm", "start"]
