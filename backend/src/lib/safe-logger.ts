export function redactRequestUrl(value: unknown) {
  return String(value ?? "").replace(
    /(\/api\/public\/orders\/)[0-9a-f-]{36}(?=\/|\?|$)/gi,
    "$1[REDACTED]"
  );
}

export const loggerOptions = {
  level: process.env.NODE_ENV === "test"
    ? "silent"
    : process.env.NODE_ENV === "production"
      ? "info"
      : "debug",

  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['idempotency-key']",
      "req.headers['x-api-key']",
      "req.body.password",
      "req.body.email",
      "req.body.token",
      "req.body.access_token",
      "req.body.refresh_token",
      "req.body.customer.phone",
      "req.body.customer.name",
      "req.body.delivery",
      "res.headers['set-cookie']"
    ],
    censor: "[REDACTED]"
  },

  serializers: {
    req(request: any) {
      return {
        method: request.method,
        url: redactRequestUrl(request.url),
        remoteAddress: request.ip
      };
    },

    res(reply: any) {
      return {
        statusCode: reply.statusCode
      };
    }
  }
};
