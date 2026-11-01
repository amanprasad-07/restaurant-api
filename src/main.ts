import "dotenv/config";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { NestExpressApplication } from "@nestjs/platform-express";

async function bootstrap() {
  for (const key of [
    "DATABASE_URL",
    "JWT_STAFF_SECRET",
    "JWT_TABLE_SESSION_SECRET",
  ]) {
    if (!process.env[key])
      throw new Error(
        `Missing required env var ${key} (copy .env.example to .env)`,
      );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set("trust proxy", 1);
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: (process.env.FRONTEND_URL ?? "http://localhost:3000").split(","),
    credentials: true,
  });
  // whitelist strips unknown fields, so a guest sending {"price": 1} or {"table_id": ...} is simply ignored
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const docs = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Restaurant QR Ordering API")
      .setDescription(
        "Scan -> menu -> order -> live KDS. Realtime events are documented in the README.",
      )
      .setVersion("0.1")
      .addBearerAuth({ type: "http", scheme: "bearer" }, "table")
      .addBearerAuth({ type: "http", scheme: "bearer" }, "staff")
      .build(),
  );
  SwaggerModule.setup("docs", app, docs);

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  Logger.log(
    `API on http://localhost:${port}/api/v1  |  Swagger on http://localhost:${port}/docs`,
    "Bootstrap",
  );
}
bootstrap();
