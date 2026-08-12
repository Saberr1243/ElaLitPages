FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    make \
    g++ \
    xvfb \
    openbox \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    xmessage \
    xterm \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000 6080
CMD ["npm", "start"]
