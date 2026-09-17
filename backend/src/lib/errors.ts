export class HttpError extends Error {
  readonly expose = true;

  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}
