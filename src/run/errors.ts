import type { FailureCode } from "../state.js";

export class RunFailureError extends Error {
  readonly failureCode: FailureCode;

  constructor(failureCode: FailureCode, message: string) {
    super(message);
    this.name = "RunFailureError";
    this.failureCode = failureCode;
  }
}
