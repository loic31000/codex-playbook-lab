export class ReviewNotFoundError extends Error {
  override readonly name = "ReviewNotFoundError";
}

export class ReviewConflictError extends Error {
  override readonly name = "ReviewConflictError";
}

export class ReviewIntegrityError extends Error {
  override readonly name = "ReviewIntegrityError";
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
  }
}

export class PromotionConflictError extends Error {
  override readonly name = "PromotionConflictError";
}

export class PromotionIntegrityError extends Error {
  override readonly name = "PromotionIntegrityError";
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
  }
}
