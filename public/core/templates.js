export const TEMPLATES = {
  'Node.js (멀티 스테이지)': `# syntax=docker/dockerfile:1
ARG NODE_VERSION=22-alpine

# 의존성 설치와 빌드
FROM node:\${NODE_VERSION} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 실행 이미지
FROM node:\${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
`,
  'Go (정적 바이너리)': `ARG GO_VERSION=1.23

FROM golang:\${GO_VERSION}-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app"]
`,
  Python: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 10001 appuser
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=appuser:appuser . .
USER appuser
EXPOSE 8000
CMD ["python", "main.py"]
`,
  'Java (Maven)': `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/*.jar ./
RUN useradd --system --uid 10001 spring
USER spring
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
`,
  '빈 파일': `FROM alpine:3.20
`,
};
