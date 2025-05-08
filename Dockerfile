FROM mcr.microsoft.com/playwright:v1.43.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=8080
ENV OUTPUT_DIR=/tmp

EXPOSE 8080

CMD ["npm", "start"]