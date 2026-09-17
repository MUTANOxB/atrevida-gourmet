import "fastify";
import "@fastify/cookie";

declare module "fastify" {
  interface FastifyContextConfig {
    allowMultipart?: boolean;
  }

  interface FastifyRequest {
    admin?: {
      userId: string;
      email: string | null;
      storeId: string;
      role: "owner" | "manager" | "staff";
      authSource: "cookie" | "bearer";
    };
  }
}
