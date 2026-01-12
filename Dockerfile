FROM node:25
RUN apt-get update && apt-get install -y \
    wget \
    --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY . .
RUN npm install
CMD ["node", "index.js"]
