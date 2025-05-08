FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=8080
ENV OUTPUT_DIR=/tmp

EXPOSE 8080

CMD ["npm", "start"]
