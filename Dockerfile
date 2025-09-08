FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","index.js"]
