export class AppError extends Error {
  readonly status: number;
  override readonly name: string;

  constructor(status: number, name: string, message: string) {
    super(message);
    this.status = status;
    this.name = name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(422, "validation_error", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "The API key is invalid or missing.") {
    super(401, "validation_error", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "The API key does not have the required scope.") {
    super(403, "restricted_api_key", message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, "not_found", `${resource} was not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "conflict", message);
  }
}

export class PreconditionFailedError extends AppError {
  constructor(message: string) {
    super(412, "precondition_failed", message);
  }
}

export class InvalidStateError extends AppError {
  constructor(message: string) {
    super(409, "invalid_state", message);
  }
}
